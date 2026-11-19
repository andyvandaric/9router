// Phase 02 (chunk 2B): the execute override owns 429 policy now that the
// registry declares attempts: 0. Prompt rejections get one retry with the
// system text moved; transient overloads keep a small backoff budget; genuine
// quota is never retried and never downgraded.
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const {
  AntigravityExecutor,
  ANTIGRAVITY_PROMPT_REJECTED_MESSAGE,
} = await import("../../open-sse/executors/antigravity.js");
const { default: antigravityRegistry } = await import(
  "../../open-sse/providers/registry/antigravity.js"
);

const MODEL = "claude-opus-4-6-thinking";
const SYSTEM_TEXT = "You are a helpful coding agent.";
const BARE_REJECTION = {
  error: {
    status: "RESOURCE_EXHAUSTED",
    message: "Resource has been exhausted (e.g. check quota).",
  },
};
const QUOTA_REJECTION = {
  error: {
    status: "RESOURCE_EXHAUSTED",
    message: "Resource has been exhausted (e.g. check quota).",
    details: [{ retryDelay: "37s" }],
  },
};

const credentials = { accessToken: "token", projectId: "test-project" };

function requestBody({ systemText = SYSTEM_TEXT, userText = "hello" } = {}) {
  return {
    project: "test-project",
    model: MODEL,
    request: {
      contents: [{ role: "user", parts: [{ text: userText }] }],
      ...(systemText && { systemInstruction: { parts: [{ text: systemText }] } }),
    },
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function run(executor, overrides = {}) {
  return executor.execute({
    model: MODEL,
    body: requestBody(),
    stream: false,
    credentials,
    ...overrides,
  });
}

beforeEach(() => fetchMock.mockReset());

describe("antigravity execute override — prompt rejection", () => {
  it("cases 1/10: retries exactly once with the system text moved into the first user turn", async () => {
    const executor = new AntigravityExecutor();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, BARE_REJECTION))
      .mockResolvedValueOnce(jsonResponse(200, { candidates: [] }));

    const result = await run(executor);

    expect(result.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstPayload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(firstPayload.request.systemInstruction).toEqual({ parts: [{ text: SYSTEM_TEXT }] });

    const retryPayload = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(retryPayload.request.systemInstruction).toBeUndefined();
    expect(retryPayload.request.contents[0].parts[0]).toEqual({ text: SYSTEM_TEXT });
  });

  it("cases 2/11: a rejected retry stops at two upstream calls and maps to 400", async () => {
    const executor = new AntigravityExecutor();
    fetchMock.mockResolvedValue(jsonResponse(429, BARE_REJECTION));

    const result = await run(executor);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.response.status).toBe(429);

    const parsed = await executor.parseError(result.response, "");
    expect(parsed.status).toBe(400);
    expect(parsed.message).toBe(ANTIGRAVITY_PROMPT_REJECTED_MESSAGE);
  });

  it("case 5: a bare rejection with nothing to move is not retried and not downgraded", async () => {
    const executor = new AntigravityExecutor();
    fetchMock.mockResolvedValue(jsonResponse(429, BARE_REJECTION));

    const result = await run(executor, { body: requestBody({ systemText: null }) });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(429);

    const parsed = await executor.parseError(result.response, "");
    expect(parsed.status).toBe(429);
  });

  it("case 6: an image model 429 never gets the system-text retry", async () => {
    const executor = new AntigravityExecutor();
    fetchMock.mockResolvedValue(jsonResponse(429, BARE_REJECTION));

    const result = await run(executor, { model: "gemini-3.1-flash-image" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(429);
  });

  it("case 7: parseError downgrades a prompt rejection to 400 with the explanatory message", async () => {
    const executor = new AntigravityExecutor();
    fetchMock.mockResolvedValue(jsonResponse(429, BARE_REJECTION));

    const result = await run(executor);
    const parsed = await executor.parseError(result.response, "");

    expect(parsed.status).toBe(400);
    expect(parsed.message).toMatch(/not your (account )?quota/i);
    expect(parsed.message).toMatch(/system prompt/i);
  });
});

describe("antigravity execute override — transient vs genuine quota", () => {
  it("case 3: a transient overload 429 is retried with backoff", async () => {
    const executor = new AntigravityExecutor();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(429, { error: { message: "Our servers are experiencing high traffic" } })
      )
      .mockResolvedValueOnce(jsonResponse(200, { candidates: [] }));

    const result = await run(executor);

    expect(result.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("case 4: a genuine quota 429 carrying details[] is returned untouched", async () => {
    const executor = new AntigravityExecutor();
    fetchMock.mockResolvedValue(jsonResponse(429, QUOTA_REJECTION));

    const result = await run(executor);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(429);
  });
});

describe("antigravity registry retry budget", () => {
  it("case 8: 429 declares zero attempts, 503 keeps three", () => {
    expect(antigravityRegistry.transport.retry["429"].attempts).toBe(0);
    expect(antigravityRegistry.transport.retry["503"].attempts).toBe(3);
  });
});
