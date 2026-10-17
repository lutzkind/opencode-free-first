import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyFreeLimit,
  classifyFreeRouteRejection,
  classifyProbeFailure,
  extractReset,
  parseDelay,
  parseResetValue,
} from "../dist/classify.js";

const FREE_ROUTE_GATE =
  "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building.";

describe("classifyFreeLimit", () => {
  it("recognises a bare HTTP 429", () => {
    assert.deepEqual(classifyFreeLimit({ status: 429 }), {
      limited: true,
      kind: "rate-limit",
      reason: "http-429",
    });
  });

  it("recognises the structured rate-limit type", () => {
    const verdict = classifyFreeLimit({ type: "provider.rate-limit", message: "nope" });
    assert.equal(verdict.limited, true);
    assert.equal(verdict.reason, "structured-rate-limit");
  });

  it("recognises the structured quota type", () => {
    const verdict = classifyFreeLimit({ type: "provider.quota", message: "nope" });
    assert.equal(verdict.limited, true);
    assert.equal(verdict.kind, "quota");
  });

  it("recognises the observed free-tier message", () => {
    const verdict = classifyFreeLimit({
      message: "Rate limit exceeded. Please try again later.",
    });
    assert.equal(verdict.limited, true);
  });

  it("recognises explicit quota exhaustion phrasings", () => {
    for (const message of [
      "You have exceeded your rate limit",
      "Too many requests",
      "Daily quota reached",
      "usage limit exceeded",
      "insufficient credits",
      "free tier limit reached",
      "requests per minute exceeded",
    ]) {
      assert.equal(classifyFreeLimit({ message }).limited, true, message);
    }
  });

  it("never classifies an unrelated 400 as a rate limit", () => {
    const verdict = classifyFreeLimit({
      type: "provider.invalid-request",
      status: 400,
      message: "invalid request: messages[0].role is required",
    });
    assert.equal(verdict.limited, false);
    assert.equal(verdict.reason, "structured-provider.invalid-request");
  });

  it("never classifies a 401 as a rate limit", () => {
    assert.equal(
      classifyFreeLimit({ type: "provider.auth", status: 401, message: "authentication failed" })
        .limited,
      false,
    );
  });

  it("never classifies a 403 authorization failure as a rate limit", () => {
    assert.equal(
      classifyFreeLimit({ status: 403, message: "forbidden: model not available" }).limited,
      false,
    );
  });

  it("never classifies a generic 500 as exhausted quota", () => {
    const verdict = classifyFreeLimit({
      type: "provider.internal",
      status: 500,
      message: "Internal server error",
    });
    assert.equal(verdict.limited, false);
  });

  it("never classifies a malformed-context or tool failure as a rate limit", () => {
    assert.equal(classifyFreeLimit({ message: "malformed context" }).limited, false);
    assert.equal(classifyFreeLimit({ message: "tool execution failed" }).limited, false);
    assert.equal(classifyFreeLimit({ message: "maximum context length exceeded" }).limited, false);
    assert.equal(classifyFreeLimit({ message: "invalid model configuration" }).limited, false);
    assert.equal(
      classifyFreeLimit({ type: "provider.transport", message: "socket hang up" }).limited,
      false,
    );
  });

  it("never classifies a plugin bug as a rate limit", () => {
    assert.equal(
      classifyFreeLimit({ type: "unknown", message: "TypeError: x is not a fn" }).limited,
      false,
    );
  });

  it("does not treat a missing signal as a limit", () => {
    assert.equal(classifyFreeLimit(undefined).limited, false);
    assert.equal(classifyFreeLimit({}).limited, false);
    assert.equal(classifyFreeLimit({ message: "" }).limited, false);
  });

  it("is false-positive resistant on near-miss wording", () => {
    for (const message of [
      "rate limiter initialised",
      "the request was not rate limited",
      "quota configuration accepted",
      "limit: 100 requests per minute allowed",
    ]) {
      assert.equal(classifyFreeLimit({ message }).limited, false, message);
    }
  });

  it("prefers a structured non-limit type over a rate-limit phrase", () => {
    const verdict = classifyFreeLimit({
      type: "provider.invalid-request",
      message: "rate limit exceeded",
    });
    assert.equal(verdict.limited, false);
  });
});

