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
    mode: "ok", // ok | 429 | 500 | 401 | 400 | free-tier-gate
    /**
     * Serve the error `mode` for the first N requests of this role and succeed
     * afterwards. `null` (the default) keeps failing for the rest of the
     * scenario. A finite value models a free tier that rate limits — or that
     * temporarily refuses the route — and then recovers, which is the state
     * machine's whole reason to exist.
     */
    failFirst: null,
    body: undefined,
    retryAfterSeconds: undefined,
    delayMs: 0,
    /**
     * Apply the error `mode` (and count the request against `failFirst`) only
     * for requests that carry tools, which is how the agent loop is identified.
     * OpenCode's title request runs without tools and its failures are swallowed
     * by OpenCode itself before any plugin retry hook, so a gate scenario that
     * must reach the retry hook targets the agent loop explicitly.
     */
    onlyWithTools: false,
    /**
     * Apply the error `mode` only to requests *without* tools. This is the live
     * OpenCode free-tier behaviour from anomalyco/opencode#58176: the normal
     * tool-bearing agent request is served, while the tool-less automatic title
     * request is refused with `403 FreeTierError`.
     */
    toolLessOnly: false,
    /**
     * Keep the title compatibility shim's replacement request out of request
     * counters, error modes, and the `request` log. Legacy failover cases use
     * this so a scenario's deliberate free-route failure is discovered by the
     * agent-loop request, exactly as before the shim existed. Title cases set
     * it to false to observe the replacement request directly.
     */
    ignoreTitleReplacement: false,
    /**
     * Prompt tokens reported on this role's responses. OpenCode treats the last
     * response's usage as the measured prompt size, so a large value is how a
     * scenario makes an automatic compaction due without generating a huge
     * transcript: the window is 200k and this reports it as nearly full.
     */
    promptTokens: 10,
    /**
     * Refuse the out-of-band recovery probe, identified by its configured
     * prompt marker. OpenCode's own free tier does this
     * (`Generate.UnavailableError`), so this models a host that refuses the
     * probe path while serving the agent loop normally.
     */
    gateProbe: false,
  };
}

/** OpenCode's own free-tier eligibility refusal, exactly as observed live. */
const FREE_TIER_GATE_MESSAGE =
  "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building.";

const served = { free: 0, paid: 0 };

const state = {
  free: defaults(),
  paid: defaults(),
  /** Fail every title-shim replacement request, on any route, with 403. */
  failTitleReplacement: false,
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

/**
 * A compaction reply has to fill OpenCode's summary template, or the compaction
 * counts as failed. This is the smallest valid summary.
 */
const COMPACTION_SUMMARY = [
  "## Objective",
  "- Continue the task.",
  "",
  "## Requirements",
  "- (none)",
  "",
  "## Decisions",
  "- (none)",
  "",
  "## Work State",
  "### Completed",
  "- (none)",
  "",
  "### Active",
  "- (none)",
  "",
  "### Blocked",
  "- (none)",
  "",
  "## Next Move",
  "1. (none)",
  "",
  "## Relevant Files",
  "- (none)",
  "",
  "## Important Context",
  "- mock summary",
].join("\n");

/** True when the request is OpenCode's compaction summary prompt. */
function isCompaction(raw) {
  return raw.includes("Summarize only what the user and the assistant said and did");
}

function stream(response, model, options = {}) {
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
  const text =
    options.compaction === true
      ? COMPACTION_SUMMARY
      : options.titleReplacement === true
        ? "Deploy pipeline repair"
        : `MOCK_OK model=${model}`;
  const halves = [
    text.slice(0, Math.ceil(text.length / 2)),
    text.slice(Math.ceil(text.length / 2)),
  ];
  const frames = [
    { ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: { content: halves[0] }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: { content: halves[1] }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    // The trailing usage chunk OpenCode asks for with stream_options.include_usage.
    {
      ...base,
      choices: [],
      usage: {
        prompt_tokens: Number(options.promptTokens ?? 10),
        completion_tokens: 8,
        total_tokens: Number(options.promptTokens ?? 10) + 8,
      },
    },
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
    if (typeof patch.failTitleReplacement === "boolean")
      state.failTitleReplacement = patch.failTitleReplacement;
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
  const tooled = Array.isArray(parsed.tools) && parsed.tools.length > 0;
  const model = String(parsed.model ?? "");
  const compaction = isCompaction(raw);
  // The title compatibility shim's own instruction, so a test can tell its
  // tool-bearing replacement request apart from OpenCode's native title request.
  const titleReplacement = raw.includes("Write a concise title");
  const ignored = config.ignoreTitleReplacement === true && titleReplacement;
  const eligible =
    !ignored &&
    (config.onlyWithTools !== true || tooled) &&
    (config.toolLessOnly !== true || !tooled);
  if (eligible) served[role] += 1;
  const limit = config.failFirst ?? Number.POSITIVE_INFINITY;
  const failing = config.mode !== "ok" && eligible && served[role] <= limit;
  const effective = failing ? config.mode : "ok";
  if (ignored) {
    state.log.push({
      event: "title-replacement",
      model,
      role,
      tools: Array.isArray(parsed.tools) ? parsed.tools.length : undefined,
    });
  } else {
    state.log.push({
      event: "request",
      model,
      role,
      compaction,
      ...(titleReplacement ? { titleReplacement: true } : {}),
      stream: parsed.stream === true,
      messages: Array.isArray(parsed.messages) ? parsed.messages.length : undefined,
      tools: Array.isArray(parsed.tools) ? parsed.tools.length : undefined,
    });
  }

  if (state.failTitleReplacement === true && titleReplacement) {
    state.log.push({
      event: "error-response",
      model,
      status: 403,
      message: "mock title generation failure",
      compaction,
      titleReplacement: true,
    });
    sendJson(response, 403, {
      error: {
        message: "mock title generation failure",
        type: "mock_error",
        code: "mock_error",
      },
    });
    return;
  }

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
    const status =
      { 429: 429, 500: 500, 401: 401, 400: 400, "free-tier-gate": 403 }[effective] ?? 500;
    const gated = effective === "free-tier-gate";
    const message = gated
      ? FREE_TIER_GATE_MESSAGE
      : (config.body ??
        (status === 429 ? "Rate limit exceeded. Please try again later." : `mock error ${status}`));
    const headers =
      config.retryAfterSeconds === undefined
        ? {}
        : { "retry-after": String(config.retryAfterSeconds) };
    state.log.push({
      event: "error-response",
      model,
      status,
      message,
      compaction,
      ...(gated ? { gate: true } : {}),
    });
    sendJson(
      response,
      status,
      {
        error: {
          message,
          type: gated ? "free_tier_error" : status === 429 ? "rate_limit_error" : "mock_error",
          code: gated ? "free_tier_error" : status === 429 ? "rate_limit_exceeded" : "mock_error",
        },
      },
      headers,
    );
    return;
  }

  if (parsed.stream === true) {
    stream(response, model, {
      compaction,
      titleReplacement,
      promptTokens: config.promptTokens,
    });
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
        message: {
          role: "assistant",
          content: compaction
            ? COMPACTION_SUMMARY
            : titleReplacement
              ? "Deploy pipeline repair"
              : `MOCK_OK model=${model}`,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: Number(config.promptTokens ?? 10),
      completion_tokens: 5,
      total_tokens: Number(config.promptTokens ?? 10) + 5,
    },
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
