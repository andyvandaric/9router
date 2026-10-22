// Guards the provider-strategy merge bug: `settings.providerStrategies` is a
// map of providerId -> override, and each override carries TWO independent
// groups of keys (fallback strategy vs no-auth proxy pool). Dashboard writers
// that rebuilt the entry from scratch silently DELETED the group they did not
// own, which un-bound the opencode proxy pool and sent free-tier traffic back
// to the machine's direct IP (403 "detected abusive traffic from this IP").
//
// Fix: mergeProviderStrategy() spreads the existing entry first, then applies
// the writer's owned fields on top; `undefined` means "remove this field".
import { describe, it, expect } from "vitest";
import { mergeProviderStrategy } from "../../src/shared/providerStrategies.js";

describe("mergeProviderStrategy: sibling field groups survive", () => {
  it("preserves proxyPoolId and rotateStrategy when setting fallbackStrategy", () => {
    const current = {
      opencode: { proxyPoolId: "vpsease-main", rotateStrategy: "none" },
    };

    const out = mergeProviderStrategy(current, "opencode", {
      fallbackStrategy: "round-robin",
    });

    expect(out.opencode).toEqual({
      proxyPoolId: "vpsease-main",
      rotateStrategy: "none",
      fallbackStrategy: "round-robin",
    });
  });

  it("preserves other providers' entries untouched", () => {
    const current = {
      opencode: { proxyPoolId: "vpsease-main", rotateStrategy: "none" },
      antigravity: { fallbackStrategy: "fill-first" },
    };

    const out = mergeProviderStrategy(current, "opencode", {
      fallbackStrategy: "random",
      stickyRoundRobinLimit: 3,
    });

    expect(out.antigravity).toEqual({ fallbackStrategy: "fill-first" });
    expect(Object.keys(out).sort()).toEqual(["antigravity", "opencode"]);
  });

  it("removes ONLY the field whose value is undefined, leaving siblings", () => {
    const current = {
      opencode: {
        proxyPoolId: "vpsease-main",
        rotateStrategy: "none",
        fallbackStrategy: "round-robin",
        stickyRoundRobinLimit: 5,
      },
    };

    const out = mergeProviderStrategy(current, "opencode", {
      fallbackStrategy: undefined,
    });

    expect(out.opencode).toEqual({
      proxyPoolId: "vpsease-main",
      rotateStrategy: "none",
      stickyRoundRobinLimit: 5,
    });
    expect("fallbackStrategy" in out.opencode).toBe(false);
  });

  it("removes the provider entry entirely when it ends up empty", () => {
    const current = {
      opencode: { fallbackStrategy: "round-robin" },
      antigravity: { fallbackStrategy: "fill-first" },
    };

    const out = mergeProviderStrategy(current, "opencode", {
      fallbackStrategy: undefined,
      stickyRoundRobinLimit: undefined,
    });

    expect("opencode" in out).toBe(false);
    expect(out.antigravity).toEqual({ fallbackStrategy: "fill-first" });
  });

  it("does not mutate the input object", () => {
    const current = {
      opencode: { proxyPoolId: "vpsease-main", rotateStrategy: "none" },
    };
    const snapshot = JSON.parse(JSON.stringify(current));

    const out = mergeProviderStrategy(current, "opencode", {
      fallbackStrategy: "round-robin",
      stickyRoundRobinLimit: undefined,
    });

    expect(current).toEqual(snapshot);
    expect(out).not.toBe(current);
    expect(out.opencode).not.toBe(current.opencode);
  });

  it("adds a provider entry that did not exist before", () => {
    const out = mergeProviderStrategy({}, "kiro", { fallbackStrategy: "round-robin" });

    expect(out).toEqual({ kiro: { fallbackStrategy: "round-robin" } });
  });
});
