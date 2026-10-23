/**
 * Live mode-switch integration: the real OpenCode 2.1 server, the real
 * opencode-offpeak release, and a deterministic mock provider.
 *
 * It proves the properties unit tests cannot: a mode selected over the control
 * RPC changes what the real runner dispatches, Peak Only sends zero Free
 * requests off-peak, Free First restores the historical route, the choice
 * survives a server restart, and Disabled stops management without touching
 * the neighbour plugin.
 *
 *   FF_INTEGRATION=1 node --test test/mode-integration.test.mjs
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ENABLED = process.env.FF_INTEGRATION === "1";
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const OFFPEAK_SPEC =
  process.env.FF_OFFPEAK_SPEC ?? "git+https://github.com/lutzkind/opencode-offpeak.git#v0.2.0";
const PASSWORD = "ff-mode-integration-password";

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

function pad(value) {
  return String(value).padStart(2, "0");
}

/** A recurring one-minute PEAK window three hours away, so the test is off-peak. */
function offpeakPolicy() {
  const start = (new Date().getUTCHours() + 3) % 24;
  return {
    id: "ffmock-mode-peak",
    providers: ["ffmock"],
    models: ["ff-paid"],
    flatModels: ["ff-free"],
    timeZone: "UTC",
    blocked: [{ days: [0, 1, 2, 3, 4, 5, 6], start: `${pad(start)}:00`, end: `${pad(start)}:01` }],
    multiplier: 2,
    source: "mode integration test",
  };
}