describe("classifyFreeRouteRejection", () => {
  it("recognises the exact free-tier eligibility gate", () => {
    assert.deepEqual(classifyFreeRouteRejection({ message: FREE_ROUTE_GATE }), {
      rejected: true,
      reason: "free-tier-provenance-gate",
    });
    // The live incident delivered it as a 403 authentication-class refusal.
    assert.equal(
      classifyFreeRouteRejection({ type: "provider.auth", status: 403, message: FREE_ROUTE_GATE })
        .rejected,
      true,
    );
  });

  it("stays narrow: a generic 403, 401, or auth failure never matches", () => {
    for (const error of [
      { type: "provider.auth", status: 403, message: "Forbidden" },
      { type: "provider.auth", status: 401, message: "Invalid API key provided" },
      { type: "provider.auth", status: 403, message: "permission denied" },
      { type: "provider.invalid-request", status: 400, message: "malformed request" },
      { type: "provider.quota", status: 402, message: "insufficient credits" },
      { status: 429, message: "Rate limit exceeded. Please try again later." },
    ]) {
      assert.equal(classifyFreeRouteRejection(error).rejected, false, JSON.stringify(error));
    }
    assert.equal(classifyFreeRouteRejection(undefined).rejected, false);
    assert.equal(classifyFreeRouteRejection({}).rejected, false);
    assert.equal(classifyFreeRouteRejection({ message: "" }).rejected, false);
  });

  it("keeps the same text a probe-path refusal on the probe and a rejection on a real request", () => {
    // The identical sentence means different things on the two paths: the
    // transient generation probe is refused structurally (unsupported), while a
    // real model request tells us the free route is temporarily unavailable.
    assert.equal(
      classifyProbeFailure({ tag: "Generate.UnavailableError", message: FREE_ROUTE_GATE }),
      "unsupported",
    );
    assert.equal(classifyFreeRouteRejection({ message: FREE_ROUTE_GATE }).rejected, true);
    // And the rate-limit classifier never sees it as exhaustion.
    assert.equal(classifyFreeLimit({ message: FREE_ROUTE_GATE }).limited, false);
  });
});

describe("extractReset", () => {
  const now = 1_700_000_000_000;

  it("honours Retry-After in seconds", () => {
    const reset = extractReset({ now, headers: { "retry-after": "30" } });
    assert.deepEqual(reset, { until: now + 30_000, source: "retry-after" });
  });

  it("honours Retry-After as an HTTP date", () => {
    const date = new Date(now + 45_000).toUTCString();
    const reset = extractReset({ now, headers: { "retry-after": date } });
    assert.equal(reset.source, "retry-after");
    assert.equal(reset.until, Date.parse(date));
  });

  it("honours retry-after-ms as milliseconds", () => {
    const reset = extractReset({ now, headers: { "retry-after-ms": "2500" } });
    assert.deepEqual(reset, { until: now + 2_500, source: "retry-after-ms" });
  });

  it("prefers Retry-After over a reset header", () => {
    const reset = extractReset({
      now,
      headers: { "retry-after": "10", "x-ratelimit-reset": String((now + 90_000) / 1000) },
    });
    assert.equal(reset.source, "retry-after");
    assert.equal(reset.until, now + 10_000);
  });

  it("honours an explicit reset header", () => {
    const reset = extractReset({
      now,
      headers: { "x-ratelimit-reset": String((now + 120_000) / 1000) },
    });
    assert.deepEqual(reset, { until: now + 120_000, source: "x-ratelimit-reset" });
  });

  it("honours a Go duration in a reset header", () => {
    const reset = extractReset({ now, headers: { "x-ratelimit-reset-requests": "1m30s" } });
    assert.equal(reset.until, now + 90_000);
  });

  it("honours a reset timestamp in the error payload", () => {
    const until = new Date(now + 300_000).toISOString();
    const reset = extractReset({
      now,
      headers: {},
      body: JSON.stringify({ error: { message: "limited", reset_at: until } }),
    });
    assert.deepEqual(reset, { until: Date.parse(until), source: "reset-timestamp" });
  });

  it("honours a retry_after field in the error payload", () => {
    const reset = extractReset({ now, body: JSON.stringify({ error: { retry_after: 12 } }) });
    assert.deepEqual(reset, { until: now + 12_000, source: "reset-timestamp" });
  });

  it("honours a relative phrase in the message", () => {
    const reset = extractReset({ now, message: "Rate limit exceeded. Try again in 20 seconds." });
    assert.deepEqual(reset, { until: now + 20_000, source: "retry-after" });
  });

  it("returns undefined when the provider gives no reset information", () => {
    assert.equal(
      extractReset({
        now,
        headers: {},
        message: "Rate limit exceeded. Please try again later.",
      }),
      undefined,
    );
  });

  it("parses delay and reset helpers defensively", () => {
    assert.equal(parseDelay("not-a-number", now), undefined);
    assert.equal(parseDelay("-5", now), undefined);
    assert.equal(parseResetValue("", now), undefined);
    assert.equal(parseResetValue("nonsense", now), undefined);
  });
});
