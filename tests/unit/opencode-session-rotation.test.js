import { describe, expect, it, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

import { OpenCodeExecutor, OPENCODE_SESSION_RE } from "../../open-sse/executors/opencode.js";

function responseStub(status) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => (status === 429 ? "application/json" : "text/event-stream") },
    text: async () => "",
    json: async () => ({ error: { type: "server_error", message: "Upstream request failed: Endpoint is unavailable." } }),
  };
}

const NATIVE_SESSION =
  "ses_" + "a".repeat(12) + "b".repeat(14); // matches OPENCODE_SESSION_RE
// Api-key rawHeaders shape mirrors the real routed flow (no native/hinted
// session) → stableSessionId path, which is what binds per-identity sessions.
const CREDS = { rawHeaders: { authorization: "Bearer sk-rotation-test-1" } };
const CREDS_ALT = { rawHeaders: { authorization: "Bearer sk-rotation-test-2" } };
const CHAT_BODY = { messages: [{ role: "user", content: "Say exactly OK" }] };

beforeEach(() => {
  fetchMock.mockReset();
});

describe("opencode stable-session rotation on free-tier 429", () => {
  it("evicts the stable session and retries once with a fresh session", async () => {
    fetchMock
      .mockResolvedValueOnce(responseStub(429))
      .mockResolvedValueOnce(responseStub(200));

    const ex = new OpenCodeExecutor();
    const out = await ex.execute({
      model: "glm-5.3-flash-free",
      body: structuredClone(CHAT_BODY),
      stream: true,
      credentials: { ...CREDS },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstSession = fetchMock.mock.calls[0][1].headers["x-opencode-session"];
    const secondSession = fetchMock.mock.calls[1][1].headers["x-opencode-session"];
    expect(firstSession).toMatch(/^[0-9a-fA-F_$].*|./); // sanity: header present
    expect(firstSession).toMatch(OPENCODE_SESSION_RE);
    expect(secondSession).toMatch(OPENCODE_SESSION_RE);
    expect(secondSession).not.toBe(firstSession);
    expect(out.response.status).toBe(200);
  });

  it("does not rotate native client sessions on 429", async () => {
    fetchMock.mockResolvedValue(responseStub(429));

    const ex = new OpenCodeExecutor();
    await ex.execute({
      model: "glm-5.3-flash-free",
      body: structuredClone(CHAT_BODY),
      stream: true,
      credentials: { rawHeaders: { "x-opencode-session": NATIVE_SESSION } },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers["x-opencode-session"]).toBe(NATIVE_SESSION);
  });

  it("does not add a second attempt on non-429 failures", async () => {
    fetchMock.mockResolvedValue(responseStub(500));

    const ex = new OpenCodeExecutor();
    await ex.execute({
      model: "glm-5.3-flash-free",
      body: structuredClone(CHAT_BODY),
      stream: true,
      credentials: { ...CREDS_ALT },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
