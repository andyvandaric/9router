import { describe, it, expect } from "vitest";
import {
  applyFingerprintTools,
  concealFingerprintToolNames,
  appendMissingFingerprintTools,
  fingerprintToolKey,
  restoreToolNames,
  takeRenamedToolNames,
  sanitizeAndCapTools,
  injectOpenCodeDualSessionHeaders,
  applyOpenCodeSessionHeaders,
  OPENCODE_FINGERPRINT_TOOLS,
  OPENCODE_DEFAULT_UA,
  OPENCODE_DEFAULT_CLIENT,
  OPENCODE_SESSION_HEADER,
  OPENCODE_SESSION_ID_HEADER,
  MAX_TOOLS_COUNT,
  OPENCODE_HEADERS,
} from "open-sse/utils/opencodeFingerprint.js";

const CC_TOOLS = ["Task", "Bash", "Glob", "Grep", "Read", "Edit", "Write", "WebFetch"];
const flat = (names) => names.map((name) => ({ type: "function", name }));
const chat = (names) => names.map((name) => ({ type: "function", function: { name } }));

describe("opencodeFingerprint — request side", () => {
  it("renames capitalised quartet members to lowercase", () => {
    const body = { tools: flat(CC_TOOLS) };
    const map = applyFingerprintTools(body, true);
    const names = body.tools.map((tool) => tool.name);

    expect(names).toContain("bash");
    expect(names).not.toContain("Bash");
    expect(names).toContain("Edit");
    expect(map.get("bash")).toBe("Bash");
  });

  it("removes quartet case duplicates without dropping unrelated case variants", () => {
    const body = { tools: flat(["Bash", "bash", "Glob", "grep", "Read", "Foo", "foo"]) };
    applyFingerprintTools(body, true);

    const names = body.tools.map((tool) => tool.name);
    expect(names.filter((name) => name === "bash")).toHaveLength(1);
    expect(names).toContain("Foo");
    expect(names).toContain("foo");
  });

  it("preserves tool count when a complete quartet is only renamed", () => {
    const body = { tools: flat(CC_TOOLS) };
    applyFingerprintTools(body, true);
    expect(body.tools).toHaveLength(CC_TOOLS.length);
  });

  it("handles the nested chat shape without dropping .function", () => {
    const body = { tools: chat(CC_TOOLS) };
    applyFingerprintTools(body, false);

    const names = body.tools.map((tool) => tool.function.name);
    expect(names).toContain("bash");
    expect(names).not.toContain("Bash");
    expect(body.tools[1].function.name).toBe("bash");
  });

  it("injects all four fingerprint tools when the body carries no tools", () => {
    const body = { tools: [] };
    applyFingerprintTools(body, true);

    expect(body.tools.map((tool) => tool.name).sort()).toEqual([...OPENCODE_FINGERPRINT_TOOLS].sort());
    expect(body.tool_choice).toBe("auto");
  });

  it("preserves the chat no-tool default tool_choice=none", () => {
    const body = {};
    applyFingerprintTools(body, false);

    expect(body.tools.map((tool) => tool.function.name)).toEqual(OPENCODE_FINGERPRINT_TOOLS);
    expect(body.tool_choice).toBe("none");
  });

  it("does not invent a chat tool_choice when the caller already supplied tools", () => {
    const body = { tools: chat(["Edit"]) };
    applyFingerprintTools(body, false);
    expect(body.tool_choice).toBeUndefined();
  });

  it("appends only genuinely missing quartet members", () => {
    const body = { tools: flat(["Bash", "Read", "terminal"]) };
    applyFingerprintTools(body, true);

    const names = body.tools.map((tool) => tool.name);
    expect(names).toContain("glob");
    expect(names).toContain("grep");
    expect(names).toContain("terminal");
    expect(body.tools).toHaveLength(5);
  });

  it("retargets flat tool_choice that points at a renamed tool", () => {
    const body = { tools: flat(CC_TOOLS), tool_choice: { type: "function", name: "Bash" } };
    applyFingerprintTools(body, true);
    expect(body.tool_choice.name).toBe("bash");
  });

  it("retargets nested tool_choice that points at a renamed tool", () => {
    const body = {
      tools: chat(CC_TOOLS),
      tool_choice: { type: "function", function: { name: "Read" } },
    };
    applyFingerprintTools(body, false);
    expect(body.tool_choice.function.name).toBe("read");
  });

  it("records the rename map against the body for the response side", () => {
    const body = { tools: flat(CC_TOOLS) };
    const map = applyFingerprintTools(body, true);
    expect(takeRenamedToolNames(body)).toBe(map);
  });

  it("never throws on malformed tools", () => {
    for (const tools of [null, undefined, "nope", [null, 42, []], [{}, { name: "" }]]) {
      expect(() => concealFingerprintToolNames(tools)).not.toThrow();
      expect(() => appendMissingFingerprintTools(tools, true)).not.toThrow();
    }
  });
});

