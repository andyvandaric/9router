import { describe, expect, it } from "vitest";

import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

// #4985 / #4247: the OpenCode free inference wire
// (https://opencode.ai/inference/v1/chat/completions) is OpenAI-compatible and
// rejects the z.ai reasoning shape with
//   400 [unknown_parameter] invalid request body: json: unknown field "thinking"
// (and the same for enable_thinking).
//
// glm-5.3-flash carries thinkingFormat:"zai" in the global table — correct for
// Z.ai itself, wrong for this provider — so the unified thinking concern wrote
// a `thinking` object into an OpenAI body. Live wire measurement on the free
// tier: `thinking:{enabled}` → 400, `enable_thinking:true` → 400,
// `reasoning_effort` low|high|max → 200.
//
// Mirrors the existing opencode-go override for the same model.

const OC_GLM_IDS = ["glm-5.3-flash-free"];

describe("OpenCode free GLM uses the OpenAI reasoning wire (#4985)", () => {
  it.each(OC_GLM_IDS)("%s resolves to thinkingFormat:openai", (id) => {
    expect(getCapabilitiesForModel("opencode", id).thinkingFormat).toBe("openai");
  });

  it.each(OC_GLM_IDS)("%s emits reasoning_effort and no thinking object", (id) => {
    const body = { thinking: { type: "enabled", budget_tokens: 4096 } };
    applyThinking("claude", id, body, "opencode");
    expect(body.thinking, id).toBeUndefined();
    expect(body.enable_thinking, id).toBeUndefined();
    expect(body.reasoning_effort, id).toBeDefined();
  });

  it("still marks the model as unable to disable thinking", () => {
    expect(getCapabilitiesForModel("opencode", "glm-5.3-flash-free").thinkingCanDisable).toBe(false);
  });

  it("does not change Z.ai's own wire for the same model", () => {
    // Provider glm/z.ai keeps the zai shape: the thinking object may stay, and
    // no reasoning_effort is added (glm-5.3-flash declares no effort support).
    const body = { thinking: { type: "enabled", budget_tokens: 4096 } };
    applyThinking("claude", "glm-5.3-flash", body, "glm");
    expect(body.thinking?.type, "glm").toBe("enabled");
    expect(body.reasoning_effort, "glm").toBeUndefined();
  });
});
