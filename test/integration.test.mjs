/**
 * Live coexistence tests for opencode-free-first.
 *
 * These run the real OpenCode CLI with the real opencode-offpeak plugin and a
 * deterministic mock provider, in a private XDG home so nothing touches the
 * user's configuration, sessions, credentials, or free-tier quota. Enable with:
 *
 *   FF_INTEGRATION=1 npm run test:integration
 *
 * They are skipped by default so `npm test` stays hermetic and fast.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ENABLED = process.env.FF_INTEGRATION === "1";
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const OFFPEAK_SPEC =
  process.env.FF_OFFPEAK_SPEC ?? "git+https://github.com/lutzkind/opencode-offpeak.git#v0.2.0";

function opencodeBinary() {
  if (process.env.FF_OPENCODE) return process.env.FF_OPENCODE;
  for (const candidate of [path.join(os.homedir(), ".opencode", "bin", "opencode")]) {
    if (existsSync(candidate)) return candidate;
  }
  const found = spawnSync("which", ["opencode"], { encoding: "utf8" });
  return found.stdout.trim() || "opencode";
}

async function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

describe("live coexistence with opencode-offpeak", { skip: !ENABLED }, () => {
  let home;
  let mock;
  let port;
  const opencode = opencodeBinary();

  before(async () => {
    port = await freePort();
    home = path.join(os.tmpdir(), `ff-integration-${Date.now()}`);
    mkdirSync(path.join(home, "config", "opencode"), { recursive: true });
    mkdirSync(path.join(home, "data"), { recursive: true });
    mkdirSync(path.join(home, "cache"), { recursive: true });
    mkdirSync(path.join(home, "project", ".opencode"), { recursive: true });

    mock = spawn(process.execPath, [path.join(here, "support", "mock-provider.mjs")], {
      env: { ...process.env, FF_MOCK_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("mock provider did not start")), 10_000);
      mock.stdout.on("data", (chunk) => {
        if (String(chunk).includes("listening")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    writeConfig(coexistencePlugins);
  });

  /** The whole OpenCode configuration, so a case can swap the plugin list. */
  function writeConfig(plugins, extra = {}) {
    writeJson(path.join(home, "config", "opencode", "opencode.json"), {
      $schema: "https://opencode.ai/config.json",
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
      websearch: false,
      model: "ffmock/ff-free",
      ...extra,
      plugins,
      providers: {
        ffmock: {
          name: "FF Mock",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "ffmock-key" },
          models: {
            "ff-free": { name: "FF Free", limit: { context: 200_000, output: 8_192 } },
            "ff-paid": { name: "FF Paid", limit: { context: 200_000, output: 8_192 } },
          },
        },
      },
    });
  }

  /** The layout every coexistence case runs against. */
  const freeFirstOptions = {
    primary: { providerID: "ffmock", id: "ff-free" },
    fallback: { providerID: "ffmock", id: "ff-paid" },
    preferAsDefault: true,
    adoptFallbackSessions: true,
    backoffMs: [2_000, 4_000, 8_000],
    maxCooldownMs: 8_000,
    jitterRatio: 0,
    failoverRetryDelayMs: 50,
    parkGraceMs: 1_200,
    // A free-route rejection is retried conservatively; short here so the case
    // can observe the recovery without waiting minutes.
    routeRejectRetryMs: 1_500,
    // A distinctive probe prompt lets the mock gate exactly the probe.
    probePrompt: "FF_PROBE_PROBE_ONLY",
    logLevel: "debug",
  };
  const coexistencePlugins = [OFFPEAK_SPEC, { package: repo, options: freeFirstOptions }];

  function offpeakConfig(policy) {
    writeJson(path.join(home, "config", "opencode", "offpeak.json"), {
      schemaVersion: 1,
      enabled: true,
      mode: "auto",
      displayTimeZone: "UTC",
      ...(policy === undefined ? {} : { policies: [policy] }),
    });
  }

  after(() => {
    if (mock) mock.kill("SIGKILL");
    if (home && process.env.FF_KEEP_HOME !== "1") rmSync(home, { recursive: true, force: true });
  });

  /**
   * Apply mock behaviour. Every role is reset to a known baseline first, and
   * request counters always restart, so no scenario can leak into the next.
   */
  async function control(patch) {
    const baseline = {
      mode: "ok",
      failFirst: null,
      body: undefined,
      retryAfterSeconds: undefined,
      delayMs: 0,
      gateProbe: false,
      onlyWithTools: false,
      toolLessOnly: false,
      // The title shim is not the subject of the routing cases: keep its
      // replacement request out of their counters and error modes.
      ignoreTitleReplacement: true,
    };
    await fetch(`http://127.0.0.1:${port}/__control`, {
      method: "POST",
      headers: { "content-type": "application/json", connection: "close" },
      body: JSON.stringify({
        log: patch.log ?? [],
        resetCounters: true,
        failTitleReplacement: patch.failTitleReplacement ?? false,
        free: { ...baseline, ...(patch.free ?? {}) },
        paid: { ...baseline, ...(patch.paid ?? {}) },
      }),
    });
  }

  async function mockState() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/__state`, {
          headers: { connection: "close" },
        });
        return await response.json();
      } catch (error) {
        if (attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error("unreachable");
  }

  function reset() {
    rmSync(path.join(home, "data", "opencode"), { recursive: true, force: true });
  }

  async function run(prompt, extra = []) {
    const result = spawnSync(
      opencode,
      ["run", "--standalone", "--log-level", "info", "--print-logs", ...extra, prompt],
      {
        cwd: path.join(home, "project"),
        env: {
          ...process.env,
          XDG_CONFIG_HOME: path.join(home, "config"),
          XDG_DATA_HOME: path.join(home, "data"),
          XDG_CACHE_HOME: path.join(home, "cache"),
        },
        encoding: "utf8",
        timeout: 90_000,
      },
    );
    return { status: result.status, stdout: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  }

  /**
   * The persisted transcript of the newest session in the project, straight
   * from OpenCode's own database. Used to prove what the run actually did
   * (messages, model switches, tool calls) instead of inferring it from logs.
   */
  function transcript() {
    const db = new DatabaseSync(path.join(home, "data", "opencode", "opencode.db"), {
      readOnly: true,
    });
    try {
      // The harness starts from an empty data directory, so every session in
      // this database belongs to the case under test.
      const sessions = db
        .prepare(
          "select id, directory, model, idle_outcome, time_created from session_v2 order by time_created",
        )
        .all();
      const session = sessions.at(-1);
      if (session === undefined) return { sessions: [], messages: [], parts: [], model: undefined };
      const messages = db
        .prepare("select type, data from session_message where session_id = ? order by seq")
        .all(session.id)
        .map((row) => ({ type: row.type, data: JSON.parse(row.data ?? "{}") }));
      // Content parts live inside the assistant messages' `content` array in this
      // schema (the separate `part` table belongs to the older v1 store).
      const parts = messages
        .filter((message) => message.type === "assistant")
        .flatMap((message) => message.data.content ?? []);
      return {
        session,
        sessions,
        messages,
        parts,
        model: JSON.parse(session.model ?? "{}"),
      };
    } finally {
      db.close();
    }
  }

  /** Every model the provider was asked for, in order. */
  function models(state) {
    return state.log.filter((entry) => entry.event === "request").map((entry) => entry.model);
  }

  /** Provider requests this mock identified as OpenCode's compaction summary. */
  function compactionRequests(state, role) {
    return state.log.filter(
      (entry) => entry.event === "request" && entry.compaction === true && entry.role === role,
    );
  }

  /** The session's compaction messages, as OpenCode persisted them. */
  function compactions(record) {
    return record.messages.filter((message) => message.type === "compaction");
  }

  /**
   * A policy that never holds anything, so a case can assert where a request
   * went without another plugin delaying it.
   */
  function flatPolicy() {
    return {
      id: "ffmock-flat",
      providers: ["ffmock"],
      models: ["ff-paid"],
      flatModels: ["ff-free"],
      timeZone: "UTC",
      // A policy must define at least one window. This one covers the first
      // minute of the UTC day only, so the paid route is effectively never held
      // and the case can assert where a request went.
      blocked: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:01" }],
      multiplier: 2,
      source: "integration test",
    };
  }

  /**
   * The known-cooldown setup every compaction case starts from.
   *
   * Turn 1 is a normal turn whose title request discovers the free-tier limit:
   * free-first fails the session over, and the cooldown it records is long
   * enough to stay valid for the rest of the case. Both roles report a nearly
   * full window, so the *next* turn's step boundary is where OpenCode issues an
   * automatic compaction — the boundary that resolves its model before any
   * plugin hook runs.
   */
  async function knownCooldownTurn({ retryAfterSeconds = 120, freeMode = "429" } = {}) {
    await control({
      log: [],
      free: {
        mode: freeMode,
        ...(freeMode === "ok" ? {} : { retryAfterSeconds }),
        promptTokens: 190_000,
      },
      paid: { mode: "ok", promptTokens: 190_000 },
    });
    const first = await run("Reply with the word READY");
    const state = await mockState();
    const record = transcript();
    const sessionID = record.session?.id;
    assert.ok(sessionID, `turn 1 did not persist a session:\n${first.stdout.slice(-2_000)}`);
    assertOk(first);
    return { first, state, record, sessionID };
  }

  it("Case 1 — a healthy free model is used and offpeak stays out of the way", async () => {
    offpeakConfig(undefined);
    reset();
    await control({
      log: [],
      free: { mode: "ok" },
      paid: { mode: "ok" },
    });
    const result = await run("Reply with the word READY");
    assertOk(result);
    const state = await mockState();
    assert.deepEqual(models(state), ["ff-free"], "only the free model served the turn");
    assert.match(result.stdout, /MOCK_OK model=ff-free/);
    assert.doesNotMatch(result.stdout, /fallback selected/);
    assert.doesNotMatch(result.stdout, /free rate limit detected/);
  });

  function writePeakOnlyConfig(extra = {}) {
    writeConfig([
      OFFPEAK_SPEC,
      { package: repo, options: { ...freeFirstOptions, freeUsageMode: "peak-only", ...extra } },
    ]);
  }

  /** The paid route is peak-priced for the whole test window; free stays flat. */
  function peakPolicy() {
    return {
      id: "ffmock-paid-peak",
      providers: ["ffmock"],
      models: ["ff-paid"],
      flatModels: ["ff-free"],
      timeZone: "UTC",
      blocked: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" }],
      multiplier: 2,
      source: "integration test",
    };
  }

  it("Case 17 — peak-only OFF_PEAK selects Go and makes zero free requests", async () => {
    writePeakOnlyConfig();
    offpeakConfig(flatPolicy());
    reset();
    await control({ log: [], free: { mode: "ok" }, paid: { mode: "ok" } });

    const result = await run("Reply with the word READY");
    assertOk(result);
    assert.match(result.stdout, /MOCK_OK model=ff-paid/);

    const state = await mockState();
    assert.equal(
      state.log.filter((entry) => entry.event === "request" && entry.role === "free").length,
      0,
      "OFF_PEAK made no free-model request",
    );
    assert.ok(
      state.log.filter((entry) => entry.event === "request" && entry.role === "paid").length >= 1,
      "the paid route served the turn",
    );
    assert.doesNotMatch(result.stdout, /recovery probe started/);
    assert.match(result.stdout, /Pricing: OFF_PEAK|Active route: GO/);
    writeConfig(coexistencePlugins);
  });

  it("Case 18 — peak-only PEAK uses healthy Free and offpeak does not block it", async () => {
    writePeakOnlyConfig();
    offpeakConfig(peakPolicy());
    reset();
    await control({ log: [], free: { mode: "ok" }, paid: { mode: "ok" } });

    const result = await run("Reply with the word READY");
    assertOk(result);
    assert.match(result.stdout, /MOCK_OK model=ff-free/);

    const state = await mockState();
    assert.ok(
      state.log.filter((entry) => entry.event === "request" && entry.role === "free").length >= 1,
      "the free route served the turn",
    );
    assert.equal(
      state.log.filter((entry) => entry.event === "request" && entry.role === "paid").length,
      0,
      "offpeak did not divert or block the free route",
    );
    assert.match(result.stdout, /Pricing: PEAK|Active route: FREE/);
    writeConfig(coexistencePlugins);
  });

  it("Case 19 — peak-only PEAK failover to Go keeps offpeak's cost protection", async () => {
    writePeakOnlyConfig();
    offpeakConfig(peakPolicy());
    reset();
    await control({
      log: [],
      free: { mode: "429", retryAfterSeconds: 1, failFirst: 3 },
      paid: { mode: "ok" },
    });

    const result = await run("Reply with the word READY");
    assertOk(result);
    assert.match(result.stdout, /MOCK_OK model=ff-free/);
    assert.match(result.stdout, /fallback selected/);
    assert.match(result.stdout, /parked fallback request detected/);
    assert.match(result.stdout, /stale fallback continuation neutralized/);
    const state = await mockState();
    assert.equal(
      state.log.filter((entry) => entry.event === "request" && entry.role === "paid").length,
      0,
      "no paid request was spent during PEAK",
    );
    writeConfig(coexistencePlugins);
    offpeakConfig(undefined);
  });

  it("Case 21 — peak-only PEAK→OFF_PEAK releases a waiting Go request at the boundary", async () => {
    writePeakOnlyConfig();
    const now = new Date();
    const start = new Date(now.getTime() - 60_000);
    const end = new Date(now.getTime() + 60_000);
    const boundary = new Date(end);
    boundary.setUTCSeconds(0, 0);
    const hhmm = (date) =>
      `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
    offpeakConfig({
      id: "ffmock-paid-peak",
      providers: ["ffmock"],
      models: ["ff-paid"],
      flatModels: ["ff-free"],
      timeZone: "UTC",
      blocked: [{ days: [0, 1, 2, 3, 4, 5, 6], start: hhmm(start), end: hhmm(end) }],
      multiplier: 2,
      source: "integration test",
    });
    reset();
    await control({
      log: [],
      free: { mode: "429", retryAfterSeconds: 300, failFirst: 100 },
      paid: { mode: "ok" },
    });

    const project = path.join(home, "project");
    const outcome = await withServer(async ({ call }) => {
      const created = await call("POST", "/api/session", {
        title: "boundary",
        model: { providerID: "ffmock", id: "ff-free" },
        location: { directory: project },
      });
      const sessionID = created?.data?.id ?? created?.id;
      assert.ok(sessionID, `no session id: ${JSON.stringify(created)}`);
      await call("POST", `/api/session/${sessionID}/prompt`, {
        text: "Reply with the word READY",
      });

      let beforeBoundary = 0;
      let messages = [];
      for (let attempt = 0; attempt < 150; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const state = await mockState();
        if (Date.now() < boundary.getTime()) {
          beforeBoundary = Math.max(
            beforeBoundary,
            state.log.filter((entry) => entry.event === "request" && entry.role === "paid").length,
          );
        }
        const context = await call("GET", `/api/session/${sessionID}/context`);
        messages = context?.data ?? [];
        if (
          messages.some((message) =>
            (message.content ?? []).some((part) =>
              String(part.text ?? "").includes("MOCK_OK model=ff-paid"),
            ),
          )
        ) {
          break;
        }
      }
      const session = (await call("GET", `/api/session/${sessionID}`))?.data;
      return { sessionID, messages, session, beforeBoundary };
    });

    assert.equal(outcome.beforeBoundary, 0, "no paid request was spent during PEAK");
    const text = outcome.messages
      .flatMap((message) => message.content ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(" ");
    assert.match(text, /MOCK_OK model=ff-paid/);
    assert.equal(
      outcome.messages.filter((message) => message.type === "user").length,
      1,
      "no duplicate prompt across the boundary",
    );
    assert.equal(outcome.session?.model?.id, "ff-paid");
    writeConfig(coexistencePlugins);
    offpeakConfig(undefined);
  });

  it("Case 2 — a free-model 429 fails over in the same session with no duplicated prompt", async () => {
    offpeakConfig(undefined);
    reset();
    await control({
      log: [],
      free: { mode: "429", retryAfterSeconds: 2 },
      paid: { mode: "ok" },
    });
    const result = await run("Reply with the word READY");
    assertOk(result);
    assert.match(result.stdout, /free rate limit detected/);
    assert.match(result.stdout, /fallback selected/);
    assert.match(result.stdout, /failover switch confirmed/);
    assert.match(result.stdout, /model transition/);

    const state = await mockState();
    const requests = state.log.filter((entry) => entry.event === "request");
    const free = requests.filter((entry) => entry.role === "free");
    const paid = requests.filter((entry) => entry.role === "paid");
    assert.ok(free.length >= 1, "the free model was attempted first");
    assert.equal(paid.length, 1, "exactly one paid continuation");
    assert.equal(
      paid[0].messages,
      free[0].messages,
      "the continuation carried the same conversation, not a duplicated prompt",
    );
    assert.match(result.stdout, /MOCK_OK model=ff-paid/);
  });

  it("Case 4 — a still-limited free model keeps the fallback in charge", async () => {
    offpeakConfig(undefined);
    reset();
    await control({
      log: [],
      free: { mode: "429", retryAfterSeconds: 1 },
      paid: { mode: "ok" },
    });
    const result = await run("Reply with the word READY");
    assertOk(result);
    const state = await mockState();
    assert.equal(models(state).filter((model) => model === "ff-paid").length >= 1, true);
    assert.match(result.stdout, /recovery probe rate-limited|fallback selected/);
  });

  it("Case 6 — a failed recovery probe leaves the fallback session alone", async () => {
    offpeakConfig(undefined);
    reset();
    await control({
      log: [],
      free: { mode: "429", retryAfterSeconds: 1 },
      paid: { mode: "ok" },
    });
    const first = await run("Reply with the word READY");
    assertOk(first);
    const state = await mockState();
    const paidBefore = models(state).filter((model) => model === "ff-paid").length;
    assert.equal(paidBefore, 1);
    // No further main-session churn: the session answered on the fallback once.
    assert.doesNotMatch(first.stdout, /returned to free model/);
  });

  /**
   * Drive a persistent server the way the TUI does, so an interrupt-and-resume
   * can be observed to completion instead of ending a headless run.
   */
  async function withServer(fn) {
    const apiPort = await freePort();
    const password = `ff-${apiPort}-${Date.now()}`;
    const child = spawn(opencode, ["serve", "--hostname", "127.0.0.1", "--port", String(apiPort)], {
      cwd: path.join(home, "project"),
      env: {
        ...process.env,
        XDG_CONFIG_HOME: path.join(home, "config"),
        XDG_DATA_HOME: path.join(home, "data"),
        XDG_CACHE_HOME: path.join(home, "cache"),
        OPENCODE_SERVER_PASSWORD: password,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      output += String(chunk);
    });
    const call = async (method, route, body) => {
      const response = await fetch(`http://127.0.0.1:${apiPort}${route}`, {
        method,
        headers: { authorization: auth, "content-type": "application/json", connection: "close" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    };
    try {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        try {
          const info = await call("GET", "/api/info");
          if (info?.version) {
            ready = true;
            break;
          }
        } catch {
          /* not up yet */
        }
      }
      assert.ok(ready, "opencode serve did not become ready");
      return await fn({ call, output: () => output });
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (!child.killed) child.kill("SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  it("Case 3b — a live server resumes the parked task on the free model", async () => {
    offpeakConfig({
      id: "ffmock-paid-peak",
      providers: ["ffmock"],
      models: ["ff-paid"],
      flatModels: ["ff-free"],
      timeZone: "UTC",
      blocked: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" }],
      multiplier: 2,
      source: "integration test",
    });
    reset();
    await control({
      log: [],
      free: { mode: "429", retryAfterSeconds: 1, failFirst: 3 },
      paid: { mode: "ok" },
    });

    const outcome = await withServer(async ({ call, output }) => {
      const created = await call("POST", "/api/session", {
        title: "coexistence",
        model: { providerID: "ffmock", id: "ff-free" },
        location: { directory: path.join(home, "project") },
      });
      const sessionID = created?.id ?? created?.data?.id;
      assert.ok(sessionID, `no session id: ${JSON.stringify(created)}`);
      await call("POST", `/api/session/${sessionID}/prompt`, {
        text: "Reply with the word READY",
      });

      // Wait for the cooldown, the probe, the preemption, and the resumed turn.
      let messages = [];
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const context = await call("GET", `/api/session/${sessionID}/context`);
        messages = context?.data ?? [];
        const answered = messages.some(
          (message) =>
            message.type === "assistant" &&
            (message.content ?? []).some(
              (part) => part.type === "text" && String(part.text ?? "").includes("MOCK_OK"),
            ),
        );
        if (answered) break;
      }
      const session = (await call("GET", `/api/session/${sessionID}`))?.data;
      return { sessionID, messages, session, log: output() };
    });

    const assistantText = outcome.messages
      .filter((message) => message.type === "assistant")
      .flatMap((message) => message.content ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(" ");
    assert.match(assistantText, /MOCK_OK model=ff-free/, "the task finished on the free model");

    // No lost context, no duplicate work, no interruption left behind. The
    // same execution continued on the free model after the hold was cancelled,
    // so no continuation input was needed at all.
    const users = outcome.messages.filter((message) => message.type === "user");
    assert.equal(users.length, 1, "the user prompt was never duplicated");
    const synthetic = outcome.messages.filter((message) => message.type === "synthetic");
    assert.equal(synthetic.length, 0, "no continuation input was admitted");
    assert.match(outcome.log, /stale fallback continuation neutralized/);
    assert.match(outcome.log, /via: "cancel-hold"/);
    assert.doesNotMatch(outcome.log, /session\.execution\.interrupted/);
    const settled = outcome.messages.filter((message) => message.type === "idle");
    assert.equal(
      settled[settled.length - 1]?.outcome,
      "succeeded",
      "the turn ended successfully, not interrupted",
    );
    assert.equal(outcome.session?.model?.id, "ff-free", "the session ended on the free model");

    const state = await mockState();
    assert.equal(
      models(state).filter((model) => model === "ff-paid").length,
      0,
      "the parked paid request was never dispatched",
    );
    offpeakConfig(undefined);
  });

  it("Case 7 — a host that refuses the recovery probe never blocks the free model", async () => {
    // Regression for the 2026-10-16 live defect: OpenCode's free tier refuses
    // the out-of-band probe path, so the probe can never succeed. An
    // inconclusive probe must be treated as unknown, never as a limit, or every
    // new session is routed to the fallback forever after the first limit.
    offpeakConfig(undefined);
    reset();
    await control({
      free: { mode: "429", retryAfterSeconds: 1, failFirst: 2, gateProbe: true },
      paid: { mode: "ok" },
    });

    const project = path.join(home, "project");
    const answerOf = (messages) =>
      messages
        .filter((message) => message.type === "assistant")
        .flatMap((message) => message.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(" ");
    const answered = (messages) => /MOCK_OK/.test(answerOf(messages));

    const outcome = await withServer(async ({ call, output }) => {
      const start = async (title) => {
        const created = await call("POST", "/api/session", {
          title,
          model: { providerID: "ffmock", id: "ff-free" },
          location: { directory: project },
        });
        const sessionID = created?.data?.id ?? created?.id;
        assert.ok(sessionID, `no session id: ${JSON.stringify(created)}`);
        await call("POST", `/api/session/${sessionID}/prompt`, {
          text: "Reply with the word READY",
        });
        let messages = [];
        for (let attempt = 0; attempt < 80; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          const context = await call("GET", `/api/session/${sessionID}/context`);
          messages = context?.data ?? [];
          if (answered(messages)) break;
        }
        const session = (await call("GET", `/api/session/${sessionID}`))?.data;
        return { sessionID, messages, session };
      };

      const first = await start("probe-gate");
      // Wait for the cooldown to elapse and the probe to be attempted and
      // refused. This is the decisive step: the probe must not be able to keep
      // the free model blocked.
      let probeRefused = false;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const seen = await mockState();
        if (seen.log.some((entry) => entry.event === "probe-refused")) {
          probeRefused = true;
          break;
        }
      }
      // OpenCode 2.1 retries buffered model calls internally, so the refused
      // probe can take up to ~90 seconds to settle. Wait for the fail-open
      // recovery log rather than assuming 2.0's immediate failure.
      for (let attempt = 0; attempt < 240; attempt += 1) {
        if (/recovery probe (?:is not permitted|inconclusive)/.test(output())) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const firstAfter = (await call("GET", `/api/session/${first.sessionID}`))?.data;
      const second = await start("after-recovery");
      return { first, firstAfter, second, probeRefused, log: output() };
    });

    const { log } = outcome;
    assert.equal(outcome.probeRefused, true, "the probe was attempted and refused");
    assert.match(log, /free rate limit detected/);
    assert.match(
      log,
      /the recovery probe is not permitted for this model/,
      "the refused probe path was recognised",
    );
    assert.equal(
      outcome.firstAfter?.model?.id,
      "ff-free",
      "the first session was returned to the free model after the refused probe",
    );
    assert.equal(
      outcome.first.messages.filter((message) => message.type === "user").length,
      1,
      "the prompt was never duplicated",
    );

    // The free model stays the normal route: a second session is not downgraded.
    assert.match(
      answerOf(outcome.second.messages),
      /MOCK_OK model=ff-free/,
      "the second task finished on the free model",
    );
    assert.equal(outcome.second.session?.model?.id, "ff-free");
    assert.doesNotMatch(log, /prompt-admission/);

    const state = await mockState();
    assert.ok(
      state.log.some((entry) => entry.event === "probe-refused"),
      "the host refused the probe",
    );
    assert.equal(
      state.log.filter((entry) => entry.event === "error-response").length,
      1,
      "the free tier limited exactly the configured attempt",
    );
    assert.ok(
      state.log.filter((entry) => entry.event === "request" && entry.role === "free").length >= 3,
      "the free model was used again after the cooldown",
    );
  });

  it("Case 12 — the free-tier gate fails the same turn over and never repeats the doomed call", async () => {
    // The live incident (2026-10-17): OpenCode's own free-tier eligibility gate
    // ("OpenCode's free tier can only be used from within OpenCode") answered a
    // real model request, and every session died because the refusal was left
    // to surface as an authentication failure. The gate is served exactly once
    // and the free role then works, which is the upstream recovery this plugin
    // must ride out.
    offpeakConfig(undefined);
    reset();
    await control({
      log: [],
      free: { mode: "free-tier-gate", failFirst: 1, onlyWithTools: true },
      paid: { mode: "ok" },
    });
    const answerOf = (messages) =>
      messages
        .filter((message) => message.type === "assistant")
        .flatMap((message) => message.data?.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(" ");
    const result = await run("Reply with the word READY");
    assertOk(result);

    assert.match(result.stdout, /free route rejected/);
    assert.match(result.stdout, /fallback selected/);
    assert.match(result.stdout, /model transition/);
    assert.doesNotMatch(result.stdout, /provider failure is not a free-model availability failure/);
    assert.match(result.stdout, /MOCK_OK model=ff-paid/, "the task finished on the fallback");

    const state = await mockState();
    const gated = state.log.filter(
      (entry) => entry.event === "error-response" && entry.gate === true,
    );
    assert.equal(gated.length, 1, "the free route was refused exactly once for this incident");
    assert.equal(gated[0].status, 403);
    assert.match(gated[0].message, /free tier can only be used from within OpenCode/);

    const requests = state.log.filter((entry) => entry.event === "request");
    const paid = requests.filter((entry) => entry.role === "paid");
    assert.ok(paid.length >= 1, "exactly the failed turn continued on the fallback");
    assert.equal(
      state.log.filter((entry) => entry.event === "error-response").length,
      1,
      "no session re-spent a rejected free request",
    );

    // The session survived: one user message, no synthetic continuation, and
    // the failed turn was retried on the fallback without a second session.
    const record = transcript();
    assert.equal(record.sessions.length, 1, "the same session finished the turn");
    assert.equal(
      record.messages.filter((message) => message.type === "user").length,
      1,
      "the prompt was never duplicated",
    );
    assert.equal(record.model?.id, "ff-paid");
    assert.equal(answerOf(record.messages), "MOCK_OK model=ff-paid");
  });

  it("Case 13 — the free route returns automatically once the gate clears", async () => {
    // The gate is transient upstream: after it clears, the existing recovery
    // path must return waiting sessions to the free model with no manual
    // intervention, and the status must show the transition.
    offpeakConfig(undefined);
    reset();
    await control({
      log: [],
      free: { mode: "free-tier-gate", failFirst: 1, onlyWithTools: true },
      paid: { mode: "ok" },
    });

    const outcome = await withServer(async ({ call }) => {
      const created = await call("POST", "/api/session", {
        title: "free-route-gate",
        model: { providerID: "ffmock", id: "ff-free" },
        location: { directory: path.join(home, "project") },
      });
      const sessionID = created?.id ?? created?.data?.id;
      assert.ok(sessionID, `no session id: ${JSON.stringify(created)}`);
      await call("POST", `/api/session/${sessionID}/prompt`, {
        text: "Reply with the word READY",
      });

      const context = async () =>
        (await call("GET", `/api/session/${sessionID}/context`))?.data ?? [];
      const answers = (messages) =>
        messages.filter(
          (message) =>
            message.type === "assistant" &&
            (message.content ?? []).some(
              (part) => part.type === "text" && String(part.text ?? "").includes("MOCK_OK"),
            ),
        );
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (answers(await context()).length >= 1) break;
      }

      const rpc = async () =>
        (
          await call("POST", "/api/rpc/opencode-free-first/control", {
            input: { action: "status" },
          })
        )?.output?.status ?? {};

      const during = await rpc();
      const first = answers(await context());
      assert.equal(first.length, 1, "the first turn was answered exactly once");
      assert.match(
        first[0].content.map((part) => part.text ?? "").join(""),
        /MOCK_OK model=ff-paid/,
      );

      // Wait for the bounded retry window and the existing recovery path.
      let after;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        after = await rpc();
        if (after.state === "FREE_HEALTHY" && after.fallbackSessions === 0) break;
      }

      // The recovered route must actually serve the next turn.
      await call("POST", `/api/session/${sessionID}/prompt`, {
        text: "Reply with the word READY",
      });
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (answers(await context()).length >= 2) break;
      }
      const session = (await call("GET", `/api/session/${sessionID}`))?.data;
      return { during, after, messages: await context(), session, sessionID };
    });

    assert.equal(outcome.during.state, "FREE_COOLDOWN");
    assert.equal(
      outcome.during.cooldownReason,
      "free-route",
      "the status names the free-route cause, not a rate limit",
    );
    assert.equal(outcome.during.lastRateLimitAt, undefined, "no rate-limit metadata was invented");
    assert.match(outcome.during.status, /route rejected/);
    assert.equal(outcome.after.state, "FREE_HEALTHY", "recovery returned the route to FREE");
    assert.equal(outcome.after.cooldownReason, undefined);
    assert.equal(outcome.after.fallbackSessions, 0);
    assert.equal(outcome.session?.model?.id, "ff-free", "the session is back on the free model");

    const answers = outcome.messages.filter(
      (message) =>
        message.type === "assistant" &&
        (message.content ?? []).some(
          (part) => part.type === "text" && String(part.text ?? "").includes("MOCK_OK"),
        ),
    );
    assert.equal(answers.length, 2, "each turn was answered exactly once");
    assert.match(
      answers[1].content.map((part) => part.text ?? "").join(""),
      /MOCK_OK model=ff-free/,
      "the second turn ran on the recovered free route",
    );
    assert.equal(
      outcome.messages.filter((message) => message.type === "user").length,
      2,
      "no continuation input was injected",
    );

    const state = await mockState();
    assert.equal(
      state.log.filter((entry) => entry.event === "error-response" && entry.gate === true).length,
      1,
      "only the first free request was refused",
    );
    assert.ok(
      state.log.filter((entry) => entry.event === "request" && entry.role === "free").length >= 3,
      "the free route was used again after the gate cleared",
    );
  });

  it("Case 14 — a provider auth failure stops visibly instead of failing over", async () => {
    // The distinction the whole classification rests on: a generic auth error
    // is an operator problem, not a free-route problem, so the plugin must not
    // move the session to the paid route and must not hide the failure.
    offpeakConfig(undefined);
    reset();
    await control({
      log: [],
      free: { mode: "401" },
      paid: { mode: "ok" },
    });
    const result = await run("Reply with the word READY");
    assert.notEqual(result.status, 0, "the run failed instead of silently continuing");
    assert.doesNotMatch(result.stdout, /fallback selected/);
    assert.doesNotMatch(result.stdout, /free route rejected/);
    assert.match(result.stdout, /mock error 401|authentication|unauthorized/i);

    const state = await mockState();
    assert.equal(
      state.log.filter((entry) => entry.event === "request" && entry.role === "paid").length,
      0,
      "no paid request was made for an authentication failure",
    );
  });

  it("Case 15 — a provider 500 fails the same turn over instead of killing it", async () => {
    // The live incident (2026-10-18): the free route answered a real model
    // request with `Provider request failed with HTTP 500` and the turn died,
    // even though the configured fallback was available. The superseded policy
    // only failed over on a rate limit or the free-tier gate.
    offpeakConfig(undefined);
    reset();
    await control({
      log: [],
      free: { mode: "500", failFirst: 1, onlyWithTools: true },
      paid: { mode: "ok" },
    });
    const result = await run("Reply with the word READY");
    assertOk(result);

    assert.match(result.stdout, /free route transient failure detected/);
    assert.match(result.stdout, /fallback selected/);
    assert.match(result.stdout, /availability-failover/);
    assert.doesNotMatch(result.stdout, /free rate limit detected/, "a 500 is not a 429");
    assert.match(result.stdout, /MOCK_OK model=ff-paid/, "the task finished on the fallback");

    const state = await mockState();
    const errors = state.log.filter((entry) => entry.event === "error-response");
    assert.equal(errors.length, 1, "the provider outage was served exactly once");
    assert.equal(errors[0].status, 500);
    const requests = state.log.filter((entry) => entry.event === "request");
    const free = requests.filter((entry) => entry.role === "free");
    const paid = requests.filter((entry) => entry.role === "paid");
    assert.ok(paid.length >= 1, "the failed turn continued on the fallback");
    // The continuation is the *same* failed request, not a re-sent prompt: the
    // message count, the tool set, and the conversation are identical.
    const failed = free.at(-1);
    assert.equal(
      paid[0].messages,
      failed.messages,
      "the continuation carried the same conversation",
    );
    assert.equal(paid[0].tools, failed.tools, "the continuation kept the same tool set");

    const record = transcript();
    assert.equal(record.sessions.length, 1, "the same session finished the turn");
    assert.equal(
      record.messages.filter((message) => message.type === "user").length,
      1,
      "the prompt was never duplicated",
    );
    assert.equal(record.model?.id, "ff-paid");
  });

  it("Case 16 — the free route returns automatically after a provider outage", async () => {
    // The other half of the contract: the bounded transient cooldown must be
    // waitable, and the existing recovery path must return the same session to
    // the free model once the provider is healthy again.
    offpeakConfig(undefined);
    reset();
    await control({
      log: [],
      free: { mode: "500", failFirst: 1, onlyWithTools: true },
      paid: { mode: "ok" },
    });

    const outcome = await withServer(async ({ call }) => {
      const created = await call("POST", "/api/session", {
        title: "provider-outage",
        model: { providerID: "ffmock", id: "ff-free" },
        location: { directory: path.join(home, "project") },
      });
      const sessionID = created?.id ?? created?.data?.id;
      assert.ok(sessionID, `no session id: ${JSON.stringify(created)}`);
      await call("POST", `/api/session/${sessionID}/prompt`, {
        text: "Reply with the word READY",
      });

      const context = async () =>
        (await call("GET", `/api/session/${sessionID}/context`))?.data ?? [];
      const answers = (messages) =>
        messages.filter(
          (message) =>
            message.type === "assistant" &&
            (message.content ?? []).some(
              (part) => part.type === "text" && String(part.text ?? "").includes("MOCK_OK"),
            ),
        );
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (answers(await context()).length >= 1) break;
      }

      const rpc = async () =>
        (
          await call("POST", "/api/rpc/opencode-free-first/control", {
            input: { action: "status" },
          })
        )?.output?.status ?? {};

      const during = await rpc();
      const first = answers(await context());
      assert.equal(first.length, 1, "the first turn was answered exactly once");
      assert.match(
        first[0].content.map((part) => part.text ?? "").join(""),
        /MOCK_OK model=ff-paid/,
      );

      // Wait for the bounded transient window and the existing recovery path.
      let after;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        after = await rpc();
        if (after.state === "FREE_HEALTHY" && after.fallbackSessions === 0) break;
      }

      // The recovered route must actually serve the next turn.
      await call("POST", `/api/session/${sessionID}/prompt`, {
        text: "Reply with the word READY",
      });
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (answers(await context()).length >= 2) break;
      }
      const session = (await call("GET", `/api/session/${sessionID}`))?.data;
      return { during, after, messages: await context(), session };
    });

    assert.equal(outcome.during.state, "FREE_COOLDOWN");
    assert.equal(
      outcome.during.cooldownReason,
      "transient-availability",
      "the status names the transient cause",
    );
    assert.equal(outcome.during.lastRateLimitAt, undefined, "no rate-limit metadata was invented");
    assert.equal(outcome.during.transientFailures, 1);
    assert.equal(outcome.during.lastTransientType, "failover-http-500");
    assert.match(outcome.during.status, /transient provider failure/);
    assert.equal(outcome.after.state, "FREE_HEALTHY", "recovery returned the route to FREE");
    assert.equal(outcome.after.cooldownReason, undefined);
    assert.equal(outcome.after.fallbackSessions, 0);
    assert.equal(outcome.after.transientFailures, 0, "the confirmed success reset the ladder");
    assert.equal(outcome.session?.model?.id, "ff-free", "the session is back on the free model");

    const answers = outcome.messages.filter(
      (message) =>
        message.type === "assistant" &&
        (message.content ?? []).some(
          (part) => part.type === "text" && String(part.text ?? "").includes("MOCK_OK"),
        ),
    );
    assert.equal(answers.length, 2, "each turn was answered exactly once");
    assert.match(
      answers[1].content.map((part) => part.text ?? "").join(""),
      /MOCK_OK model=ff-free/,
      "the second turn ran on the recovered free route",
    );
    assert.equal(
      outcome.messages.filter((message) => message.type === "user").length,
      2,
      "no continuation input was injected",
    );

    const state = await mockState();
    assert.equal(
      state.log.filter((entry) => entry.event === "error-response").length,
      1,
      "only the first free request hit the outage",
    );
    assert.ok(
      state.log.filter((entry) => entry.event === "request" && entry.role === "free").length >= 3,
      "the free route was used again after the outage",
    );
  });

  it("Case 3 — a parked paid fallback is reclaimed for the free model without interrupting the session", async () => {
    // The paid route is peak-priced for the whole test window and the free
    // route is declared flat and never delayed, so opencode-offpeak holds paid
    // work exactly as it would in production while leaving the free model free.
    //
    // This is the required headless acceptance case: the free route rate limits,
    // the session fails over to peak-priced paid work, opencode-offpeak parks
    // that request, the free route becomes usable again before the paid window
    // opens, and free-first reclaims the task through the neighbour's generic
    // hold cancellation. Nothing interrupts the session, so the plain
    // `opencode run` client stays attached and prints the final answer.
    offpeakConfig({
      id: "ffmock-paid-peak",
      providers: ["ffmock"],
      models: ["ff-paid"],
      flatModels: ["ff-free"],
      timeZone: "UTC",
      blocked: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" }],
      multiplier: 2,
      source: "integration test",
    });
    reset();
    await control({
      log: [],
      free: { mode: "429", retryAfterSeconds: 1, failFirst: 3 },
      paid: { mode: "ok" },
    });

    const result = await run("Reply with the word READY");
    const parkedState = await mockState();
    if (process.env.FF_KEEP_HOME === "1") {
      writeFileSync(path.join(home, "case3.log"), result.stdout);
      writeFileSync(path.join(home, "case3-mock.json"), JSON.stringify(parkedState, null, 2));
    }

    // 8. The run stayed attached, exited 0, and printed the final answer.
    assertOk(result);
    assert.match(
      result.stdout,
      /MOCK_OK model=ff-free/,
      "the final answer came from the free model",
    );

    // 2 and 3: the fallback switched to paid and the neighbour parked it.
    assert.match(result.stdout, /fallback selected/);
    assert.match(result.stdout, /parked fallback request detected/);
    // 5: free-first reclaimed the task with the generic cancellation.
    assert.match(result.stdout, /stale fallback continuation neutralized/);
    assert.match(result.stdout, /via: "cancel-hold"/);
    assert.match(result.stdout, /same task resumed on the free model/);
    // 6: the parked paid request was refused at the transport boundary and the
    // paid provider received zero requests.
    const state = parkedState;
    assert.equal(
      models(state).filter((model) => model === "ff-paid").length,
      0,
      "the parked paid request was never dispatched",
    );

    // The successful path needs no interruption and no extra input.
    assert.doesNotMatch(
      result.stdout,
      /session\.execution\.interrupted/,
      "no interruption was needed",
    );
    assert.doesNotMatch(
      result.stdout,
      /duplicate continuation prevented/,
      "the interrupt-based fallback was not used",
    );
    assert.equal(
      (result.stdout.match(/model transition/g) ?? []).length,
      2,
      "exactly the minimum transitions: failover to paid, then back to free",
    );

    // The persisted transcript is the strongest evidence: one prompt, one
    // answer, two model switches, no continuation input, no tool call.
    const record = transcript();
    assert.equal(record.sessions.length, 1, "no second session");
    const users = record.messages.filter((message) => message.type === "user");
    assert.equal(users.length, 1, "one user message only");
    const continuations = record.messages.filter(
      (message) => message.type === "synthetic" && message.data.metadata?.instruction === undefined,
    );
    assert.equal(continuations.length, 0, "no continuation input was admitted");
    const answers = record.messages.filter(
      (message) =>
        message.type === "assistant" &&
        String(message.data.model?.id ?? "") === "ff-free" &&
        (message.data.content ?? []).some(
          (part) => part.type === "text" && String(part.text ?? "").includes("MOCK_OK"),
        ),
    );
    assert.equal(answers.length, 1, "exactly one final answer, from the free model");
    const paidAnswers = record.messages.filter(
      (message) =>
        message.type === "assistant" && String(message.data.model?.id ?? "") === "ff-paid",
    );
    assert.equal(paidAnswers.length, 0, "the paid model never produced an answer");
    const switches = record.messages.filter((message) => message.type === "model-switched");
    assert.equal(switches.length, 2, "one switch to the fallback and one back to the free model");
    assert.equal(
      record.parts.filter((part) => part.type === "tool").length,
      0,
      "no tool call was executed, so none can be duplicated",
    );
    assert.equal(record.model.id, "ff-free", "the session ends on the free model");
    assert.equal(record.session.idle_outcome, "succeeded", "the turn succeeded, not interrupted");

    // 7: the free route answered after recovery, and the free tier limited
    // exactly the configured requests.
    const freeRequests = state.log.filter(
      (entry) => entry.event === "request" && entry.role === "free",
    );
    const failures = state.log.filter((entry) => entry.event === "error-response");
    assert.equal(failures.length, 3, "the free tier limited exactly the configured attempts");
    assert.ok(
      freeRequests.length >= 4,
      `expected a post-recovery free request: ${JSON.stringify(models(state))}`,
    );
    // No stale paid continuation fires later, either.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const after = await mockState();
    assert.equal(
      models(after).filter((model) => model === "ff-paid").length,
      0,
      "no delayed paid dispatch after the run",
    );
    offpeakConfig(undefined);
  });

  it("Case 8 — a compaction that starts while FREE is already cooling down never reaches the free provider", async () => {
    // Required scenario 1: known cooldown before compaction.
    //
    // OpenCode resolves the compaction's model at the step boundary, and a
    // retried compaction re-sends the model it resolved. A session still
    // represented on the free model at that boundary therefore spends a free
    // request that free-first already knows will be limited — the defect this
    // case covers. Every free request fails for the whole case, so the only way
    // turn 2 can answer at all is on the fallback.
    offpeakConfig(flatPolicy());
    reset();
    const first = await knownCooldownTurn();
    assert.equal(
      first.state.log.some((entry) => entry.event === "error-response"),
      true,
      "turn 1 discovered the free-tier limit",
    );
    assert.match(first.first.stdout, /MOCK_OK model=ff-paid/);

    // Turn 2: the window is measured as nearly full, so this turn issues an
    // automatic compaction at its step boundary — before its own primary
    // request, and before any plugin hook can run.
    await control({
      log: [],
      free: { mode: "429", failFirst: null, retryAfterSeconds: 120, promptTokens: 190_000 },
      paid: { mode: "ok", promptTokens: 190_000 },
    });
    const second = await run("Continue", ["--session", first.sessionID]);
    assertOk(second);
    const state = await mockState();
    if (process.env.FF_KEEP_HOME === "1") {
      writeFileSync(path.join(home, "case8-turn2.log"), second.stdout);
      writeFileSync(path.join(home, "case8-mock.json"), JSON.stringify(state, null, 2));
      writeFileSync(
        path.join(home, "case8-transcript.json"),
        JSON.stringify(transcript(), null, 2),
      );
    }

    assert.equal(
      compactionRequests(state, "paid").length,
      1,
      `the compaction was served by the fallback route: ${JSON.stringify(
        state.log.map((entry) => `${entry.role}:${entry.model}${entry.compaction ? "[c]" : ""}`),
      )}`,
    );
    assert.equal(
      compactionRequests(state, "free").length,
      0,
      "the compaction must not spend a free request while the cooldown is known",
    );
    assert.equal(
      state.log.filter((entry) => entry.event === "error-response").length,
      0,
      "no free request was made that the known cooldown could have predicted",
    );

    const record = transcript();
    assert.equal(
      compactions(record).filter((message) => message.data.status === "failed").length,
      0,
      "no failed compaction",
    );
    assert.equal(
      compactions(record).filter((message) => message.data.status === "completed").length,
      1,
      "exactly one completed compaction",
    );
    const switches = record.messages.filter((message) => message.type === "model-switched");
    assert.equal(switches.length, 1, "one switch to the fallback, and no churn back");
    assert.equal(
      record.model.id,
      "ff-paid",
      "the session stays on the fallback while the cooldown lasts",
    );
    assert.match(second.stdout, /MOCK_OK model=ff-paid/);
    offpeakConfig(undefined);
  });

  it("Case 20 — peak-only OFF_PEAK compaction stays on Go with zero free requests", async () => {
    writePeakOnlyConfig();
    offpeakConfig(flatPolicy());
    reset();
    await control({
      log: [],
      free: { mode: "500", failFirst: null, promptTokens: 190_000 },
      paid: { mode: "ok", promptTokens: 190_000 },
    });

    const first = await run("Reply with the word READY");
    assertOk(first);
    assert.match(first.stdout, /MOCK_OK model=ff-paid/);
    const record = transcript();
    const sessionID = record.session?.id;
    assert.ok(sessionID, "the first turn created a session");

    await control({
      log: [],
      free: { mode: "500", failFirst: null, promptTokens: 190_000 },
      paid: { mode: "ok", promptTokens: 190_000 },
    });
    const second = await run("Continue", ["--session", sessionID]);
    assertOk(second);
    assert.match(second.stdout, /MOCK_OK model=ff-paid/);

    const state = await mockState();
    assert.equal(compactionRequests(state, "paid").length, 1, "Go served the compaction");
    assert.equal(compactionRequests(state, "free").length, 0, "no free compaction");
    assert.equal(
      state.log.filter((entry) => entry.event === "request" && entry.role === "free").length,
      0,
      "OFF_PEAK made no free request at all",
    );
    assert.equal(
      compactions(transcript()).filter((message) => message.data.status === "completed").length,
      1,
      "exactly one completed compaction",
    );
    assert.equal(transcript().model.id, "ff-paid");
    writeConfig(coexistencePlugins);
    offpeakConfig(undefined);
  });

  it("Case 9 — a genuine free limit discovered by a compaction fails over without burning more free requests", async () => {
    // Required scenario 2: FREE believed healthy, the compaction tries FREE and
    // discovers the limit. The failed compaction is acceptable here — that
    // request *is* the discovery — but the attempt must not be retried on the
    // free model, which cannot change its model, and the retried compaction must
    // succeed on the fallback exactly once.
    offpeakConfig(flatPolicy());
    reset();
    const first = await knownCooldownTurn({ freeMode: "ok" });
    assert.equal(
      first.state.log.every((entry) => entry.event !== "error-response"),
      true,
      "turn 1 ran entirely on the free model",
    );

    // Turn 2 compacts on the free model, which starts limiting right now.
    await control({
      log: [],
      free: { mode: "429", failFirst: 1, retryAfterSeconds: 120, promptTokens: 190_000 },
      paid: { mode: "ok", promptTokens: 190_000 },
    });
    const second = await run("Continue", ["--session", first.sessionID]);
    const afterSecond = await mockState();
    assert.equal(
      compactionRequests(afterSecond, "free").length,
      1,
      "the compaction discovered the limit on the free model",
    );
    assert.equal(
      afterSecond.log.filter((entry) => entry.event === "error-response").length,
      1,
      "the doomed free compaction was not retried",
    );
    assert.equal(
      compactionRequests(afterSecond, "paid").length,
      0,
      "a cancelled-in-advance attempt does not dispatch on the fallback either",
    );
    void second;

    // Turn 3: the session now runs on the fallback, so the compaction the failed
    // turn could not finish succeeds there, exactly once.
    await control({
      log: [],
      free: { mode: "429", failFirst: null, retryAfterSeconds: 120, promptTokens: 190_000 },
      paid: { mode: "ok", promptTokens: 190_000 },
    });
    const third = await run("Continue", ["--session", first.sessionID]);
    assertOk(third);
    const state = await mockState();
    assert.equal(
      compactionRequests(state, "paid").length,
      1,
      "the retried compaction ran on the fallback",
    );
    assert.equal(
      compactionRequests(state, "free").length,
      0,
      "the free model was never asked for a compaction again",
    );
    const record = transcript();
    assert.equal(
      compactions(record).filter((message) => message.data.status === "completed").length,
      1,
      "exactly one compaction completed across the whole case",
    );
    assert.match(third.stdout, /MOCK_OK model=ff-paid/);
    offpeakConfig(undefined);
  });

  it("Case 10 — free-first works with no policy plugin installed at all", async () => {
    // Independence: only the free-first entry is installed here. Nothing may
    // depend on the neighbour being present.
    writeConfig([{ package: repo, options: freeFirstOptions }]);
    reset();
    await control({
      log: [],
      // Every free request fails, so the only way this turn can answer is on
      // the fallback — with no policy plugin installed to help.
      free: { mode: "429", retryAfterSeconds: 30, promptTokens: 10 },
      paid: { mode: "ok", promptTokens: 10 },
    });
    const result = await run("Reply with the word READY");
    assertOk(result);
    const state = await mockState();
    assert.match(result.stdout, /MOCK_OK model=ff-paid/, "the same turn failed over on its own");
    assert.equal(
      models(state).filter((model) => model === "ff-paid").length > 0,
      true,
      "the fallback route was used without any policy plugin",
    );
    const record = transcript();
    assert.equal(
      record.messages.filter((message) => message.type === "user").length,
      1,
      "one user message",
    );
    assert.equal(record.session.idle_outcome, "succeeded");
    writeConfig(coexistencePlugins);
  });

  it("Case 11 — offpeak works with no free-first plugin installed at all", async () => {
    // Independence, the other way round: offpeak alone still prices paid work,
    // and it knows nothing about the free model.
    writeConfig([OFFPEAK_SPEC]);
    reset();
    offpeakConfig({
      id: "ffmock-paid-peak",
      providers: ["ffmock"],
      models: ["ff-paid"],
      flatModels: ["ff-free"],
      timeZone: "UTC",
      blocked: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" }],
      multiplier: 2,
      source: "integration test",
    });

    // `guard` mode blocks a peak interactive request instead of holding it, so
    // the standalone behaviour is observable without waiting for a window.
    writeJson(path.join(home, "config", "opencode", "offpeak.json"), {
      schemaVersion: 1,
      enabled: true,
      mode: "guard",
      displayTimeZone: "UTC",
      policies: [
        {
          id: "ffmock-paid-peak",
          providers: ["ffmock"],
          models: ["ff-paid"],
          flatModels: ["ff-free"],
          timeZone: "UTC",
          blocked: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" }],
          multiplier: 2,
          source: "integration test",
        },
      ],
    });
    await control({
      log: [],
      free: { mode: "ok", promptTokens: 10 },
      paid: { mode: "ok", promptTokens: 10 },
    });
    const blocked = await run("Reply with the word READY", ["--model", "ffmock/ff-paid"]);
    assert.notEqual(blocked.status, 0, "the peak window is enforced by offpeak alone");
    assert.match(blocked.stdout, /pricing guard|peak/i);
    assert.equal(
      models(await mockState()).filter((model) => model === "ff-paid").length,
      0,
      "no paid request escaped the guard",
    );

    // With the paid route allowed, the same standalone plugin lets the turn run.
    offpeakConfig({
      id: "ffmock-flat",
      providers: ["ffmock"],
      models: ["ff-paid"],
      flatModels: ["ff-free"],
      timeZone: "UTC",
      blocked: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:01" }],
      multiplier: 2,
      source: "integration test",
    });
    const allowed = await run("Reply with the word READY", ["--model", "ffmock/ff-paid"]);
    assertOk(allowed);
    assert.match(allowed.stdout, /MOCK_OK model=ff-paid/);
    writeConfig(coexistencePlugins);
    offpeakConfig(undefined);
  });
  /* ---------------------------------------------------------------- titles */

  /**
   * Wait for the durable session row to satisfy `predicate`. Titles are a
   * forked background request, so a test must read the stored title, not the
   * streaming transcript.
   */
  async function waitForSession(call, sessionID, predicate, label) {
    let last;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      last = (await call("GET", `/api/session/${sessionID}`))?.data;
      if (last !== undefined && predicate(last)) return last;
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
  }

  const titled = (session) => typeof session?.title === "string" && session.title.length > 0;
  const userMessages = (messages) => messages.filter((message) => message.type === "user");
  const answered = (messages) =>
    messages.filter(
      (message) =>
        message.type === "assistant" &&
        (message.content ?? []).some(
          (part) => part.type === "text" && String(part.text ?? "").includes("MOCK_OK"),
        ),
    );

  it("Case 22 — the live free tool-less title gate: the turn is titled by the replacement request", async () => {
    // anomalyco/opencode#58176: the normal tool-bearing request succeeds while
    // the tool-less automatic title request is refused with 403 FreeTierError.
    // The session must still receive a durable, generated title, and OpenCode's
    // doomed native title request must not be sent at all.
    offpeakConfig(undefined);
    reset();
    await control({
      log: [],
      free: {
        mode: "free-tier-gate",
        toolLessOnly: true,
        delayMs: 300,
        ignoreTitleReplacement: false,
      },
      paid: { mode: "ok" },
    });

    const outcome = await withServer(async ({ call }) => {
      const created = await call("POST", "/api/session", {
        model: { providerID: "ffmock", id: "ff-free" },
        location: { directory: path.join(home, "project") },
      });
      const sessionID = created?.id ?? created?.data?.id;
      assert.ok(sessionID, `no session id: ${JSON.stringify(created)}`);
      await call("POST", `/api/session/${sessionID}/prompt`, {
        text: "Fix the failing deployment pipeline",
      });
      const session = await waitForSession(
        call,
        sessionID,
        (candidate) => candidate.title === "Deploy pipeline repair",
        "the generated title",
      );
      const messages = (await call("GET", `/api/session/${sessionID}/context`))?.data ?? [];
      return { session, messages, sessionID };
    });

    assert.equal(outcome.session.title, "Deploy pipeline repair");
    assert.equal(userMessages(outcome.messages).length, 1, "the prompt was never duplicated");
    assert.equal(answered(outcome.messages).length, 1, "the turn was answered exactly once");

    const state = await mockState();
    const requests = state.log.filter(
      (entry) => entry.event === "request" && entry.role === "free",
    );
    const replacements = requests.filter((entry) => entry.titleReplacement === true);
    assert.equal(replacements.length, 1, "exactly one replacement title request");
    assert.ok((replacements[0].tools ?? 0) > 0, "the replacement request carries tools");
    assert.equal(
      requests.filter((entry) => (entry.tools ?? 0) === 0).length,
      0,
      "the native tool-less title request never ran",
    );
    assert.equal(
      state.log.filter((entry) => entry.event === "error-response").length,
      0,
      "no request was refused",
    );
  });

  it("Case 23 — a failing free title still yields a deterministic first-prompt title", async () => {
    // Free is exhausted: the main turn fails over and answers on the fallback
    // (existing semantics untouched), while the title falls back to the first
    // prompt instead of staying empty.
    offpeakConfig(undefined);
    reset();
    await control({
      log: [],
      free: { mode: "429", retryAfterSeconds: 120, ignoreTitleReplacement: false },
      paid: { mode: "ok" },
      failTitleReplacement: true,
    });

    const outcome = await withServer(async ({ call }) => {
      const created = await call("POST", "/api/session", {
        model: { providerID: "ffmock", id: "ff-free" },
        location: { directory: path.join(home, "project") },
      });
      const sessionID = created?.id ?? created?.data?.id;
      await call("POST", `/api/session/${sessionID}/prompt`, {
        text: "Reply with exactly: hi",
      });
      const title = await waitForSession(call, sessionID, titled, "the fallback title");
      const settled = await waitForSession(
        call,
        sessionID,
        (candidate) => candidate.outcome === "succeeded",
        "the settled turn",
      );
      const messages = (await call("GET", `/api/session/${sessionID}/context`))?.data ?? [];
      return { title, messages, session: settled };
    });

    assert.equal(outcome.title.title, "Reply with exactly: hi");
    assert.equal(userMessages(outcome.messages).length, 1, "the prompt was never duplicated");
    assert.equal(answered(outcome.messages).length, 1, "the turn was answered exactly once");
    assert.match(
      answered(outcome.messages)[0]
        .content.map((part) => part.text ?? "")
        .join(""),
      /MOCK_OK model=ff-paid/,
    );

    const state = await mockState();
    assert.ok(
      state.log.some((entry) => entry.event === "error-response" && entry.status === 429),
      "the free route really refused the requests",
    );
    assert.equal(
      state.log.filter((entry) => entry.event === "request" && entry.titleReplacement === true)
        .length,
      0,
      "the free title hook never opened a provider request",
    );
  });

  it("Case 24 — a paid session keeps OpenCode's native title path", async () => {
    offpeakConfig(undefined);
    reset();
    await control({
      log: [],
      free: { mode: "ok" },
      paid: { mode: "ok" },
      failTitleReplacement: false,
    });
    // Pin the title agent to the paid model, as production's Go route does for
    // a fallback session; the free-only shim must stay out of the way.
    writeConfig(coexistencePlugins, {
      agents: { title: { model: { providerID: "ffmock", model: "ff-paid" } } },
    });

    const outcome = await withServer(async ({ call }) => {
      const created = await call("POST", "/api/session", {
        model: { providerID: "ffmock", id: "ff-paid" },
        location: { directory: path.join(home, "project") },
      });
      const sessionID = created?.id ?? created?.data?.id;
      await call("POST", `/api/session/${sessionID}/prompt`, {
        text: "Reply with exactly: hi",
      });
      const title = await waitForSession(call, sessionID, titled, "the native title");
      return { title };
    });

    assert.equal(outcome.title.title, "MOCK_OK model=ff-paid");
    const state = await mockState();
    assert.equal(
      state.log.filter((entry) => entry.event === "request" && entry.titleReplacement === true)
        .length,
      0,
      "the free-only shim never replaced a paid title",
    );
    assert.ok(
      state.log.some(
        (entry) => entry.event === "request" && entry.role === "paid" && (entry.tools ?? 0) === 0,
      ),
      "OpenCode's native tool-less title request ran",
    );
  });

  it("Case 25 — a manual rename wins the race against automatic naming", async () => {
    offpeakConfig(undefined);
    reset();
    await control({
      log: [],
      // Keep the replacement generation in flight long enough to rename first.
      free: { mode: "ok", delayMs: 1_500, ignoreTitleReplacement: false },
      paid: { mode: "ok" },
    });

    const outcome = await withServer(async ({ call }) => {
      const created = await call("POST", "/api/session", {
        model: { providerID: "ffmock", id: "ff-free" },
        location: { directory: path.join(home, "project") },
      });
      const sessionID = created?.id ?? created?.data?.id;
      await call("POST", `/api/session/${sessionID}/prompt`, {
        text: "Fix the failing deployment pipeline",
      });
      await call("PATCH", `/api/session/${sessionID}`, { title: "Manual operator title" });
      // Give the automatic attempt time to finish and (must not) overwrite.
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      return (await call("GET", `/api/session/${sessionID}`))?.data;
    });

    assert.equal(outcome?.title, "Manual operator title");
  });

  it("Case 26 — a previously untitled session is titled on its next message", async () => {
    offpeakConfig(undefined);
    reset();
    await control({
      log: [],
      free: { mode: "ok", ignoreTitleReplacement: false },
      paid: { mode: "ok" },
    });

    const outcome = await withServer(async ({ call }) => {
      const created = await call("POST", "/api/session", {
        model: { providerID: "ffmock", id: "ff-free" },
        location: { directory: path.join(home, "project") },
      });
      const sessionID = created?.id ?? created?.data?.id;
      // Admit a first message without executing the turn: the durable session
      // stays untitled, which is the legacy state left by the old defect.
      await call("POST", `/api/session/${sessionID}/prompt`, {
        text: "Fix the failing deployment pipeline",
        resume: false,
      });
      const before = (await call("GET", `/api/session/${sessionID}`))?.data;
      await call("POST", `/api/session/${sessionID}/prompt`, {
        text: "Reply with exactly: hi",
      });
      const title = await waitForSession(call, sessionID, titled, "the recovered title");
      return { before, title };
    });

    assert.ok(!titled(outcome.before), "the session really started untitled");
    assert.ok(titled(outcome.title), "the next message produced a durable title");
  });

  it("Case 27 — peak-only OFF_PEAK makes no free title request", async () => {
    // The title shim must obey the same price gate as the router: off-peak it
    // spends nothing on Free, and the paid session keeps its native title.
    writePeakOnlyConfig();
    offpeakConfig(flatPolicy());
    reset();
    await control({ log: [], free: { mode: "ok" }, paid: { mode: "ok" } });

    const outcome = await withServer(async ({ call }) => {
      const created = await call("POST", "/api/session", {
        model: { providerID: "ffmock", id: "ff-free" },
        location: { directory: path.join(home, "project") },
      });
      const sessionID = created?.id ?? created?.data?.id;
      await call("POST", `/api/session/${sessionID}/prompt`, {
        text: "Reply with exactly: hi",
      });
      const title = await waitForSession(call, sessionID, titled, "the title");
      return title;
    });

    assert.ok(titled(outcome));
    const state = await mockState();
    assert.equal(
      state.log.filter((entry) => entry.event === "request" && entry.role === "free").length,
      0,
      "peak-only off-peak never touched Free, including the title",
    );
    writeConfig(coexistencePlugins);
  });

  it("Case 28 — a server restart keeps the durable title and does not regenerate it", async () => {
    offpeakConfig(undefined);
    reset();
    await control({ log: [], free: { mode: "ok" }, paid: { mode: "ok" } });

    const first = await withServer(async ({ call }) => {
      const created = await call("POST", "/api/session", {
        model: { providerID: "ffmock", id: "ff-free" },
        location: { directory: path.join(home, "project") },
      });
      const sessionID = created?.id ?? created?.data?.id;
      await call("POST", `/api/session/${sessionID}/prompt`, {
        text: "Fix the failing deployment pipeline",
      });
      const title = await waitForSession(call, sessionID, titled, "the first title");
      return { sessionID, title: title.title };
    });

    const second = await withServer(async ({ call }) => {
      await call("POST", `/api/session/${first.sessionID}/prompt`, {
        text: "Reply with exactly: hi",
      });
      const messages = [];
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        messages.splice(
          0,
          messages.length,
          ...((await call("GET", `/api/session/${first.sessionID}/context`))?.data ?? []),
        );
        if (answered(messages).length >= 2) break;
      }
      const title = (await call("GET", `/api/session/${first.sessionID}`))?.data;
      return { title, messages };
    });

    assert.equal(second.title?.title, first.title);
    assert.equal(userMessages(second.messages).length, 2, "each user message is durable once");
  });
});

function assertOk(result) {
  if (result.status !== 0) {
    throw new Error(`opencode run failed (${result.status}):\n${result.stdout.slice(-4_000)}`);
  }
}
