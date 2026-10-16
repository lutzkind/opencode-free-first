#!/usr/bin/env node
/**
 * Deterministic OpenAI-compatible mock provider for the opencode-free-first
 * integration tests.
 *
 * It never calls a real provider, so exhaustively exercising rate-limit
 * failover cannot consume anyone's free quota. Behaviour is switched per role
 * (`free` / `paid`) so one server can serve both sides of a failover:
 *
 *   POST /__control { free: {...}, paid: {...}, log: [] }
 *   POST /__reset
 *   GET  /__state
 *
 * Roles are inferred from the requested model id (`…free` is the free role).
 */
import http from "node:http";

const port = Number(process.env.FF_MOCK_PORT ?? 8899);

function defaults() {
  return {
    mode: "ok", // ok | 429 | 500 | 401 | 400
    /**
     * Serve the error `mode` for the first N requests of this role and succeed
     * afterwards. `null` (the default) keeps failing for the rest of the
     * scenario. A finite value models a free tier that rate limits and then
     * recovers, which is the state machine's whole reason to exist.
     */
    failFirst: null,
    body: undefined,
    retryAfterSeconds: undefined,
    delayMs: 0,
    /**
     * Refuse the out-of-band recovery probe, identified by its configured
     * prompt marker. OpenCode's own free tier does this
     * (`Generate.UnavailableError`), so this models a host that refuses the
     * probe path while serving the agent loop normally.
     */
    gateProbe: false,
  };
}

const served = { free: 0, paid: 0 };

const state = {
  free: defaults(),
  paid: defaults(),
  log: [],
  /** The probe prompt the harness configures, so the gate is unambiguous. */
  probeMarker: process.env.FF_MOCK_PROBE_MARKER ?? "FF_PROBE_PROBE_ONLY",
};

function roleOf(body) {
  try {
    const parsed = JSON.parse(body ?? "{}");
    return String(parsed.model ?? "").includes("free") ? "free" : "paid";
  } catch {
    return "paid";
  }
}

function sendJson(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  response.end(body);
}

function chunk(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function stream(response, model) {
  const created = Math.floor(Date.now() / 1000);
  // A client that disconnects mid-stream must not take the mock down: the
  // integration run exits as soon as it has the answer.
  response.on("error", () => {});
  response.socket?.on("error", () => {});
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const base = { id: `chatcmpl-${Date.now()}`, object: "chat.completion.chunk", created, model };
  const frames = [
    { ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: { content: "MOCK_OK " }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: { content: `model=${model}` }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
  let index = 0;
  const pump = () => {
    if (response.writableEnded || response.destroyed) return;
    if (index >= frames.length) {
      try {
        response.write("data: [DONE]\n\n");
        response.end();
      } catch {
        /* client gone */
      }
      return;
    }
    try {
      response.write(chunk(frames[index++]));
    } catch {
      return;
    }
    setTimeout(pump, 1);
  };
  pump();
}

const server = http.createServer(async (request, response) => {
  request.on("error", () => {});
  response.on("error", () => {});
  response.socket?.on("error", () => {});
  const chunks = [];
  for await (const piece of request) chunks.push(piece);
  const raw = Buffer.concat(chunks).toString("utf8");

  if (request.url?.startsWith("/__control")) {
    const patch = JSON.parse(raw || "{}");
    if (Array.isArray(patch.log)) state.log = patch.log;
    for (const role of ["free", "paid"]) {
      if (patch[role]) state[role] = { ...state[role], ...patch[role] };
      if (patch.resetCounters === true) served[role] = 0;
    }
    sendJson(response, 200, { ok: true, free: state.free, paid: state.paid });
    return;
  }
  if (request.url?.startsWith("/__state")) {
    sendJson(response, 200, state);
    return;
  }
  if (request.url?.startsWith("/__reset")) {
    state.log = [];
    served.free = 0;
    served.paid = 0;
    sendJson(response, 200, { ok: true });
    return;
  }

  let parsed = {};
  try {
    parsed = JSON.parse(raw || "{}");
  } catch {
    parsed = {};
  }
  const role = roleOf(raw);
  const config = state[role];
  served[role] += 1;
  const limit = config.failFirst ?? Number.POSITIVE_INFINITY;
  const failing = config.mode !== "ok" && served[role] <= limit;
  const effective = failing ? config.mode : "ok";
  const model = String(parsed.model ?? "");
  state.log.push({
    event: "request",
    model,
    role,
    stream: parsed.stream === true,
    messages: Array.isArray(parsed.messages) ? parsed.messages.length : undefined,
    tools: Array.isArray(parsed.tools) ? parsed.tools.length : undefined,
  });

  if (config.delayMs) await new Promise((resolve) => setTimeout(resolve, config.delayMs));

  if (config.gateProbe === true && raw.includes(state.probeMarker)) {
    state.log.push({ event: "probe-refused", model, role });
    sendJson(response, 503, {
      error: {
        message:
          "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building.",
        type: "server_error",
        code: "unavailable",
      },
    });
    return;
  }

  if (effective !== "ok") {
    const status = { 429: 429, 500: 500, 401: 401, 400: 400 }[effective] ?? 500;
    const message =
      config.body ??
      (status === 429 ? "Rate limit exceeded. Please try again later." : `mock error ${status}`);
    const headers =
      config.retryAfterSeconds === undefined
        ? {}
        : { "retry-after": String(config.retryAfterSeconds) };
    state.log.push({ event: "error-response", model, status, message });
    sendJson(
      response,
      status,
      {
        error: {
          message,
          type: status === 429 ? "rate_limit_error" : "mock_error",
          code: status === 429 ? "rate_limit_exceeded" : "mock_error",
        },
      },
      headers,
    );
    return;
  }

  if (parsed.stream === true) {
    stream(response, model);
    return;
  }
  sendJson(response, 200, {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: `MOCK_OK model=${model}` },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
});

server.on("clientError", (_error, socket) => {
  socket.destroy();
});

// Keep control-plane connections alive across scenarios: the tests space their
// calls further apart than Node's default keep-alive timeout, and a pooled
// socket closed by the server surfaces as a spurious fetch failure.
server.keepAliveTimeout = 0;
server.headersTimeout = 0;

server.listen(port, "127.0.0.1", () => {
  console.log(`mock provider listening on http://127.0.0.1:${port}`);
});
