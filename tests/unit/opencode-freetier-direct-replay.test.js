// OpenCode's free tier answers 403 FreeTierError for two unrelated reasons
// that need opposite handling (live captures, verbatim):
//
//   - fingerprint: "OpenCode's free tier can only be used from within OpenCode."
//   - egress:      "...we've detected abusive traffic from this IP address."
//
// The transport succeeds in both cases, so the proxy-failure fallback never
// fires and every retry keeps leaving through the same proxy.
//
// proxyAwareFetch inspects a proxied 403 and may replay once on the direct
// egress — but only for the FINGERPRINT shape, and never when the proxy came
// from the environment:
//
//   - The egress variant is a reputation block on the egress address.
//     Replaying it from the real IP only gets a second address flagged by the
//     same gate, so it is never replayed.
//   - An env proxy (HTTP_PROXY/HTTPS_PROXY/ALL_PROXY) is the operator's
//     deliberate egress choice; replaying direct bypasses the VPN/proxy they
//     configured.
//
// strictProxy keeps its contract (never leaves the configured path) and
// non-gate 403s pass through untouched.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FREE_TIER_403 = JSON.stringify({
  type: "error",
  error: { type: "FreeTierError", message: "OpenCode's free tier can only be used from within OpenCode." },
});
const EGRESS_ABUSE_403 = JSON.stringify({
  type: "error",
  error: {
    type: "FreeTierError",
    message: "OpenCode's free models aren't available from your current network because we've detected abusive traffic from this IP address.",
  },
});
const OTHER_403 = JSON.stringify({ error: { type: "permission_error", message: "quota exhausted" } });

// The env proxy is a global operator choice, so these tests must never inherit
// one from the host. Save/restore around every case.
const PROXY_ENV_KEYS = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
];
const savedProxyEnv = new Map();

// Captured as originalFetch when proxyFetch.js loads; proxy attempts carry an
// undici dispatcher, direct attempts do not.
const fetchMock = vi.fn();
globalThis.fetch = fetchMock;

// getDispatcher() imports undici lazily on the proxy path.
vi.mock("undici", () => ({
  Agent: class {},
  ProxyAgent: class {},
  Socks5ProxyAgent: class {},
}));

const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

function proxiedThenDirect({ proxiedResponse, directResponse }) {
  fetchMock.mockImplementation(async (_url, opts = {}) =>
    opts.dispatcher ? proxiedResponse() : directResponse());
}

const PROXY = { enabled: true, url: "http://127.0.0.1:9999" };

