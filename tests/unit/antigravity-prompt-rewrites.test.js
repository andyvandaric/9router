import { describe, expect, it } from "vitest";

import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { openaiToAntigravityRequest } from "../../open-sse/translator/request/openai-to-gemini.js";

function systemTextSentToAntigravity(systemContent) {
  // OpenAI-format client (e.g. a proxy converting Claude Code to /v1/chat/completions).
  const body = openaiToAntigravityRequest("gemini-3.8-flash-tiered", {
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: "hi" },
    ],
  }, true);
  const finalBody = new AntigravityExecutor().transformRequest("gemini-3.8-flash-tiered", body, true, {});
  return finalBody.request.systemInstruction.parts.map((p) => p.text).join("\n");
}

function userTextSentToAntigravity(userContent) {
  // Ensure user turns are NOT rewritten
  const body = openaiToAntigravityRequest("gemini-3.8-flash-tiered", {
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: userContent },
    ],
  }, true);
  const finalBody = new AntigravityExecutor().transformRequest("gemini-3.8-flash-tiered", body, true, {});
  return finalBody.request.contents[0].parts.map((p) => p.text).join("\n");
}

const ANTIGRAVITY_IDENTITY = "You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.**Absolute paths only****Proactiveness**";

describe("Antigravity prompt rewrites — extended fingerprinted clients", () => {
  it("rewrites full Claude Code SDK identity sentence to Antigravity identity line", () => {
    const text = systemTextSentToAntigravity("You are a Claude agent, built on Anthropic's Claude Agent SDK.");
    expect(text).toBe(ANTIGRAVITY_IDENTITY);
  });

  it("rewrites bare 'You are Claude Code' to Antigravity identity line", () => {
    const text = systemTextSentToAntigravity("You are Claude Code");
    expect(text).toBe(ANTIGRAVITY_IDENTITY);
  });

  it("rewrites OpenClaw identity header to Antigravity identity line", () => {
    const text = systemTextSentToAntigravity("You are OpenClaw, an AI coding assistant created by OpenClaw.");
    expect(text).toBe(ANTIGRAVITY_IDENTITY);
  });

  it("rewrites Hermes directness sentence to Antigravity identity line", () => {
    const text = systemTextSentToAntigravity("Be direct: match the length of your reply to the weight of the ask.");
    expect(text).toBe(ANTIGRAVITY_IDENTITY);
  });

  it("rewrites '# Hermes runtime environment' block markers to Antigravity identity line", () => {
    const text = systemTextSentToAntigravity("# Hermes runtime environment\nYou are Hermes, an AI assistant.");
    expect(text).toBe(ANTIGRAVITY_IDENTITY);
  });

  it("leaves clean system prompt unchanged (byte-identical)", () => {
    const clean = "You are a helpful coding assistant.";
    const text = systemTextSentToAntigravity(clean);
    expect(text).toBe(clean);
  });

  it("does not rewrite user turns containing fingerprinted strings", () => {
    const userContent = "You are a Claude agent, built on Anthropic's Claude Agent SDK. Please help.";
    const text = userTextSentToAntigravity(userContent);
    expect(text).toBe(userContent);
  });

  it("does not rewrite identifiers such as skill_view(name='hermes-agent')", () => {
    const text = systemTextSentToAntigravity("Use skill_view(name='hermes-agent') to invoke Hermes.");
    expect(text).toContain("skill_view(name='hermes-agent')");
  });

  it("does not rewrite 'opencode' as substring inside an identifier (regression guard)", () => {
    const text = systemTextSentToAntigravity("Use skill_view(name='opencode-agent') and my-opencode-tool.");
    expect(text).toContain("skill_view(name='opencode-agent')");
    expect(text).toContain("my-opencode-tool");
  });

  it("rewrites standalone word 'OpenCode' in prose to 'Antigravity'", () => {
    const text = systemTextSentToAntigravity("This is an OpenCode based tool.");
    expect(text).toBe("This is an Antigravity based tool.");
  });
});