describe("opencodeFingerprint — response side", () => {
  const map = new Map([["bash", "Bash"], ["grep", "Grep"], ["read", "Read"]]);

  it("restores names in Claude content_block_start chunks", () => {
    const chunk = {
      type: "content_block_start",
      content_block: { type: "tool_use", name: "bash", id: "t1" },
    };
    const out = restoreToolNames(chunk, map);

    expect(out.content_block.name).toBe("Bash");
    expect(chunk.content_block.name).toBe("bash");
  });

  it("recursively restores streaming chunks inside arrays", () => {
    const chunks = [{
      choices: [{ delta: { tool_calls: [{ function: { name: "grep", arguments: "{}" } }] } }],
    }];
    const out = restoreToolNames(chunks, map);
    expect(out[0].choices[0].delta.tool_calls[0].function.name).toBe("Grep");
  });

  it("restores names in Claude non-streaming bodies", () => {
    const body = { type: "message", content: [{ type: "tool_use", name: "bash", input: {} }] };
    expect(restoreToolNames(body, map).content[0].name).toBe("Bash");
  });

  it("restores names in Chat Completions message and delta shapes", () => {
    const body = {
      choices: [
        { message: { tool_calls: [{ function: { name: "grep", arguments: "{}" } }] } },
        { delta: { tool_calls: [{ function: { name: "read", arguments: "{}" } }] } },
      ],
    };
    const out = restoreToolNames(body, map);

    expect(out.choices[0].message.tool_calls[0].function.name).toBe("Grep");
    expect(out.choices[1].delta.tool_calls[0].function.name).toBe("Read");
  });

  it("restores names in Responses final output items", () => {
    const body = { output: [{ type: "function_call", name: "bash", call_id: "c1" }] };
    expect(restoreToolNames(body, map).output[0].name).toBe("Bash");
  });

  it("restores names in Responses streaming output_item events", () => {
    const event = {
      type: "response.output_item.added",
      item: { type: "function_call", name: "read", call_id: "c1" },
    };
    expect(restoreToolNames(event, map).item.name).toBe("Read");
  });

  it("is a no-op without a map or with an empty map", () => {
    const body = { choices: [{ message: { tool_calls: [{ function: { name: "bash" } }] } }] };
    expect(restoreToolNames(body, null)).toBe(body);
    expect(restoreToolNames(body, new Map())).toBe(body);
  });

  it("leaves unknown tool names untouched", () => {
    const body = { output: [{ type: "function_call", name: "Edit" }] };
    expect(restoreToolNames(body, map).output[0].name).toBe("Edit");
  });
});

describe("fingerprintToolKey", () => {
  it("maps quartet case/whitespace variants and rejects other tools", () => {
    expect(fingerprintToolKey("Bash")).toBe("bash");
    expect(fingerprintToolKey(" bash ")).toBe("bash");
    expect(fingerprintToolKey("GLOB")).toBe("glob");
    expect(fingerprintToolKey("Read")).toBe("read");
    expect(fingerprintToolKey("Edit")).toBe("");
    expect(fingerprintToolKey("terminal")).toBe("");
    expect(fingerprintToolKey(null)).toBe("");
  });
});