beforeEach(() => {
  fetchMock.mockReset();
  for (const key of PROXY_ENV_KEYS) {
    if (!savedProxyEnv.has(key)) savedProxyEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of PROXY_ENV_KEYS) {
    const saved = savedProxyEnv.get(key);
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
});

/** Every upstream call made so far, split by whether it carried a dispatcher. */
function callsByEgress() {
  const proxied = [];
  const direct = [];
  for (const call of fetchMock.mock.calls) {
    (call[1]?.dispatcher ? proxied : direct).push(call);
  }
  return { proxied, direct };
}

describe("proxied 403 FreeTierError replays direct (#4983)", () => {
  it("replays once on the direct egress and returns its 200", async () => {
    proxiedThenDirect({
      proxiedResponse: () => new Response(FREE_TIER_403, { status: 403, headers: { "content-type": "application/json" } }),
      directResponse: () => new Response("data: ok", { status: 200 }),
    });

    const res = await proxyAwareFetch("https://opencode.ai/inference/v1/chat/completions", { method: "POST", body: "{}" }, PROXY);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("data: ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]?.dispatcher).toBeTruthy();
    expect(fetchMock.mock.calls[1][1]?.dispatcher).toBeFalsy();
  });

  it("keeps strictProxy on the configured path — returns the 403, no replay", async () => {
    proxiedThenDirect({
      proxiedResponse: () => new Response(FREE_TIER_403, { status: 403, headers: { "content-type": "application/json" } }),
      directResponse: () => new Response("must not run", { status: 200 }),
    });

    const res = await proxyAwareFetch("https://opencode.ai/inference/v1/chat/completions", { method: "POST", body: "{}" }, { ...PROXY, strictProxy: true });

    expect(res.status).toBe(403);
    expect(await res.text()).toBe(FREE_TIER_403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns a non-gate 403 untouched, without a direct replay", async () => {
    proxiedThenDirect({
      proxiedResponse: () => new Response(OTHER_403, { status: 403, headers: { "content-type": "application/json", "x-request-id": "req-1" } }),
      directResponse: () => new Response("must not run", { status: 200 }),
    });

    const res = await proxyAwareFetch("https://api.example.com/v1/chat", { method: "POST", body: "{}" }, PROXY);

    expect(res.status).toBe(403);
    expect(res.headers.get("x-request-id")).toBe("req-1");
    expect(await res.text()).toBe(OTHER_403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("leaves a proxied 200 stream untouched — one call, body not consumed", async () => {
    proxiedThenDirect({
      proxiedResponse: () => new Response("data: chunk\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
      directResponse: () => new Response("must not run", { status: 200 }),
    });

    const res = await proxyAwareFetch("https://opencode.ai/inference/v1/chat/completions", { method: "POST", body: "{}" }, PROXY);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("data: chunk\n");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces the original 403 when the direct replay itself fails", async () => {
    let call = 0;
    fetchMock.mockImplementation(async (_url, opts = {}) => {
      call += 1;
      if (call === 1) return new Response(FREE_TIER_403, { status: 403, headers: { "content-type": "application/json" } });
      expect(opts.dispatcher).toBeFalsy();
      throw new Error("direct egress down");
    });

    const res = await proxyAwareFetch("https://opencode.ai/inference/v1/chat/completions", { method: "POST", body: "{}" }, PROXY);

    expect(res.status).toBe(403);
    expect(await res.text()).toBe(FREE_TIER_403);
  });
});

describe("proxied 403 FreeTierError replay guards", () => {
  it("never replays a proxied egress-abuse 403 on the direct egress — one upstream call, no direct dispatcher", async () => {
    proxiedThenDirect({
      proxiedResponse: () => new Response(EGRESS_ABUSE_403, { status: 403, headers: { "content-type": "application/json" } }),
      directResponse: () => new Response("must not run", { status: 200 }),
    });

    const res = await proxyAwareFetch("https://opencode.ai/inference/v1/chat/completions", { method: "POST", body: "{}" }, PROXY);

    expect(res.status).toBe(403);
    expect(await res.text()).toBe(EGRESS_ABUSE_403);
    const { proxied, direct } = callsByEgress();
    expect(direct).toHaveLength(0);
    expect(proxied).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The load-bearing claim: nothing left over the direct egress.
    expect(fetchMock.mock.calls.every(call => call[1]?.dispatcher)).toBe(true);
    expect(fetchMock.mock.calls[0][1]?.dispatcher).toBeTruthy();
  });

  it("never replays a proxied 403 when the proxy came from the environment — one upstream call, no direct dispatcher", async () => {
    process.env.HTTPS_PROXY = "http://127.0.0.1:9999";
    process.env.ALL_PROXY = "http://127.0.0.1:9999";

    // Both gate shapes must be covered: the env origin forbids the replay
    // regardless of which variant the body carries.
    const cases = [["fingerprint", FREE_TIER_403], ["egress-abuse", EGRESS_ABUSE_403]];

    for (const [label, body] of cases) {
      fetchMock.mockReset();
      proxiedThenDirect({
        proxiedResponse: () => new Response(body, { status: 403, headers: { "content-type": "application/json" } }),
        directResponse: () => new Response("must not run", { status: 200 }),
      });

      const res = await proxyAwareFetch("https://opencode.ai/inference/v1/chat/completions", { method: "POST", body: "{}" }, null);

      expect(res.status, label).toBe(403);
      expect(await res.text(), label).toBe(body);
      const { proxied, direct } = callsByEgress();
      expect(direct, label).toHaveLength(0);
      expect(proxied, label).toHaveLength(1);
      expect(fetchMock, label).toHaveBeenCalledTimes(1);
      // The load-bearing claim: nothing left over the direct egress.
      expect(fetchMock.mock.calls.every(call => call[1]?.dispatcher), label).toBe(true);
      expect(fetchMock.mock.calls[0][1]?.dispatcher, label).toBeTruthy();
    }
  });

  it("replays the fingerprint 403 once on the direct egress — the client was refused, not the network", async () => {
    proxiedThenDirect({
      proxiedResponse: () => new Response(FREE_TIER_403, { status: 403, headers: { "content-type": "application/json" } }),
      directResponse: () => new Response("data: ok", { status: 200 }),
    });

    const res = await proxyAwareFetch("https://opencode.ai/inference/v1/chat/completions", { method: "POST", body: "{}" }, PROXY);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("data: ok");
    const { proxied, direct } = callsByEgress();
    expect(proxied).toHaveLength(1);
    expect(direct).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Positive control: the guards did not disable the replay wholesale.
    expect(fetchMock.mock.calls[0][1]?.dispatcher).toBeTruthy();
    expect(fetchMock.mock.calls[1][1]?.dispatcher).toBeFalsy();
  });
});

// The direct replay is a TRANSPORT-SUCCESS path: the proxy carried the
// request and the upstream refused it. Closing that leak must not disturb
// the transport-failure fallback, which is a different contract — when the
// proxy itself is unavailable the request path stays exactly as it was.
describe("proxy failure modes fail open — the request path is unchanged", () => {
  it("keeps the direct path when no proxy is configured", async () => {
    fetchMock.mockImplementation(async () => new Response("data: ok", { status: 200 }));

    const res = await proxyAwareFetch("https://opencode.ai/inference/v1/chat/completions", { method: "POST", body: "{}" }, null);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("data: ok");
    const { proxied, direct } = callsByEgress();
    expect(proxied).toHaveLength(0);
    expect(direct).toHaveLength(1);
  });

  it("falls back to the direct path when the proxy refuses the connection", async () => {
    fetchMock.mockImplementation(async (_url, opts = {}) => {
      if (opts.dispatcher) {
        throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9999"), { code: "ECONNREFUSED" });
      }
      return new Response("data: ok", { status: 200 });
    });

    const res = await proxyAwareFetch("https://opencode.ai/inference/v1/chat/completions", { method: "POST", body: "{}" }, PROXY);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("data: ok");
    const { proxied, direct } = callsByEgress();
    expect(proxied).toHaveLength(1);
    expect(direct).toHaveLength(1);
  });

  it("falls back to the direct path when the proxy times out", async () => {
    fetchMock.mockImplementation(async (_url, opts = {}) => {
      if (opts.dispatcher) {
        throw Object.assign(new Error("proxy connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" });
      }
      return new Response("data: ok", { status: 200 });
    });

    const res = await proxyAwareFetch("https://opencode.ai/inference/v1/chat/completions", { method: "POST", body: "{}" }, PROXY);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("data: ok");
    const { proxied, direct } = callsByEgress();
    expect(proxied).toHaveLength(1);
    expect(direct).toHaveLength(1);
  });

  it("passes a non-2xx proxy status through untouched", async () => {
    proxiedThenDirect({
      proxiedResponse: () => new Response("upstream boom", { status: 500, headers: { "content-type": "text/plain" } }),
      directResponse: () => new Response("must not run", { status: 200 }),
    });

    const res = await proxyAwareFetch("https://opencode.ai/inference/v1/chat/completions", { method: "POST", body: "{}" }, PROXY);

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("upstream boom");
    const { proxied, direct } = callsByEgress();
    expect(proxied).toHaveLength(1);
    expect(direct).toHaveLength(0);
  });
});
