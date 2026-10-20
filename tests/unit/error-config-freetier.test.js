// Regression guards for the opencode free-tier egress error taxonomy:
// "abusive traffic" is a transient IP-reputation block (worth retrying with
// backoff), while "can only be used from within opencode" is a client
// fingerprint rejection that retrying cannot fix (fail fast, long cooldown).
// When a response body contains both phrases, the fingerprint rule must win.
import { describe, expect, it } from "vitest";
import { checkFallbackError, getQuotaCooldown } from "../../open-sse/services/accountFallback.js";

describe("checkFallbackError — free-tier egress error taxonomy", () => {
  it('errorConfig: "abusive traffic" matches a backoff rule before the status-403 rule', () => {
    const result = checkFallbackError(403, "Your request was blocked: abusive traffic detected from this IP");

    expect(result.shouldFallback).toBe(true);
    expect(result.newBackoffLevel).toBe(1);
    expect(result.cooldownMs).toBe(getQuotaCooldown(1));
  });

  it('errorConfig: "can only be used from within opencode" matches the non-retry rule, not backoff', () => {
    const result = checkFallbackError(403, "This model can only be used from within opencode");

    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBe(2 * 60 * 1000);
    expect(result.newBackoffLevel).toBeUndefined();
  });

  it("errorConfig: both phrases present resolves to the fingerprint rule (fail fast)", () => {
    const result = checkFallbackError(403, JSON.stringify({
      error: {
        message: "abusive traffic detected. This model can only be used from within opencode",
      },
    }));

    expect(result.cooldownMs).toBe(2 * 60 * 1000);
    expect(result.shouldFallback).toBe(true);
    expect(result.newBackoffLevel).toBeUndefined();
  });

  it("errorConfig: unrelated 403 still resolves to the long cooldown", () => {
    const result = checkFallbackError(403, "forbidden");

    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBe(2 * 60 * 1000);
    expect(result.newBackoffLevel).toBeUndefined();
  });

  it("errorConfig: existing rate-limit text rules keep their precedence", () => {
    const rateLimited = checkFallbackError(429, "rate limit exceeded");
    expect(rateLimited.shouldFallback).toBe(true);
    expect(rateLimited.newBackoffLevel).toBe(1);
    expect(rateLimited.cooldownMs).toBe(getQuotaCooldown(1));

    const tooMany = checkFallbackError(429, "too many requests");
    expect(tooMany.newBackoffLevel).toBe(1);
    expect(tooMany.cooldownMs).toBe(getQuotaCooldown(1));
  });
});
