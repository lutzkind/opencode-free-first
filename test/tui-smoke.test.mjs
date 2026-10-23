/**
 * Real-TUI smoke test for the native `/free-first` controls.
 *
 * It starts the current production OpenCode binary in a private XDG home, loads
 * the packed opencode-free-first package beside the real opencode-offpeak
 * checkout, and drives the TUI through tmux. No model is called: every command
 * is a local RPC/status operation, so no Free quota or paid tokens are spent.
 *
 * Opt in with `FF_TUI_SMOKE=1 npm run test:tui`. It skips automatically when
 * tmux, the OpenCode binary, or the neighbour checkout is unavailable.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENABLED = process.env.FF_TUI_SMOKE === "1";
const OFFPEAK = process.env.FF_OFFPEAK_CHECKOUT ?? "/root/opencode-offpeak";
const opencodeBin =
  process.env.FF_OPENCODE ??
  (existsSync("/root/.opencode/bin/opencode") ? "/root/.opencode/bin/opencode" : "opencode");

async function hasBinary(binary) {
  if (path.isAbsolute(binary)) return existsSync(binary);
  try {
    await exec("which", [binary]);
    return true;
  } catch {
    return false;
  }
}

const available =
  ENABLED &&
  (await hasBinary(opencodeBin)) &&
  (await hasBinary("tmux")) &&
  existsSync(path.join(OFFPEAK, "package.json"));
const skip = available
  ? false
  : "requires FF_TUI_SMOKE=1, the OpenCode v2 CLI, tmux, and the opencode-offpeak checkout";

function tmux(socket, args, options = {}) {
  return exec("tmux", ["-L", socket, ...args], options);
}

async function waitFor(check, message, timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  assert.fail(`${message} (last: ${last})`);
}

function versionInRange(version) {
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (match === null) return false;
  const [, major, minor, patch] = match.map(Number);
  const atLeast = major > 2 || (major === 2 && (minor > 0 || (minor === 0 && patch >= 26)));
  const below = major < 2 || (major === 2 && minor < 2);
  return atLeast && below;
}

test("the real OpenCode TUI switches Free First, Peak Only, and Disabled, and persists the choice", {
  skip,
  timeout: 300_000,
}, async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "opencode-free-first-tui-"));
  const socket = `free-first-smoke-${process.pid}`;
  const configDir = path.join(tmp, "config");
  const dataDir = path.join(tmp, "data");
  const cacheDir = path.join(tmp, "cache");
  const stateDir = path.join(tmp, "state");
  const projectDir = path.join(tmp, "project");
  let session = "smoke";

  const env = [
    `XDG_CONFIG_HOME=${path.join(tmp, "xdg-config")}`,
    `XDG_DATA_HOME=${dataDir}`,
    `XDG_CACHE_HOME=${cacheDir}`,
    `XDG_STATE_HOME=${stateDir}`,
    `OPENCODE_CONFIG_DIR=${configDir}`,
    "OPENCODE_DISABLE_AUTOUPDATE=true",
  ].join(" ");
  const startTui = async () => {
    await tmux(socket, [
      "new-session",
      "-d",
      "-s",
      session,
      "-x",
      "150",
      "-y",
      "50",
      "-c",
      projectDir,
      `${env} ${opencodeBin} --standalone`,
    ]);
    const logPath = path.join(dataDir, "opencode", "log", "opencode.log");
    const log = async () => {
      try {
        return await readFile(logPath, "utf8");
      } catch {
        return "";
      }
    };
    const pane = async () => {
      const captured = await tmux(socket, ["capture-pane", "-t", session, "-p"]);
      return captured.stdout;
    };
    await waitFor(
      async () => (await log()).includes("plugin reconciliation completed"),
      "TUI plugin reconciliation did not complete",
    );
    await waitFor(
      async () => (await pane()).includes("Ask anything"),
      "the OpenCode TUI did not finish starting",
    );
    return { log, pane };
  };
  const send = async (text) => {
    await tmux(socket, ["send-keys", "-t", session, "-l", text]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await tmux(socket, ["send-keys", "-t", session, "Enter"]);
  };
  const stopTui = async () => {
    await tmux(socket, ["kill-session", "-t", session]).catch(() => undefined);
    await exec("tmux", ["-L", socket, "kill-server"]).catch(() => undefined);
  };

  try {
    for (const dir of [
      configDir,
      dataDir,
      cacheDir,
      stateDir,
      path.join(tmp, "xdg-config"),
      projectDir,
    ]) {
      await mkdir(dir, { recursive: true });
    }

    const packed = await exec("npm", ["pack", "--json", "--pack-destination", tmp], {
      cwd: root,
    });
    const packedJson = JSON.parse(packed.stdout);
    const entry = Array.isArray(packedJson) ? packedJson[0] : Object.values(packedJson)[0];
    const extract = path.join(tmp, "extract");
    await mkdir(extract, { recursive: true });
    await exec("tar", ["-xzf", path.join(tmp, entry.filename), "-C", extract]);
    const packageDir = path.join(extract, "package");

    await writeFile(
      path.join(configDir, "opencode.json"),
      `${JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          permissions: [{ action: "*", resource: "*", effect: "allow" }],
          websearch: false,
          plugins: [
            OFFPEAK,
            {
              package: packageDir,
              options: {
                primary: { providerID: "opencode", id: "deepseek-v4.1-flash-free" },
                fallback: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
                freeUsageMode: "peak-only",
                preferAsDefault: false,
                logLevel: "info",
              },
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const version = (await exec(opencodeBin, ["--version"])).stdout.trim();
    assert.ok(
      versionInRange(version),
      `installed OpenCode ${version} is outside the declared support range`,
    );

    const first = await startTui();
    const firstLog = await first.log();
    assert.ok(
      firstLog.includes("opencode-free-first") && firstLog.includes(packageDir),
      "the packed package did not load as a server plugin",
    );
    assert.doesNotMatch(firstLog, /Keymap\.Provider is missing/);
    assert.doesNotMatch(firstLog, /plugin operation failed/);

    await send("/free-first status");
    await waitFor(
      async () => (await first.pane()).includes("Mode: Peak Only"),
      "/free-first status did not show the configured Peak Only mode",
    );

    await send("/free-first");
    // The first Enter accepts the slash completion; the second opens the
    // selector. This is the host's completion behaviour, not the plugin's.
    await tmux(socket, ["send-keys", "-t", session, "Enter"]);
    await waitFor(async () => {
      const pane = await first.pane();
      return (
        pane.includes("Free-first mode") &&
        pane.includes("Free First") &&
        pane.includes("Peak Only") &&
        pane.includes("Disable Free-first")
      );
    }, "the native mode selector did not open");
    await tmux(socket, ["send-keys", "-t", session, "Escape"]);
    await waitFor(
      async () => !(await first.pane()).includes("Free-first mode"),
      "the native mode selector did not close",
    );

    await send("/free-first mode free-first");
    await new Promise((resolve) => setTimeout(resolve, 700));
    await send("/free-first status");
    await waitFor(
      async () => (await first.pane()).includes("Mode: Free First (saved in OpenCode)"),
      "status did not reflect the saved Free First mode",
    );

    // /offpeak off is a different control and must not change free-first.
    await send("/offpeak off");
    await waitFor(
      async () => (await first.pane()).includes("OpenCode Offpeak is OFF"),
      "/offpeak off did not report its own state",
    );
    await send("/free-first status");
    await waitFor(
      async () => (await first.pane()).includes("Mode: Free First (saved in OpenCode)"),
      "/offpeak off changed the free-first mode",
    );
    await send("/offpeak on");

    // Restart the standalone server/TUI: the choice must survive.
    await stopTui();
    session = "smoke-restarted";
    const second = await startTui();
    await send("/free-first status");
    await waitFor(
      async () => (await second.pane()).includes("Mode: Free First (saved in OpenCode)"),
      "the saved mode did not survive an OpenCode restart",
    );

    await send("/free-first mode disabled");
    await new Promise((resolve) => setTimeout(resolve, 700));
    await send("/free-first status");
    await waitFor(async () => {
      const pane = await second.pane();
      return (
        pane.includes("Mode: Free-first disabled") &&
        pane.includes("/offpeak off is a different control")
      );
    }, "disabled mode was not clearly differentiated from /offpeak off");

    await send("/free-first mode peak-only");
    await new Promise((resolve) => setTimeout(resolve, 700));
    await send("/free-first status");
    await waitFor(
      async () => (await second.pane()).includes("Mode: Peak Only (saved in OpenCode)"),
      "restoring Peak Only did not persist",
    );
    await send("/free-first mode configured");
    await new Promise((resolve) => setTimeout(resolve, 700));
    await send("/free-first status");
    await waitFor(
      async () => (await second.pane()).includes("Mode: Peak Only (configured)"),
      "the TUI did not return to the configured Peak Only mode",
    );

    const secondLog = await second.log();
    assert.doesNotMatch(secondLog, /Keymap\.Provider is missing/);
    assert.doesNotMatch(secondLog, /plugin operation failed/);
  } finally {
    await stopTui();
    await rm(tmp, { recursive: true, force: true });
  }
});
