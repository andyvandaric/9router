import { describe, it, expect, vi, beforeEach } from "vitest";

// Proxy-pool selection for no-auth free providers. A relay IP can get blocked
// upstream (403 FreeTierError) or answer 429/5xx at any time, independent of the
// model; the pinned pool must therefore fail over to the other active pools on
// retry instead of turning a single blocked egress IP into a hard client error.
// Rotation keeps its fail-closed contract when configured pools are excluded,
// but a stale setting with no usable pool degrades to the direct connection.
const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  validateApiKey: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  getProxyPools: mocks.getProxyPools,
  getProviderConnections: mocks.getProviderConnections,
  updateProviderConnection: mocks.updateProviderConnection,
  validateApiKey: mocks.validateApiKey,
}));

vi.mock("@/models", () => ({
  getProxyPoolById: vi.fn(async (id) => id === "pool-missing" ? null : ({
    id,
    isActive: true,
    proxyUrl: `https://relay-${id}.example`,
    type: "vercel",
    strictProxy: false,
  })),
}));

const { getProviderCredentials } = await import("@/sse/services/auth.js");

// The pinned pool is deliberately not first: an implementation that just takes
// the first pool must not satisfy the healthy-path assertion.
const POOLS = [
  { id: "pool-b", isActive: true, proxyUrl: "https://b.example", type: "vercel" },
  { id: "pool-c", isActive: true, proxyUrl: "https://c.example", type: "vercel" },
  { id: "pool-pinned", isActive: true, proxyUrl: "https://pinned.example", type: "vercel" },
  { id: "pool-no-url", isActive: true, proxyUrl: "", type: "vercel" },
];

const MODEL = "deepseek-v4.1-flash-free";

function pinned(proxyPoolId = "pool-pinned") {
  mocks.getSettings.mockResolvedValue({
    providerStrategies: { opencode: { proxyPoolId, rotateStrategy: "none" } },
  });
}

function rotating() {
  mocks.getSettings.mockResolvedValue({
    providerStrategies: { opencode: { rotateStrategy: "round-robin" } },
  });
}

describe("noauth pinned proxy pool failover (opencode free)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pinned();
    mocks.getProxyPools.mockResolvedValue(POOLS);
    mocks.getProviderConnections.mockResolvedValue([]);
  });

  it("uses the configured pinned pool while it is healthy, not the first pool", async () => {
    const creds = await getProviderCredentials("opencode", null, MODEL);
    expect(creds.connectionId).toBe("proxy:pool-pinned");
    expect(creds.providerSpecificData.vercelRelayUrl).toBe("https://relay-pool-pinned.example");
  });

  it("fails over to another active pool when the pinned pool was excluded after a 403", async () => {
    const creds = await getProviderCredentials(
      "opencode",
      new Set(["proxy:pool-pinned"]),
      MODEL,
    );
    expect(creds).not.toBeNull();
    expect(creds.connectionId).toBe("proxy:pool-b");
    expect(creds.providerSpecificData.vercelRelayUrl).toBe("https://relay-pool-b.example");
  });

  it("accepts the raw pool id form in the exclusion set", async () => {
    const creds = await getProviderCredentials("opencode", new Set(["pool-pinned"]), MODEL);
    expect(creds.connectionId).toBe("proxy:pool-b");
  });

  it("walks to the next pool when the first fallback is excluded too", async () => {
    const creds = await getProviderCredentials(
      "opencode",
      new Set(["proxy:pool-pinned", "proxy:pool-b"]),
      MODEL,
    );
    expect(creds.connectionId).toBe("proxy:pool-c");
  });

  it("skips pools without a proxy url and returns null when all candidates are exhausted", async () => {
    const creds = await getProviderCredentials(
      "opencode",
      new Set(["proxy:pool-pinned", "proxy:pool-b", "proxy:pool-c"]),
      MODEL,
    );
    expect(creds).toBeNull();
  });

  it("labels a stale pinned pool as direct egress", async () => {
    pinned("pool-missing");
    const creds = await getProviderCredentials("opencode", null, MODEL);
    expect(creds.connectionId).toBe("noauth");
    expect(creds.connectionName).toBe("Public");
    expect(creds.providerSpecificData.vercelRelayUrl).toBe("");
  });
});

describe("noauth rotating proxy pools (opencode free)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rotating();
    mocks.getProviderConnections.mockResolvedValue([]);
  });

  it("uses an active pool", async () => {
    mocks.getProxyPools.mockResolvedValue([POOLS[0]]);
    const creds = await getProviderCredentials("opencode", null, MODEL);
    expect(creds.connectionId).toBe("proxy:pool-b");
  });

  it("fails closed when every configured pool is excluded", async () => {
    mocks.getProxyPools.mockResolvedValue([POOLS[0]]);
    const creds = await getProviderCredentials("opencode", new Set(["proxy:pool-b"]), MODEL);
    expect(creds).toBeNull();
  });

  it("falls back to direct egress when the rotation setting has no usable pool", async () => {
    mocks.getProxyPools.mockResolvedValue([]);
    const creds = await getProviderCredentials("opencode", null, MODEL);
    expect(creds.connectionId).toBe("noauth");
    expect(creds.connectionName).toBe("Public");
    expect(creds.providerSpecificData.vercelRelayUrl).toBe("");
  });

  it("ignores pools without a proxy url when counting configured pools", async () => {
    mocks.getProxyPools.mockResolvedValue([POOLS[3]]);
    const creds = await getProviderCredentials("opencode", null, MODEL);
    expect(creds.connectionId).toBe("noauth");
  });
});