describe("live mode switching", { skip: !ENABLED }, () => {
  let home;
  let mock;
  let mockPort;
  let server;
  let serverURL;
  const opencode = opencodeBinary();

  const env = () => ({
    ...process.env,
    OPENCODE_PASSWORD: PASSWORD,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_STATE_HOME: path.join(home, "state"),
    OPENCODE_DISABLE_AUTOUPDATE: "true",
  });

  async function startServer() {
    const port = await freePort();
    serverURL = `http://127.0.0.1:${port}`;
    const child = spawn(opencode, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: path.join(home, "project"),
      env: env(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const log = createWriteStream(path.join(home, "server.log"), { flags: "a" });
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      log.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
      log.write(chunk);
    });
    const deadline = Date.now() + 60_000;
    while (!output.includes("server listening on")) {
      if (child.exitCode !== null) {
        throw new Error(`opencode serve exited early:\n${output.slice(-4_000)}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`opencode serve did not start:\n${output.slice(-4_000)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    server = child;
  }

  async function stopServer() {
    if (server === undefined) return;
    const child = server;
    server = undefined;
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    const exited = new Promise((resolve) => child.once("exit", resolve));
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }

  function api(args) {
    const result = spawnSync(opencode, ["api", "--server", serverURL, ...args], {
      env: env(),
      cwd: path.join(home, "project"),
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(
      result.status,
      0,
      `opencode api failed: ${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
    return JSON.parse(result.stdout);
  }

  function control(patch = {}) {
    const body = JSON.stringify({ input: patch });
    return api(["post", "/api/rpc/opencode-free-first/control", "--data", body]).output;
  }

  function setMode(mode) {
    return control({ action: "set-mode", mode });
  }

  function clearMode() {
    return control({ action: "clear-mode" });
  }

  function status() {
    return control({ action: "status" }).status;
  }

  function run(prompt, extra = []) {
    const result = spawnSync(
      opencode,
      ["run", "--server", serverURL, "--log-level", "debug", "--print-logs", ...extra, prompt],
      {
        cwd: path.join(home, "project"),
        env: env(),
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    return { status: result.status, stdout: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  }

  async function mockControl(patch) {
    const baseline = {
      mode: "ok",
      failFirst: null,
      body: undefined,
      retryAfterSeconds: undefined,
      delayMs: 0,
      gateProbe: false,
      onlyWithTools: false,
    };
    await fetch(`http://127.0.0.1:${mockPort}/__control`, {
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
    const response = await fetch(`http://127.0.0.1:${mockPort}/__state`, {
      headers: { connection: "close" },
    });
    return response.json();
  }

  function requests(state, role) {
    return state.log.filter((entry) => entry.event === "request" && entry.role === role);
  }

  before(async () => {
    mockPort = await freePort();
    home = path.join(os.tmpdir(), `ff-mode-integration-${Date.now()}`);
    for (const dir of ["config", "data", "cache", "state", "project"]) {
      mkdirSync(path.join(home, dir), { recursive: true });
    }

    mock = spawn(process.execPath, [path.join(here, "support", "mock-provider.mjs")], {
      env: { ...process.env, FF_MOCK_PORT: String(mockPort) },
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
            probePrompt: "FF_PROBE_PROBE_ONLY",
            freeUsageMode: "peak-only",
            logLevel: "debug",
          },
        },
      ],
      providers: {
        ffmock: {
          name: "FF Mock",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: `http://127.0.0.1:${mockPort}/v1`, apiKey: "ffmock-key" },
          models: {
            "ff-free": { name: "FF Free", limit: { context: 200_000, output: 8_192 } },
            "ff-paid": { name: "FF Paid", limit: { context: 200_000, output: 8_192 } },
          },
        },
      },
    });
    writeJson(path.join(home, "config", "opencode", "offpeak.json"), {
      schemaVersion: 1,
      enabled: true,
      mode: "auto",
      displayTimeZone: "UTC",
      policies: [offpeakPolicy()],
    });
  });

  after(async () => {
    await stopServer();
    if (mock) mock.kill("SIGKILL");
    if (home && process.env.FF_KEEP_HOME !== "1") rmSync(home, { recursive: true, force: true });
  });

  it("drives real routing from Peak Only to Free First and back, and survives a restart", async () => {
    await startServer();

    const initial = status();
    assert.equal(initial.freeUsageMode, "peak-only");
    assert.equal(initial.freeUsageModeSource, "config");
    assert.equal(initial.pricingState, "OFF_PEAK", "the test policy must be off-peak");

    await mockControl({});
    const peakOnly = run("Reply with the word READY");
    assert.equal(peakOnly.status, 0, peakOnly.stdout.slice(-4_000));
    let state = await mockState();
    assert.equal(requests(state, "free").length, 0, "Peak Only spent no Free request off-peak");
    assert.ok(requests(state, "paid").length > 0, "Peak Only used Go");

    const freeFirst = setMode("free-first");
    assert.equal(freeFirst.mode, "always-free-first");
    assert.equal(status().freeUsageModeSource, "override");

    await mockControl({});
    const freeRun = run("Reply with the word READY");
    assert.equal(freeRun.status, 0, freeRun.stdout.slice(-4_000));
    state = await mockState();
    assert.ok(
      requests(state, "free").length > 0,
      `Free First used Free off-peak; requests=${JSON.stringify(
        state.log.filter((entry) => entry.event === "request").map((entry) => entry.model),
      )} status=${JSON.stringify(status())}`,
    );
    assert.equal(requests(state, "paid").length, 0);

    const peakAgain = setMode("peak-only");
    assert.equal(peakAgain.mode, "peak-only");
    await mockControl({});
    const peakRun = run("Reply with the word READY");
    assert.equal(peakRun.status, 0, peakRun.stdout.slice(-4_000));
    state = await mockState();
    assert.equal(requests(state, "free").length, 0, "the switch back to Peak Only stopped Free");
    assert.ok(requests(state, "paid").length > 0);

    // A genuine cooldown is health evidence, not policy: switching modes must
    // not invent or discard it.
    setMode("free-first");
    await mockControl({
      free: { mode: "429", failFirst: 1, retryAfterSeconds: 120, onlyWithTools: true },
    });
    const limited = run("Reply with the word READY");
    assert.equal(limited.status, 0, limited.stdout.slice(-4_000));
    const cooling = status();
    assert.equal(cooling.cooldownReason, "rate-limit");
    assert.ok(cooling.cooldownEndsAt > Date.now());
    setMode("peak-only");
    assert.equal(status().cooldownEndsAt, cooling.cooldownEndsAt);

    // Restart the real server; the saved choice is the only source of truth.
    await stopServer();
    await startServer();
    const restarted = status();
    assert.equal(restarted.freeUsageMode, "peak-only");
    assert.equal(restarted.freeUsageModeSource, "override");

    // Disabled stops management. The configured baseline model is Go, so a
    // successful turn proves free-first did not rewrite the default or route.
    setMode("disabled");
    const disabled = status();
    assert.equal(disabled.freeUsageMode, "off");
    assert.equal(disabled.routingActive, false);
    assert.equal(disabled.activeRoute, "NONE");
    await mockControl({});
    const disabledRun = run("Reply with the word READY", ["--model", "ffmock/ff-paid"]);
    assert.equal(disabledRun.status, 0, disabledRun.stdout.slice(-4_000));
    state = await mockState();
    assert.equal(requests(state, "free").length, 0, "Disabled did not route to Free");
    assert.ok(requests(state, "paid").length > 0, "ordinary OpenCode routing served the turn");
    assert.equal(status().transitions.length, 0, "Disabled did not manage the model");

    // Back to production's configured mode and remove the saved test choice.
    setMode("peak-only");
    const cleared = clearMode();
    assert.equal(cleared.mode, "peak-only");
    const final = status();
    assert.equal(final.freeUsageMode, "peak-only");
    assert.equal(final.freeUsageModeSource, "config");
  });
});
