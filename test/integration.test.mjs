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
  process.env.FF_OFFPEAK_SPEC ?? "git+https://github.com/lutzkind/opencode-offpeak.git#v0.1.8";

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

    writeJson(path.join(home, "config", "opencode", "opencode.json"), {
      $schema: "https://opencode.ai/config.json",
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
      websearch: false,
      model: "ffmock/ff-free",
      plugins: [
        OFFPEAK_SPEC,
        {
          package: repo,
          options: {
            primary: { providerID: "ffmock", id: "ff-free" },
            fallback: { providerID: "ffmock", id: "ff-paid" },
            preferAsDefault: true,
            adoptFallbackSessions: true,
            backoffMs: [2_000, 4_000, 8_000],
            maxCooldownMs: 8_000,
            jitterRatio: 0,
            failoverRetryDelayMs: 50,
            parkGraceMs: 1_200,
            // A distinctive probe prompt lets the mock gate exactly the probe.
            probePrompt: "FF_PROBE_PROBE_ONLY",
            logLevel: "debug",
          },
        },
      ],
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
  });

  after(() => {
    if (mock) mock.kill("SIGKILL");
    if (home && process.env.FF_KEEP_HOME !== "1") rmSync(home, { recursive: true, force: true });
  });

  function offpeakConfig(policy) {
    writeJson(path.join(home, "config", "opencode", "offpeak.json"), {
      schemaVersion: 1,
      enabled: true,
      mode: "auto",
      displayTimeZone: "UTC",
      ...(policy === undefined ? {} : { policies: [policy] }),
    });
  }

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
    };
    await fetch(`http://127.0.0.1:${port}/__control`, {
      method: "POST",
      headers: { "content-type": "application/json", connection: "close" },
      body: JSON.stringify({
        log: patch.log ?? [],
        resetCounters: true,
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
    assert.deepEqual(models(state), ["ff-free", "ff-free"], "only the free model was used");
    assert.match(result.stdout, /MOCK_OK model=ff-free/);
    assert.doesNotMatch(result.stdout, /fallback selected/);
    assert.doesNotMatch(result.stdout, /free rate limit detected/);
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
      // Give the engine a moment to run the fail-open recovery.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
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
});

function assertOk(result) {
  if (result.status !== 0) {
    throw new Error(`opencode run failed (${result.status}):\n${result.stdout.slice(-4_000)}`);
  }
}
