import { describe, it, expect, vi, beforeEach } from "vitest";
import { opencodeFamilyFormats } from "open-sse/providers/models/helpers.js";
import { FORMATS } from "open-sse/translator/formats.js";

// Imported at module scope: auth.js pulls in the whole provider registry, and
// a dynamic import inside the test body billed that multi-second transform to
// the 5s per-test timeout — which it exceeded whenever another suite shared the
// run. Collection has no such budget.
const { markAccountUnavailable } = await import("@/sse/services/auth.js");

describe("noauth proxy fallback & opencode family formats", () => {
  it("opencodeFamilyFormats matches deepseek-v4.1-flash-free and variants", () => {
    const v41Free = opencodeFamilyFormats("deepseek-v4.1-flash-free");
    expect(v41Free).not.toBeNull();
    expect(v41Free.supportedFormats).toEqual([FORMATS.OPENAI, FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES]);

    const v41FreeEffort = opencodeFamilyFormats("deepseek-v4.1-flash-free(high)");
    expect(v41FreeEffort).not.toBeNull();
    expect(v41FreeEffort.supportedFormats).toEqual([FORMATS.OPENAI, FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES]);

    const v4Flash = opencodeFamilyFormats("deepseek-v4-flash");
    expect(v4Flash).not.toBeNull();
    expect(v4Flash.supportedFormats).toEqual([FORMATS.OPENAI, FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES]);
  });

  it("markAccountUnavailable allows fallback for proxy-backed noauth connections on 403/429", async () => {
    const res403 = await markAccountUnavailable("proxy:pool-1", 403, "FreeTierError", "opencode", "deepseek-v4.1-flash-free");
    expect(res403.shouldFallback).toBe(true);

    const res429 = await markAccountUnavailable("proxy:pool-1", 429, "rate limit", "opencode", "deepseek-v4.1-flash-free");
    expect(res429.shouldFallback).toBe(true);

    const resDirectNoauth = await markAccountUnavailable("noauth", 403, "FreeTierError", "opencode", "deepseek-v4.1-flash-free");
    expect(resDirectNoauth.shouldFallback).toBe(false);
  });
});
