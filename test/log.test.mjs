import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLogger, scrub } from "../dist/log.js";

describe("scrub", () => {
  it("redacts anything that looks like a credential", () => {
    const scrubbed = scrub({
      apiKey: "sk-live-1234567890",
      authorization: "Bearer abc",
      nested: { access_token: "xyz", safe: "value" },
    });
    assert.equal(scrubbed.apiKey, "[redacted]");
    assert.equal(scrubbed.authorization, "[redacted]");
    assert.equal(scrubbed.nested.access_token, "[redacted]");
    assert.equal(scrubbed.nested.safe, "value");
  });

  it("never logs a response body or a header map", () => {
    const scrubbed = scrub({
      status: 429,
      response: { body: '{"error":"secret prompt text"}' },
      headers: { authorization: "Bearer abc" },
    });
    assert.equal(scrubbed.response, "[omitted]");
    assert.equal(scrubbed.headers, "[omitted]");
    assert.equal(scrubbed.status, 429);
  });

  it("bounds long strings", () => {
    const scrubbed = scrub({ message: "x".repeat(5_000) });
    assert.ok(scrubbed.message.length < 300);
    assert.match(scrubbed.message, /chars\)$/);
  });

  it("bounds depth and array length", () => {
    const deep = { a: { b: { c: { d: { e: { f: "too deep" } } } } } };
    assert.ok(JSON.stringify(scrub(deep)).length < 200);
    const wide = scrub({ list: Array.from({ length: 100 }, (_, index) => index) });
    assert.equal(wide.list.length, 10);
  });

  it("passes primitives through", () => {
    assert.equal(scrub(1), 1);
    assert.equal(scrub(true), true);
    assert.equal(scrub(null), null);
    assert.equal(scrub(undefined), undefined);
  });
});

describe("createLogger", () => {
  function sink() {
    const lines = [];
    return { lines, write: (...args) => lines.push(args) };
  }

  it("emits a prefixed single line for a message without detail", () => {
    const out = sink();
    const logger = createLogger("info", out.write);
    logger.info("hello");
    assert.equal(out.lines.length, 1);
    assert.equal(out.lines[0][0], "[opencode-free-first] hello");
    assert.equal(out.lines[0].length, 1);
  });

  it("honours the configured level", () => {
    const errorOnly = sink();
    const logger = createLogger("error", errorOnly.write);
    logger.info("quiet");
    logger.debug("quieter");
    logger.error("loud");
    assert.deepEqual(
      errorOnly.lines.map((line) => line[0]),
      ["[opencode-free-first] loud"],
    );
  });

  it("stays silent at the silent level", () => {
    const out = sink();
    const logger = createLogger("silent", out.write);
    logger.error("nothing");
    logger.info("nothing");
    logger.debug("nothing");
    assert.equal(out.lines.length, 0);
    assert.equal(logger.enabled("error"), false);
  });

  it("reports whether a level would be emitted", () => {
    const logger = createLogger("info", () => {});
    assert.equal(logger.enabled("error"), true);
    assert.equal(logger.enabled("info"), true);
    assert.equal(logger.enabled("debug"), false);
  });

  it("redacts secrets in log detail", () => {
    const out = sink();
    const logger = createLogger("debug", out.write);
    logger.debug("detail", { apiKey: "sk-live-abcdefghijkl", sessionID: "ses_x" });
    assert.match(out.lines[0][0], /detail/);
    assert.equal(out.lines[0][1].apiKey, "[redacted]");
    assert.equal(out.lines[0][1].sessionID, "ses_x");
  });
});
