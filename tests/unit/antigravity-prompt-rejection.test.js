// Phase 02 (chunk 2A): a bare RESOURCE_EXHAUSTED is a request-scoped prompt
// refusal, not account quota. The classifier must be narrow and the mover must
// never mutate the caller's body.
import { describe, it, expect } from "vitest";
import {
  isAntigravityPromptRejection,
  moveSystemInstructionToContents,
} from "../../open-sse/executors/antigravity.js";

const BARE_MESSAGE = "Resource has been exhausted (e.g. check quota).";

function bodyWith(error) {
  return JSON.stringify({ error });
}

function bodyWithSystemPrompt({ systemText, userText = "hello" } = {}) {
  return {
    project: "test-project",
    model: "gemini-3-pro",
    request: {
      contents: [{ role: "user", parts: [{ text: userText }] }],
      ...(systemText && {
        systemInstruction: { parts: [{ text: systemText }] },
      }),
    },
  };
}

describe("isAntigravityPromptRejection", () => {
  it("case 1: 429 with the bare message and no details is a prompt rejection", () => {
    const body = bodyWith({ status: "RESOURCE_EXHAUSTED", message: BARE_MESSAGE });

    expect(isAntigravityPromptRejection(429, body)).toBe(true);
  });

  it("case 2: 429 carrying details is genuine quota, not a prompt rejection", () => {
    const body = bodyWith({
      status: "RESOURCE_EXHAUSTED",
      message: BARE_MESSAGE,
      details: [{ retryDelay: "37s" }],
    });

    expect(isAntigravityPromptRejection(429, body)).toBe(false);
  });

  it("case 3: 429 with a different message is not a prompt rejection", () => {
    const body = bodyWith({
      status: "RESOURCE_EXHAUSTED",
      message: "Quota exceeded for quota metric 'Generate Content API requests per minute'",
    });

    expect(isAntigravityPromptRejection(429, body)).toBe(false);
  });

  it("case 4: 403 carrying the same message is not a prompt rejection", () => {
    const body = bodyWith({ status: "RESOURCE_EXHAUSTED", message: BARE_MESSAGE });

    expect(isAntigravityPromptRejection(403, body)).toBe(false);
  });

  it("case 5: 409 with the bare message is a prompt rejection (chat.js treats 409 like 429)", () => {
    const body = bodyWith({ status: "RESOURCE_EXHAUSTED", message: BARE_MESSAGE });

    expect(isAntigravityPromptRejection(409, body)).toBe(true);
  });

  it("case 6: an empty details array still counts as bare", () => {
    const body = bodyWith({
      status: "RESOURCE_EXHAUSTED",
      message: BARE_MESSAGE,
      details: [],
    });

    expect(isAntigravityPromptRejection(429, body)).toBe(true);
  });

  it("case 7: the trailing period is optional", () => {
    const body = bodyWith({
      status: "RESOURCE_EXHAUSTED",
      message: "Resource has been exhausted (e.g. check quota)",
    });

    expect(isAntigravityPromptRejection(429, body)).toBe(true);
  });

  it("case 8: unparseable body is never classified as a prompt rejection", () => {
    expect(isAntigravityPromptRejection(429, "not json")).toBe(false);
    expect(isAntigravityPromptRejection(429, "")).toBe(false);
  });

  it("case 9: a bare rejection on a request with no systemInstruction must not be downgraded", () => {
    const rejectionBody = bodyWith({ status: "RESOURCE_EXHAUSTED", message: BARE_MESSAGE });
    const requestBody = bodyWithSystemPrompt({ systemText: null });

    expect(isAntigravityPromptRejection(429, rejectionBody)).toBe(true);
    // No fingerprintable system prompt => nothing to move => no downgrade (phase-02 §3d).
    expect(moveSystemInstructionToContents(requestBody)).toBeNull();
  });
});

describe("moveSystemInstructionToContents", () => {
  it("case 10: system parts move to the front of the first user turn and systemInstruction is removed", () => {
    const original = bodyWithSystemPrompt({ systemText: "You are a helpful agent." });

    const moved = moveSystemInstructionToContents(original);

    expect(moved).not.toBeNull();
    expect(moved.request.systemInstruction).toBeUndefined();
    expect(moved.request.contents[0]).toEqual({
      role: "user",
      parts: [{ text: "You are a helpful agent." }, { text: "hello" }],
    });
  });

  it("case 11: the caller's body is never mutated", () => {
    const original = bodyWithSystemPrompt({ systemText: "You are a helpful agent." });
    const snapshot = JSON.parse(JSON.stringify(original));

    const moved = moveSystemInstructionToContents(original);

    expect(original).toEqual(snapshot);
    expect(moved).not.toBe(original);
    expect(moved.request.contents).not.toBe(original.request.contents);
    expect(moved.request.contents[0]).not.toBe(original.request.contents[0]);
  });

  it("case 12: returns null when there is no systemInstruction", () => {
    expect(moveSystemInstructionToContents(bodyWithSystemPrompt({ systemText: null }))).toBeNull();
  });

  it("case 13: returns null when systemInstruction has no text parts", () => {
    const body = bodyWithSystemPrompt({ systemText: null });
    body.request.systemInstruction = { parts: [{}] };

    expect(moveSystemInstructionToContents(body)).toBeNull();
  });

  it("case 14: returns null when there is no request contents to prepend to", () => {
    const body = {
      request: {
        systemInstruction: { parts: [{ text: "You are a helpful agent." }] },
      },
    };

    expect(moveSystemInstructionToContents(body)).toBeNull();
  });
});
