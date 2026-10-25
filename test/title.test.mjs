/**
 * Title compatibility.
 *
 * OpenCode's free tier rejects the tool-less automatic title request while the
 * tool-bearing agent loop succeeds (anomalyco/opencode#58176). These tests pin
 * the bounded repair: the title hook supplies the normalized first prompt on the
 * free route without a provider request, one settled turn later a tool-bearing
 * generation replaces it, and the upgrade can never overwrite a manual rename or
 * spend paid capacity.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyTitleFailure,
  cleanGeneratedTitle,
  isUntitled,
  promptTitle,
  TITLE_MAX_LENGTH,
  TitleCompatibility,
} from "../dist/title.js";

const FREE = { providerID: "opencode", id: "deepseek-v4.1-flash-free" };
const PAID = { providerID: "opencode-go", id: "deepseek-v4.1-flash" };
const PROMPT = "Fix the failing deployment pipeline in production";

function harness(overrides = {}) {
  const state = {
    spendable: true,
    firstUser: PROMPT,
    generated: ["Deploy pipeline repair"],
    generateError: undefined,
    info: { title: undefined, model: FREE },
    generateImpl: undefined,
    ...overrides,
  };
  const calls = [];
  const events = [];
  const logger = {
    error: (message, detail) => events.push({ level: "error", message, detail }),
    info: (message, detail) => events.push({ level: "info", message, detail }),
    debug: (message, detail) => events.push({ level: "debug", message, detail }),
    enabled: () => true,
  };
  const port = {
    async firstUserText(sessionID) {
      calls.push(["firstUserText", sessionID]);
      return state.firstUser;
    },
    async generate(input) {
      calls.push(["generate", input]);
      if (state.generateImpl !== undefined) return state.generateImpl(input);
      if (state.generateError !== undefined) throw state.generateError;
      return { text: state.generated.shift() ?? "" };
    },
    async get(input) {
      calls.push(["get", input.sessionID]);
      return state.info;
    },
    async rename(input) {
      calls.push(["rename", input]);
      state.info = { ...state.info, title: input.title };
    },
  };
  const titles = new TitleCompatibility({
    primary: FREE,
    sessions: port,
    routing: { freeRouteSpendable: () => state.spendable },
    logger,
  });
  return { titles, state, calls, events, port };
}

const generates = (calls) => calls.filter(([name]) => name === "generate");
const renames = (calls) => calls.filter(([name]) => name === "rename");

describe("title text", () => {
  it("collapses whitespace and keeps the upstream 100-character bound", () => {
    assert.equal(promptTitle("  Fix\n\n the\tdeploy  "), "Fix the deploy");
    assert.equal(promptTitle("   "), undefined);
    assert.equal(promptTitle(undefined), undefined);
    const long = promptTitle("x".repeat(400));
    assert.equal(long.length, TITLE_MAX_LENGTH);
    assert.ok(long.endsWith("..."));
  });

  it("keeps presentation out of a generated title", () => {
    assert.equal(cleanGeneratedTitle("Title: Deploy pipeline repair"), "Deploy pipeline repair");
    assert.equal(cleanGeneratedTitle('"Deploy pipeline repair"'), "Deploy pipeline repair");
    assert.equal(
      cleanGeneratedTitle("`Deploy pipeline repair`\nignored"),
      "Deploy pipeline repair",
    );
    assert.equal(cleanGeneratedTitle("\n\n   \n"), undefined);
    assert.equal(cleanGeneratedTitle(undefined), undefined);
    assert.equal(cleanGeneratedTitle("y".repeat(400)).length, TITLE_MAX_LENGTH);
  });

  it("treats OpenCode's historical timestamped title as untitled", () => {
    assert.equal(isUntitled(undefined), true);
    assert.equal(isUntitled(""), true);
    assert.equal(isUntitled("New session - 2026-10-24T12:00:00.000Z"), true);
    assert.equal(isUntitled("Child session - 2026-10-24T12:00:00.000Z"), true);
    assert.equal(isUntitled("Deploy pipeline repair"), false);
  });
});

describe("failure classification", () => {
  it("separates the free-route gate, rate limits, outages, and auth", () => {
    assert.equal(
      classifyTitleFailure({
        message:
          "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building.",
        status: 403,
      }),
      "free-route-gate",
    );
    assert.equal(
      classifyTitleFailure({ status: 429, message: "Rate limit exceeded." }),
      "rate-limit",
    );
    assert.equal(
      classifyTitleFailure({ status: 503, message: "upstream unavailable" }),
      "transient",
    );
    assert.equal(classifyTitleFailure({ status: 403, message: "forbidden" }), "auth");
    assert.equal(classifyTitleFailure({ status: 400, message: "bad request" }), "unknown");
    assert.equal(classifyTitleFailure(undefined), "unknown");
  });

  it("reads the wrapped AI error cause", () => {
    assert.equal(
      classifyTitleFailure({
        name: "ff",
        message: "wrapped",
        cause: {
          _tag: "AI.Error",
          status: 429,
          message: "Rate limit exceeded. Please try again later.",
        },
      }),
      "rate-limit",
    );
  });
});

describe("the free title hook", () => {
  it("leaves every non-free model to OpenCode", async () => {
    const h = harness();
    const title = await h.titles.onTitle({ sessionID: "ses_a", model: PAID });
    assert.equal(title, undefined);
    assert.equal(generates(h.calls).length, 0);
    assert.equal(h.titles.stats().delegated, 1);
  });

  it("supplies the first-prompt title without any provider request", async () => {
    const h = harness();
    const title = await h.titles.onTitle({ sessionID: "ses_a", model: FREE });
    assert.equal(title, PROMPT);
    assert.equal(generates(h.calls).length, 0, "the hook never opens a provider request");
    assert.equal(h.titles.stats().fallback, 1);
    assert.ok(h.events.some((event) => event.detail?.outcome === "fallback"));
    const logged = JSON.stringify(h.events);
    assert.ok(!logged.includes(PROMPT), "never logs the prompt");
  });

  it("leaves the native path alone when there is no first prompt", async () => {
    const h = harness({ firstUser: undefined });
    const title = await h.titles.onTitle({ sessionID: "ses_a", model: FREE });
    assert.equal(title, undefined);
    assert.equal(h.titles.stats().fallback, 0);
  });

  it("regenerates an existing title immediately, with no turn in flight", async () => {
    const h = harness({ info: { title: "Old title", model: FREE } });
    const title = await h.titles.onTitle({ sessionID: "ses_a", model: FREE });
    assert.equal(title, "Deploy pipeline repair");
    assert.equal(generates(h.calls).length, 1);
    assert.equal(h.titles.stats().generated, 1);
  });

  it("keeps the existing title when regeneration fails", async () => {
    const h = harness({
      info: { title: "Old title", model: FREE },
      generateError: { status: 429, message: "Rate limit exceeded." },
    });
    const title = await h.titles.onTitle({ sessionID: "ses_a", model: FREE });
    assert.equal(title, "Old title");
    assert.equal(renames(h.calls).length, 0);
    assert.equal(h.titles.stats().failed, 1);
  });

  it("does not re-enter or open a request from a concurrent attempt", async () => {
    const h = harness();
    const first = await h.titles.onTitle({ sessionID: "ses_a", model: FREE });
    const second = await h.titles.onTitle({ sessionID: "ses_a", model: FREE });
    assert.equal(first, PROMPT);
    assert.equal(second, PROMPT);
    assert.equal(generates(h.calls).length, 0);
  });
});

describe("settled-turn upgrade", () => {
  const ready = async (h) => {
    await h.titles.onTitle({ sessionID: "ses_a", model: FREE });
    h.state.info = { title: PROMPT, model: FREE };
    return h;
  };

  it("replaces the fallback after a settled free turn", async () => {
    const h = await ready(harness());
    h.titles.onSettled("ses_a");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(generates(h.calls).length, 1);
    assert.equal(renames(h.calls).length, 1);
    assert.equal(renames(h.calls)[0][1].title, "Deploy pipeline repair");
    assert.equal(h.titles.stats().generated, 1);
  });

  it("keeps the record while the title is not stored yet", async () => {
    const h = harness();
    await h.titles.onTitle({ sessionID: "ses_a", model: FREE });
    // The store has not committed the hook's result yet.
    h.titles.onSettled("ses_a");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(generates(h.calls).length, 0);
    // The next boundary can still upgrade it.
    h.state.info = { title: PROMPT, model: FREE };
    h.titles.onPrompt("ses_a");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(generates(h.calls).length, 1);
  });

  it("never overwrites a manual rename", async () => {
    const h = harness();
    await h.titles.onTitle({ sessionID: "ses_a", model: FREE });
    h.state.info = { title: "My own title", model: FREE };
    h.titles.onSettled("ses_a");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(generates(h.calls).length, 0);
    assert.equal(renames(h.calls).length, 0);
  });

  it("does not spend paid capacity on a paid fallback session", async () => {
    const h = harness();
    await h.titles.onTitle({ sessionID: "ses_a", model: FREE });
    h.state.info = { title: PROMPT, model: PAID };
    h.titles.onSettled("ses_a");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(generates(h.calls).length, 0);
    assert.equal(h.titles.stats().skipped, 1);
  });

  it("respects a closed free route", async () => {
    const h = await ready(harness({ spendable: false }));
    h.titles.onSettled("ses_a");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(generates(h.calls).length, 0);
    assert.equal(renames(h.calls).length, 0);
  });

  it("re-checks the title immediately before renaming", async () => {
    const h = await ready(harness());
    const baseGet = h.port.get;
    let reads = 0;
    h.port.get = async (input) => {
      reads += 1;
      const result = await baseGet(input);
      // Simulate a manual rename arriving after the first read.
      if (reads === 2) return { ...result, title: "Manual title" };
      return result;
    };
    h.titles.onSettled("ses_a");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(renames(h.calls).length, 0);
  });

  it("bounds the number of upgrade attempts", async () => {
    const h = await ready(harness({ generated: ["", "", "", ""] }));
    for (let attempt = 0; attempt < 6; attempt += 1) {
      h.titles.onSettled("ses_a");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(generates(h.calls).length, 3);
  });

  it("keeps the fallback when generation fails", async () => {
    const h = await ready(
      harness({
        generateError: {
          message:
            "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building.",
          status: 403,
        },
      }),
    );
    h.titles.onSettled("ses_a");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(renames(h.calls).length, 0);
    assert.equal(h.titles.stats().failed, 1);
    const failure = h.events.find((event) => event.detail?.failure !== undefined);
    assert.equal(failure.detail.failure, "free-route-gate");
    assert.equal(failure.detail.requestKind, "title");
  });
});

describe("native title fallback", () => {
  it("writes the first-prompt title after a failed native request", async () => {
    const h = harness();
    await h.titles.onNativeFailure({ sessionID: "ses_a", model: PAID, status: 503 });
    assert.equal(renames(h.calls).length, 1);
    assert.equal(renames(h.calls)[0][1].title, PROMPT);
    assert.equal(h.titles.stats().fallback, 1);
    const event = h.events.find(
      (entry) => entry.message === "native title failed; wrote the first-prompt fallback",
    );
    assert.equal(event.detail.status, 503);
    assert.equal(event.detail.failure, "transient");
  });

  it("keeps a real or manually assigned title", async () => {
    const h = harness({ info: { title: "Pinned title", model: PAID } });
    await h.titles.onNativeFailure({ sessionID: "ses_a", model: PAID, status: 500 });
    assert.equal(renames(h.calls).length, 0);
  });

  it("never titles a child session", async () => {
    const h = harness({ info: { title: undefined, model: PAID, parentID: "ses_parent" } });
    await h.titles.onNativeFailure({ sessionID: "ses_child", model: PAID, status: 500 });
    assert.equal(renames(h.calls).length, 0);
  });

  it("does not duplicate the free-route repair", async () => {
    const h = harness();
    await h.titles.onNativeFailure({ sessionID: "ses_a", model: FREE, status: 403 });
    assert.equal(renames(h.calls).length, 0);
  });
});
