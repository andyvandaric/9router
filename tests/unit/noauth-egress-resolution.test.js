// Phase 04: noauth selection must never leak direct.
//
// A pinned pool that cannot carry the request used to produce either a null
// credential or a proxyless connection, so the request left from the user's
// direct IP — the exact address upstream flags as abusive. A pinned pool is a
// contract: either it carries the request, or the request fails terminally.
// With no pool configured at all, direct egress stays legal (manual-VPN users).
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  pickProxyPoolId: vi.fn(),
  probeProxyEgress: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getSettings: mocks.getSettings,
  getProxyPools: mocks.getProxyPools,
  validateApiKey: vi.fn(),
  updateProviderConnection: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
  pickProxyPoolId: mocks.pickProxyPoolId,
}));
vi.mock("open-sse/utils/proxyHealth.js", () => ({
  probeProxyEgress: mocks.probeProxyEgress,
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: { opencode: { noAuth: true } },
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const { getProviderCredentials } = await import("@/sse/services/auth.js");

const PROVIDER = "opencode";
const POOL_ID = "pool-vpsease";
const POOL_URL = "socks5://198.51.100.7:1080";

function pinnedPoolConfig(overrides = {}) {
  return {
    source: "pool",
    proxyPoolId: POOL_ID,
    proxyPool: { id: POOL_ID, name: "vpsease-main", proxyUrl: POOL_URL, strictProxy: true },
    connectionProxyEnabled: true,
    connectionProxyUrl: POOL_URL,
    connectionNoProxy: "",
    vercelRelayUrl: "",
    strictProxy: true,
    ...overrides,
  };
}

function directConfig() {
  return {
    source: "none",
    proxyPoolId: null,
    proxyPool: null,
    connectionProxyEnabled: false,
    connectionProxyUrl: "",
    connectionNoProxy: "",
    vercelRelayUrl: "",
    strictProxy: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProviderConnections.mockResolvedValue([]);
  mocks.getProxyPools.mockResolvedValue([]);
  mocks.getSettings.mockResolvedValue({
    providerStrategies: { [PROVIDER]: { proxyPoolId: POOL_ID } },
  });
  mocks.resolveConnectionProxyConfig.mockResolvedValue(pinnedPoolConfig());
  mocks.probeProxyEgress.mockResolvedValue({ ok: true });
});

describe("auth noauth egress resolution", () => {
  it("auth noauth: configured pool that fails probe throws EGRESS_PROXY_UNAVAILABLE with remediation text", async () => {
    mocks.probeProxyEgress.mockResolvedValue({ ok: false, reason: "timeout" });

    const error = await getProviderCredentials(PROVIDER).then(
      () => null,
      (thrown) => thrown,
    );

    expect(error).toMatchObject({ code: "EGRESS_PROXY_UNAVAILABLE" });
    expect(error.message).toContain(POOL_ID);
    expect(error.message).toMatch(/tunnel|upstream/i);
    expect(error.message).toMatch(/direct/i);
  });

  it("auth noauth: configured pool that probes ok yields connectionProxyUrl and strictProxy from the pool row", async () => {
    const credentials = await getProviderCredentials(PROVIDER);

    expect(mocks.probeProxyEgress).toHaveBeenCalledWith(POOL_URL);
    expect(credentials).toMatchObject({
      connectionId: `proxy:${POOL_ID}`,
      providerSpecificData: {
        connectionProxyEnabled: true,
        connectionProxyUrl: POOL_URL,
        connectionProxyPoolId: POOL_ID,
        strictProxy: true,
      },
    });
  });

  it("auth noauth: no pool configured yields connectionId \"noauth\" with no proxy (unchanged)", async () => {
    mocks.getSettings.mockResolvedValue({ providerStrategies: {} });
    mocks.resolveConnectionProxyConfig.mockResolvedValue(directConfig());

    const credentials = await getProviderCredentials(PROVIDER);

    expect(credentials).toMatchObject({
      connectionId: "noauth",
      id: "noauth",
      providerSpecificData: {
        connectionProxyEnabled: false,
        connectionProxyUrl: "",
        connectionProxyPoolId: null,
        strictProxy: false,
      },
    });
    expect(mocks.probeProxyEgress).not.toHaveBeenCalled();
  });

  it("auth noauth: pool url comes from the pool row, never from a hardcoded host or port", async () => {
    const poolUrl = "socks5://203.0.113.77:41234";
    mocks.resolveConnectionProxyConfig.mockResolvedValue(
      pinnedPoolConfig({ connectionProxyUrl: poolUrl }),
    );

    const credentials = await getProviderCredentials(PROVIDER);
    const url = credentials.providerSpecificData.connectionProxyUrl;

    expect(url).toBe(poolUrl);
    expect(url).not.toMatch(/127\.0\.0\.1|localhost|:20808\b/u);
  });

  it("auth noauth: strictProxy from the pool row is preserved on the returned connection", async () => {
    mocks.resolveConnectionProxyConfig.mockResolvedValue(
      pinnedPoolConfig({
        strictProxy: true,
        proxyPool: { id: POOL_ID, name: "vpsease-main", proxyUrl: POOL_URL, strictProxy: true },
      }),
    );

    const credentials = await getProviderCredentials(PROVIDER);

    expect(credentials.providerSpecificData.strictProxy).toBe(true);
    expect(credentials.providerSpecificData.connectionProxyUrl).toBe(POOL_URL);
  });
});
