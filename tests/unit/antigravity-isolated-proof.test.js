// Isolated verification for the antigravity false-429 fix.
//
// Runs under vitest so the `@/` and open-sse aliases resolve exactly as they
// do in the app. Nothing here touches port 20128, ~/.elyrouter, or a real
// Antigravity account: every upstream response is a local stub shaped like the
// one the DNS-bypass transport actually returns.

import { describe, expect, it } from "vitest";
import {
  AntigravityExecutor,
  isAntigravityPromptRejection,
  moveSystemInstructionToContents,
} from "../../open-sse/executors/antigravity.js";
import { parseUpstreamError } from "../../open-sse/utils/error.js";

const BARE_EXHAUSTED = JSON.stringify({
  error: {
    status: "RESOURCE_EXHAUSTED",
    message: "Resource has been exhausted (e.g. check quota).",
  },
});

const QUOTA_EXHAUSTED = JSON.stringify({
  error: {
    status: "RESOURCE_EXHAUSTED",
    message: "Individual quota reached. Resets in 1h56m.",
    details: [{ retryDelay: "6960s" }],
  },
});

// Mirrors createBypassRequest: plain object with text()/json(), no clone().
function bypassResponse(status, body) {
  const state = { reads: 0 };
  const response = {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: new Map(),
    text: async () => {
      state.reads += 1;
      return body;
    },
    json: async () => JSON.parse(await response.text()),
  };
  return { response, state };
}

const executor = new AntigravityExecutor();

describe("isolated proof: a bare 429 is a prompt refusal, not quota", () => {
  it("classifies the bare body on 429", () => {
    expect(isAntigravityPromptRejection(429, BARE_EXHAUSTED)).toBe(true);
  });

  it("classifies the same body on 409, because chat.js treats both alike", () => {
    expect(isAntigravityPromptRejection(409, BARE_EXHAUSTED)).toBe(true);
  });

  it("does NOT claim a quota 429 that carries reset details", () => {
    expect(isAntigravityPromptRejection(429, QUOTA_EXHAUSTED)).toBe(false);
  });

  it("keeps an unmarked bare 429 at 429, because only the execute probe may downgrade it", async () => {
    // The downgrade is gated on a WeakSet marker that the execute override sets
    // after the one system-text retry. Called directly, parseError must NOT
    // downgrade: an unmarked 429 is indistinguishable from real quota, and
    // downgrading it would stop account fallback. The marked path is covered by
    // antigravity-execute-override.test.js.
    const { response } = bypassResponse(429, BARE_EXHAUSTED);
    const parsed = await executor.parseError(response, "");
    expect(parsed?.status).not.toBe(400);
  });

  it("leaves a genuine quota 429 alone", async () => {
    const { response } = bypassResponse(429, QUOTA_EXHAUSTED);
    const parsed = await executor.parseError(response, "");
    expect(parsed?.status).not.toBe(400);
  });

  it("keeps the body readable for both consumers on a clone-less transport", async () => {
    // error.js reads once for itself, then parseError reads again through the
    // WeakMap. Two reads is the accepted design; what must hold is that neither
    // consumer sees an empty body.
    const { response } = bypassResponse(429, BARE_EXHAUSTED);
    const parsed = await parseUpstreamError(response, executor);
    expect(String(parsed?.message || "").length).toBeGreaterThan(10);
    const direct = await executor.parseError(response, "");
    expect(direct).toBeTruthy();
  });

  it("moves systemInstruction without mutating the caller's body", () => {
    const body = {
      request: {
        systemInstruction: { parts: [{ text: "You are Claude Code." }] },
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
      },
    };
    const snapshot = JSON.stringify(body);
    const moved = moveSystemInstructionToContents(body);
    expect(moved).not.toBeNull();
    expect(JSON.stringify(body)).toBe(snapshot);
    expect(moved.request.systemInstruction).toBeUndefined();
  });

  it("returns null when there is no system text, so real quota is never downgraded", () => {
    expect(
      moveSystemInstructionToContents({
        request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
      }),
    ).toBeNull();
  });
});

describe("isolated proof: the identity the gateway presents", () => {
  it("sends the current hub User-Agent, not the stale one", async () => {
    const { ANTIGRAVITY_IDE_USER_AGENT, ANTIGRAVITY_IDE_VERSION } = await import(
      "../../open-sse/providers/shared.js"
    );
    expect(ANTIGRAVITY_IDE_USER_AGENT).toBe(`antigravity/hub/${ANTIGRAVITY_IDE_VERSION} darwin/arm64`);
    expect(ANTIGRAVITY_IDE_VERSION).not.toBe("2.24.0");
  });

  it("adds Accept: text/event-stream for streaming calls only", () => {
    const creds = { accessToken: "tok" };
    expect(executor.buildHeaders(creds, true)["Accept"]).toBe("text/event-stream");
    expect(executor.buildHeaders(creds, false)).not.toHaveProperty("Accept");
  });

  it("declares zero in-place retries for 429, so one layer owns that policy", async () => {
    const registry = (await import("../../open-sse/providers/registry/antigravity.js")).default;
    expect(registry.transport.retry["429"].attempts).toBe(0);
  });
});

describe("isolated proof: prompt rewrites stop the trigger at the source", () => {
  it("rewrites the Claude Code SDK identity sentence", async () => {
    const { ANTIGRAVITY_PROMPT_REWRITES } = await import("../../open-sse/config/appConstants.js");
    const input = "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.";
    const out = ANTIGRAVITY_PROMPT_REWRITES.reduce((text, rule) => text.replace(rule.from, rule.to), input);
    expect(out).not.toContain("Claude Code");
  });

  it("leaves identifiers containing opencode intact", async () => {
    const { ANTIGRAVITY_PROMPT_REWRITES } = await import("../../open-sse/config/appConstants.js");
    const input = "Call skill_view(name='opencode-agent') and my-opencode-tool.";
    const out = ANTIGRAVITY_PROMPT_REWRITES.reduce((text, rule) => text.replace(rule.from, rule.to), input);
    expect(out).toBe(input);
  });
});
