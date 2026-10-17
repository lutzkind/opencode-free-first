import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  configFilePath,
  DEFAULT_CONFIG,
  DEFAULT_PRIMARY,
  resolveConfig,
  validateConfig,
} from "../dist/config.js";

describe("validateConfig", () => {
  it("accepts an empty configuration", () => {
    const result = validateConfig({});
    assert.equal(result.error, undefined);
    assert.deepEqual(result.config, DEFAULT_CONFIG);
    assert.deepEqual(result.config.primary, DEFAULT_PRIMARY);
    assert.equal(result.config.fallback, undefined);
    assert.equal(result.config.enabled, true);
    assert.equal(result.config.respectExplicitModelSelection, true);
    assert.equal(result.config.preferAsDefault, true);
    assert.equal(result.config.parkPreemption, true);
    assert.equal(result.config.probe, true);
    assert.equal(result.config.jitterRatio, 0.1);
  });

  it("accepts the documented public option shape", () => {
    const result = validateConfig({
      enabled: true,
      primary: { providerID: "opencode", id: "deepseek-v4.1-flash-free", variant: "max" },
      fallback: { providerID: "opencode-go", id: "deepseek-v4.1-flash", variant: "max" },
      backoffMs: [60_000, 120_000],
      maxCooldownMs: 900_000,
      jitterRatio: 0.2,
      logLevel: "debug",
    });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.config.primary, {
      providerID: "opencode",
      id: "deepseek-v4.1-flash-free",
      variant: "max",
    });
    assert.deepEqual(result.config.fallback, {
      providerID: "opencode-go",
      id: "deepseek-v4.1-flash",
      variant: "max",
    });
    assert.deepEqual(result.config.backoffMs, [60_000, 120_000]);
  });

  it("accepts the provider/model string form", () => {
    const result = validateConfig({ primary: "opencode/deepseek-v4.1-flash-free" });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.config.primary, {
      providerID: "opencode",
      id: "deepseek-v4.1-flash-free",
    });
  });

  it("rejects an empty backoff ladder", () => {
    const result = validateConfig({ backoffMs: [] });
    assert.match(result.error, /backoffMs/);
  });

  it("rejects a cooldown scope outside the supported set", () => {
    assert.match(validateConfig({ cooldownScope: "global" }).error, /cooldownScope/);
  });

  it("rejects an unknown log level", () => {
    assert.match(validateConfig({ logLevel: "loud" }).error, /logLevel/);
  });

  it("rejects a malformed model reference", () => {
    assert.match(validateConfig({ primary: { providerID: "opencode" } }).error, /primary\.id/);
    assert.match(validateConfig({ primary: "" }).error, /primary/);
    assert.match(validateConfig({ primary: { providerID: "", id: "x" } }).error, /providerID/);
  });

  it("rejects out-of-range numbers", () => {
    assert.match(validateConfig({ jitterRatio: 2 }).error, /jitterRatio/);
    assert.match(validateConfig({ maxCooldownMs: -1 }).error, /maxCooldownMs/);
    assert.match(validateConfig({ failoverRetryDelayMs: "fast" }).error, /failoverRetryDelayMs/);
    assert.match(validateConfig({ routeRejectRetryMs: "soon" }).error, /routeRejectRetryMs/);
    assert.match(validateConfig({ routeRejectRetryMs: 0 }).error, /routeRejectRetryMs/);
  });

  it("accepts a free-route retry window", () => {
    const result = validateConfig({ routeRejectRetryMs: 600_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.config.routeRejectRetryMs, 600_000);
    assert.equal(DEFAULT_CONFIG.routeRejectRetryMs, 300_000);
  });

  it("rejects a non-boolean switch", () => {
    assert.match(validateConfig({ enabled: "yes" }).error, /enabled must be a boolean/);
  });

  it("rejects blank strings", () => {
    assert.match(validateConfig({ probePrompt: "   " }).error, /probePrompt/);
    assert.match(validateConfig({ continuationText: "" }).error, /continuationText/);
  });
});

describe("resolveConfig", () => {
  const env = { XDG_CONFIG_HOME: "/tmp/xdg" };

  it("returns the defaults when no file exists", () => {
    const resolved = resolveConfig({ options: undefined, env, readFile: () => undefined });
    assert.equal(resolved.error, undefined);
    assert.equal(resolved.source, undefined);
    assert.deepEqual(resolved.config, DEFAULT_CONFIG);
  });

  it("reads the optional config file and lets plugin options win", () => {
    const file = JSON.stringify({ logLevel: "error", jitterRatio: 0.25 });
    const resolved = resolveConfig({
      options: { jitterRatio: 0 },
      env,
      readFile: (path) => {
        assert.equal(path, configFilePath(env));
        return file;
      },
    });
    assert.equal(resolved.error, undefined);
    assert.equal(resolved.source, configFilePath(env));
    assert.equal(resolved.config.logLevel, "error");
    assert.equal(resolved.config.jitterRatio, 0);
  });

  it("accepts a freeFirst wrapper object", () => {
    const resolved = resolveConfig({
      options: undefined,
      env,
      readFile: () => JSON.stringify({ freeFirst: { enabled: false } }),
    });
    assert.equal(resolved.config.enabled, false);
  });

  it("fails open with a reported error on invalid JSON", () => {
    const resolved = resolveConfig({ options: undefined, env, readFile: () => "{oops" });
    assert.match(resolved.error, /not valid JSON/);
    assert.deepEqual(resolved.config, DEFAULT_CONFIG);
  });

  it("fails open with a reported error on a non-object document", () => {
    const resolved = resolveConfig({ options: undefined, env, readFile: () => "[]" });
    assert.match(resolved.error, /JSON object/);
  });

  it("fails open with a reported error on an invalid option", () => {
    const resolved = resolveConfig({
      options: { logLevel: "verbose" },
      env,
      readFile: () => undefined,
    });
    assert.match(resolved.error, /logLevel/);
    assert.equal(resolved.config.enabled, DEFAULT_CONFIG.enabled);
  });
});
