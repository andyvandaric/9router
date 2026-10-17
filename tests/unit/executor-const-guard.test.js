// A5 (cases #7/#9/#10): lock hardcode->config no-op values.
import { describe, it, expect } from "vitest";
import {
  OPENAI_COMPAT_BASE,
  ANTHROPIC_COMPAT_BASE,
  ANTHROPIC_API_VERSION,
} from "../../open-sse/providers/shared.js";
import { DEFAULT_MAX_TOKENS, DEFAULT_MIN_TOKENS } from "../../open-sse/config/runtimeConfig.js";
import mimoFree from "../../open-sse/providers/registry/mimo-free.js";
import opencode from "../../open-sse/providers/registry/opencode.js";
import antigravity from "../../open-sse/providers/registry/antigravity.js";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";

describe("compat base URLs / version", () => {
  it("OPENAI_COMPAT_BASE", () => {
    expect(OPENAI_COMPAT_BASE).toBe("https://api.openai.com/v1");
  });
  it("ANTHROPIC_COMPAT_BASE", () => {
    expect(ANTHROPIC_COMPAT_BASE).toBe("https://api.anthropic.com/v1");
  });
  it("ANTHROPIC_API_VERSION", () => {
    expect(ANTHROPIC_API_VERSION).toBe("2023-06-01");
  });
});

describe("default token limits", () => {
  it("max/min", () => {
    expect(DEFAULT_MAX_TOKENS).toBe(64000);
    expect(DEFAULT_MIN_TOKENS).toBe(32000);
  });
});

describe("provider baseUrl const (full path, no trailing slash)", () => {
  it("mimo-free full path", () => {
    expect(mimoFree.transport.baseUrl).toBe("https://api.xiaomimimo.com/api/free-ai/openai/chat");
  });
  it("opencode no trailing slash", () => {
    expect(opencode.transport.baseUrl).toBe("https://opencode.ai");
  });
});

describe("antigravity retry (const guard: live defaults)", () => {
  // Historical note: an older fork patch forced 429=6, but the effective
  // default at both pre- and post-v0.5.104-merge HEAD is attempts:3.
  // This guard witnesses the live values so a silent retry-policy change fails fast.
  it("429 attempts = 3", () => {
    expect(antigravity.transport.retry["429"].attempts).toBe(3);
  });
  it("503 attempts = 3", () => {
    expect(antigravity.transport.retry["503"].attempts).toBe(3);
  });
});

describe("OpenCode Free endpoint routing", () => {
  const MUSE = "muse-spark-1.2-contributor-free";

  it("declares only the live muse-1.2 Responses model (dead 1.3/union pruned)", () => {
    expect(opencode.transport.format).toBeUndefined();
    // Live check 2026-10-17: muse 1.2 still serves inference (dashboard ping 200);
    // 1.3 is 410 ModelDeprecated upstream and union-alpha left the free tier.
    const muse = opencode.models.find((m) => m.id === MUSE);
    expect(muse?.targetFormat).toBe("openai-responses");
    expect(opencode.models.find((m) => m.id === "muse-spark-1.3-contributor-free")).toBeUndefined();
    expect(opencode.models.find((m) => m.id === "union-alpha")).toBeUndefined();
    expect(opencode.models.some((m) => m.id === "jev-1.13-free")).toBe(true);
  });

  it("routes Muse Spark to /responses and every other model to /chat/completions", () => {
    const executor = new OpenCodeExecutor();
    expect(executor.buildUrl(MUSE)).toBe("https://opencode.ai/inference/v1/responses");
    expect(executor.buildUrl(`${MUSE}(xhigh)`)).toBe("https://opencode.ai/inference/v1/responses");
    expect(executor.buildUrl("muse-spark-1.3-contributor-free")).toBe("https://opencode.ai/inference/v1/responses");
    expect(executor.buildUrl("muse-spark-1.4-contributor-free")).toBe("https://opencode.ai/inference/v1/responses");
    expect(executor.buildUrl("muse-spark-2.0-contributor-free(xhigh)")).toBe("https://opencode.ai/inference/v1/responses");
    expect(executor.buildUrl("big-pickle")).toBe("https://opencode.ai/inference/v1/chat/completions");
    expect(executor.buildUrl("hy3-free")).toBe("https://opencode.ai/inference/v1/chat/completions");
  });

  it("normalizes Chat token/thinking fields only for the Responses model", () => {
    const executor = new OpenCodeExecutor();
    const muse = { max_tokens: 4096, reasoning_effort: "high" };
    executor.transformRequest(MUSE, muse, true, {});
    expect(muse.max_output_tokens).toBe(4096);
    expect(muse.max_tokens).toBeUndefined();
    expect(muse.reasoning).toEqual({ effort: "high", summary: "auto" });

    const chat = { max_tokens: 4096, reasoning_effort: "high" };
    executor.transformRequest("big-pickle", chat, true, {});
    expect(chat.max_tokens).toBe(4096);
    expect(chat.max_output_tokens).toBeUndefined();
    expect(chat.reasoning_effort).toBe("high");
  });
});
