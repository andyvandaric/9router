import { describe, it, expect, vi } from "vitest";
import { opencodeFamilyFormats } from "open-sse/providers/models/helpers.js";
import { getModelSupportedFormats } from "open-sse/config/providerModels.js";
import { FORMATS } from "open-sse/translator/formats.js";

const WIDE_FORMATS = [FORMATS.OPENAI, FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES];

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(async () => []),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(async () => ({})),
  getProxyPools: vi.fn(async () => []),
  validateApiKey: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  getProxyPools: mocks.getProxyPools,
  getProviderConnections: mocks.getProviderConnections,
  updateProviderConnection: mocks.updateProviderConnection,
  validateApiKey: mocks.validateApiKey,
}));

// Imported at module scope: auth.js pulls in the whole provider registry, and
// a dynamic import inside the test body billed that multi-second transform to
// the 5s per-test timeout — which it exceeded whenever another suite shared the
// run. Collection has no such budget.
const { markAccountUnavailable } = await import("@/sse/services/auth.js");

describe("noauth proxy fallback & opencode family formats", () => {
  it("keeps .1 ids on chat completions while v4 keeps the wider family", () => {
    expect(opencodeFamilyFormats("deepseek-v4.1-flash-free").supportedFormats).toEqual([FORMATS.OPENAI]);
    expect(opencodeFamilyFormats("deepseek-v4.1-flash-free(high)").supportedFormats).toEqual([FORMATS.OPENAI]);
    expect(opencodeFamilyFormats("deepseek-v4.1-flash").supportedFormats).toEqual([FORMATS.OPENAI]);
    expect(opencodeFamilyFormats("deepseek-v4-flash").supportedFormats).toEqual(WIDE_FORMATS);
  });

  it("resolves curated lane declarations per alias", () => {
    expect(getModelSupportedFormats("oc", "deepseek-v4.1-flash-free")).toEqual([FORMATS.OPENAI]);
    expect(getModelSupportedFormats("ocz", "deepseek-v4.1-flash-free")).toEqual([FORMATS.OPENAI]);
    expect(getModelSupportedFormats("ocz", "deepseek-v4.1-flash")).toEqual([FORMATS.OPENAI]);
    // OpenCode Go curates the `.1` model with the wider endpoint set.
    expect(getModelSupportedFormats("opencode-go", "deepseek-v4.1-flash")).toEqual(WIDE_FORMATS);
  });

  it("short-circuits proxy:* connections without touching the DB", async () => {
    const res403 = await markAccountUnavailable("proxy:pool-1", 403, "FreeTierError", "opencode", "deepseek-v4.1-flash-free");
    expect(res403.shouldFallback).toBe(true);

    const res429 = await markAccountUnavailable("proxy:pool-1", 429, "rate limit", "opencode", "deepseek-v4.1-flash-free");
    expect(res429.shouldFallback).toBe(true);

    expect(mocks.getProviderConnections).not.toHaveBeenCalled();
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("never falls back for the direct noauth credential", async () => {
    const res = await markAccountUnavailable("noauth", 403, "FreeTierError", "opencode", "deepseek-v4.1-flash-free");
    expect(res.shouldFallback).toBe(false);
    expect(mocks.getProviderConnections).not.toHaveBeenCalled();
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });
});
