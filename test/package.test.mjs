import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

describe("package shape", () => {
  it("declares the OpenCode support range it is tested against", () => {
    assert.equal(pkg.engines.opencode, ">=2.0.26 <2.1.0");
    assert.equal(pkg.dependencies["@opencode/plugin"], "2.0.26");
  });

  it("keeps the runtime entrypoints the host resolves", () => {
    assert.equal(pkg.main, "./src/server.ts");
    assert.equal(pkg.exports["."].bun, "./src/server.ts");
    assert.equal(pkg.exports["."].import, "./dist/server.js");
    assert.equal(pkg.exports["./server"].bun, "./src/server.ts");
    // A directory install resolves `<dir>/server` and `<dir>/index`.
    assert.ok(existsSync(path.join(root, "server.ts")));
    assert.ok(existsSync(path.join(root, "index.ts")));
  });

  it("ships the sources the host executes and the compiled fallback", () => {
    for (const file of [
      "src/server.ts",
      "src/engine.ts",
      "src/classify.ts",
      "src/health.ts",
      "src/config.ts",
      "src/log.ts",
      "src/rpc.ts",
      "src/types.ts",
      "dist/server.js",
      "dist/index.js",
      "dist/index.d.ts",
    ]) {
      assert.ok(existsSync(path.join(root, file)), `missing ${file}`);
    }
  });

  it("publishes no secrets and no machine-specific paths", () => {
    const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    assert.ok(files.length > 0);
    // The test suite itself contains deliberate fake credentials.
    const subjects = files.filter((file) => !file.startsWith("test/"));
    for (const file of subjects) {
      const text = readFileSync(path.join(root, file), "utf8");
      assert.equal(/sk-[A-Za-z0-9]{16,}/.test(text), false, `${file} looks like it holds a key`);
      assert.equal(
        /\/root\/agent-tmp|\/root\/mcp-shared/.test(text),
        false,
        `${file} leaks a host-only path`,
      );
      assert.equal(
        /(?:api[_-]?key|token|secret)\s*[:=]\s*["'][^"']{12,}["']/i.test(text),
        false,
        `${file} looks like it holds a credential`,
      );
    }
  });

  it("keeps the runtime free of paid routing and provider proxies", () => {
    const sources = execFileSync("git", ["ls-files", "src"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    for (const file of sources) {
      const text = readFileSync(path.join(root, file), "utf8");
      for (const forbidden of [
        /\bfetch\s*\(/, // never talks to a provider itself
        /process\.env\[/,
        /baseURL\s*[:=]/,
        /createServer\(/,
        /new Redis|ioredis|sqlite|node:sqlite/,
        /systemd|daemonize/,
      ]) {
        assert.equal(forbidden.test(text), false, `${file} matches ${forbidden}`);
      }
    }
  });

  it("keeps the import graph inside the package", () => {
    for (const file of execFileSync("git", ["ls-files", "src"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter(Boolean)) {
      const text = readFileSync(path.join(root, file), "utf8");
      const specifiers = [...text.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
      for (const specifier of specifiers) {
        assert.ok(
          specifier.startsWith("./") ||
            specifier === "@opencode/plugin" ||
            specifier.startsWith("node:"),
          `${file} imports ${specifier}`,
        );
      }
    }
  });

  it("declares a license and a public repository", () => {
    assert.equal(pkg.license, "MIT");
    assert.match(pkg.repository.url, /^https:\/\/github\.com\//);
  });
});