describe("opencodeFingerprint — Wave 1 contract & constants", () => {
  it("exports standard header constants and limits", () => {
    expect(OPENCODE_DEFAULT_UA).toBe("opencode/1.19.0");
    expect(OPENCODE_DEFAULT_CLIENT).toBe("cli");
    expect(OPENCODE_SESSION_HEADER).toBe("x-opencode-session");
    expect(OPENCODE_SESSION_ID_HEADER).toBe("x-opencode-session-id");
    expect(MAX_TOOLS_COUNT).toBe(128);

    expect(OPENCODE_HEADERS.SESSION).toBe("x-opencode-session");
    expect(OPENCODE_HEADERS.SESSION_ID).toBe("x-opencode-session-id");
    expect(OPENCODE_HEADERS.CLIENT).toBe("x-opencode-client");
  });

  it("injectOpenCodeDualSessionHeaders injects identical session IDs into both headers", () => {
    const headers = { "Content-Type": "application/json" };
    const sessionId = "ses_abcdef0123456789ABCDEF";

    const res = injectOpenCodeDualSessionHeaders(headers, sessionId);
    expect(res).toBe(headers);
    expect(headers["x-opencode-session"]).toBe(sessionId);
    expect(headers["x-opencode-session-id"]).toBe(sessionId);

    // Test alias
    const headers2 = {};
    applyOpenCodeSessionHeaders(headers2, sessionId);
    expect(headers2["x-opencode-session"]).toBe(sessionId);
    expect(headers2["x-opencode-session-id"]).toBe(sessionId);
  });

  it("injectOpenCodeDualSessionHeaders handles non-object inputs safely", () => {
    expect(injectOpenCodeDualSessionHeaders(null, "ses_123")).toBeNull();
    expect(injectOpenCodeDualSessionHeaders(undefined, "ses_123")).toBeUndefined();
    expect(injectOpenCodeDualSessionHeaders("invalid", "ses_123")).toBe("invalid");
  });

  it("sanitizeAndCapTools filters invalid items, normalizes names, and caps count", () => {
    const rawTools = [
      null,
      undefined,
      "not an object",
      { name: "tool:calc@v1" }, // invalid chars -> sanitized
      { function: { name: "my.action-runner_2" } }, // invalid dot -> sanitized
      { name: "clean_name-123" },
    ];

    const sanitized = sanitizeAndCapTools(rawTools, 128);
    expect(sanitized).toHaveLength(3);
    expect(sanitized[0].name).toBe("tool_calc_v1");
    expect(sanitized[1].function.name).toBe("my_action-runner_2");
    expect(sanitized[2].name).toBe("clean_name-123");

    // Test capping
    const manyTools = Array.from({ length: 150 }, (_, i) => ({ name: `tool_${i}` }));
    const capped = sanitizeAndCapTools(manyTools, 128);
    expect(capped).toHaveLength(128);
    expect(capped[0].name).toBe("tool_0");
    expect(capped[127].name).toBe("tool_127");
  });

  it("applyFingerprintTools automatically caps tools at 128 items and normalizes names", () => {
    const manyTools = Array.from({ length: 140 }, (_, i) => ({
      type: "function",
      name: `custom:tool:${i}`,
    }));

    const body = { tools: manyTools };
    applyFingerprintTools(body, true);

    expect(body.tools.length).toBeLessThanOrEqual(MAX_TOOLS_COUNT);
    expect(body.tools.length).toBe(128);

    // Fingerprint quartet should be preserved
    const names = body.tools.map((t) => t.name);
    expect(names).toContain("bash");
    expect(names).toContain("glob");
    expect(names).toContain("grep");
    expect(names).toContain("read");

    // All custom tool names sanitized
    for (const tool of body.tools) {
      expect(tool.name).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  });
});
