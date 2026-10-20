// OpenCode's free-tier gate answers 403 FreeTierError for two unrelated causes
// (see open-sse/utils/freeTierEgress.js). Only the egress variant is transient:
// it retries the same egress with bounded exponential backoff, while the client
// fingerprint variant can never be fixed by rebuilding a session.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

import {
  OpenCodeExecutor,
  OPENCODE_SESSION_RE,
  translateSessionId,
} from "../../open-sse/executors/opencode.js";

// Verbatim from live 403 FreeTierError captures (index.md §1).
const EGRESS_BODY = JSON.stringify({
  type: "error",
  error: {
    type: "FreeTierError",
    message: "OpenCode's free models aren't available from your current network because we've detected abusive traffic from this IP address.",
  },
});
const FINGERPRINT_BODY = JSON.stringify({
  type: "error",
  error: {
    type: "FreeTierError",
    message: "OpenCode's free tier can only be used from within OpenCode.",
  },
});

const jsonResponse = (status, body) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

const okResponse = () =>
  new Response("data: ok\n", { status: 200, headers: { "content-type": "text/event-stream" } });

const NATIVE_SESSION = "ses_" + "a".repeat(12) + "b".repeat(14); // matches OPENCODE_SESSION_RE
const DERIVED_SESSION = "client-session-abc";

// The real backoff base is 2000ms (errorConfig.js:32-36): getQuotaCooldown(1)
// = 2000, (2) = 4000. Tests drive it with fake timers, never a real sleep.
const FIRST_COOLDOWN_MS = 2000;
const SECOND_COOLDOWN_MS = 4000;
const ALL_RETRIES_MS = FIRST_COOLDOWN_MS + SECOND_COOLDOWN_MS;
const MAX_EGRESS_ATTEMPTS = 3;

function requestArgs(credentials) {
  return {
    model: "glm-5.3-flash-free",
    body: { messages: [{ role: "user", content: "Say exactly OK" }] },
    stream: true,
    credentials,
    proxyOptions: { proxyPoolId: "vpsease-main" },
  };
}

const stableCredentials = (suffix) => ({
  rawHeaders: { authorization: `Bearer sk-egress-retry-${suffix}` },
});

const sessionAt = (callIndex) => fetchMock.mock.calls[callIndex][1].headers["x-opencode-session"];

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("opencode executor: bounded egress retry", () => {
  it("opencode executor: retries egress_abuse up to MAX_EGRESS_ATTEMPTS then returns actionable error", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => jsonResponse(403, EGRESS_BODY));

    const ex = new OpenCodeExecutor();
    const pending = ex.execute(requestArgs(stableCredentials("exhausted")));
    await vi.advanceTimersByTimeAsync(ALL_RETRIES_MS);
    const out = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(MAX_EGRESS_ATTEMPTS);
    expect(out.response.status).toBe(403);
    const body = await out.response.text();
    expect(body).toContain("egress_abuse");
    expect(body).toContain("vpsease-main");
    expect(body).toContain("proxy pool");
    expect(body).not.toContain("abusive traffic from this IP address");
  });

  it("opencode executor: rotates the session once on client_fingerprint then returns the second result", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(403, FINGERPRINT_BODY));

    const ex = new OpenCodeExecutor();
    const out = await ex.execute(requestArgs(stableCredentials("fingerprint")));

    // The fingerprint message is ambiguous: upstream also emits it for a stale
    // stable session (live probes 2026-10-17), so one rotation is the recovery.
    // A second consecutive fingerprint 403 is terminal — no retry loop.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sessionAt(0)).toMatch(OPENCODE_SESSION_RE);
    expect(sessionAt(1)).not.toBe(sessionAt(0));
    expect(out.response.status).toBe(403);
    await expect(out.response.text()).resolves.toContain("within OpenCode");
  });

  it("opencode executor: evicts stable session between egress retries", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => jsonResponse(403, EGRESS_BODY));

    const ex = new OpenCodeExecutor();
    const pending = ex.execute(requestArgs(stableCredentials("evict")));
    await vi.advanceTimersByTimeAsync(ALL_RETRIES_MS);
    await pending;

    const sessions = [sessionAt(0), sessionAt(1), sessionAt(2)];
    for (const session of sessions) expect(session).toMatch(OPENCODE_SESSION_RE);
    expect(new Set(sessions).size).toBe(MAX_EGRESS_ATTEMPTS);
  });

  it("opencode executor: backoff delay grows between attempts", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => jsonResponse(403, EGRESS_BODY));

    const ex = new OpenCodeExecutor();
    const pending = ex.execute(requestArgs(stableCredentials("backoff")));

    // getQuotaCooldown(1) = 2000ms: the second attempt cannot start earlier.
    await vi.advanceTimersByTimeAsync(FIRST_COOLDOWN_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // getQuotaCooldown(2) = 4000ms: the third attempt waits four times the base.
    await vi.advanceTimersByTimeAsync(SECOND_COOLDOWN_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_EGRESS_ATTEMPTS);

    await pending;
  });
});

describe("opencode executor: 429 and session-source guards", () => {
  it("opencode executor: 429 still rotates session exactly as before", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, "{}"))
      .mockResolvedValueOnce(okResponse());

    const ex = new OpenCodeExecutor();
    const out = await ex.execute(requestArgs(stableCredentials("rate-limited")));

    // Byte-identical to the pre-egress-loop behaviour: one extra attempt only.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstSession = sessionAt(0);
    const secondSession = sessionAt(1);
    expect(firstSession).toMatch(OPENCODE_SESSION_RE);
    expect(secondSession).toMatch(OPENCODE_SESSION_RE);
    expect(secondSession).not.toBe(firstSession);
    expect(out.response.status).toBe(200);
  });

  it("opencode executor: native and derived session sources are never rotated", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(403, EGRESS_BODY));

    const ex = new OpenCodeExecutor();
    await ex.execute({
      ...requestArgs({ rawHeaders: { authorization: "Bearer sk-native", "x-opencode-session": NATIVE_SESSION } }),
    });
    await ex.execute({
      ...requestArgs({ rawHeaders: { authorization: "Bearer sk-derived", "x-opencode-session": DERIVED_SESSION } }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sessionAt(0)).toBe(NATIVE_SESSION);
    expect(sessionAt(1)).toBe(translateSessionId(DERIVED_SESSION));
  });
});
