// Guards phase 01: the DNS-bypass transport returns a plain object with no
// clone(), so the retry hook and the error parser must share a single read.
import { describe, it, expect } from "vitest";
import { AntigravityExecutor, readBodyText } from "../../open-sse/executors/antigravity.js";
import { parseUpstreamError } from "../../open-sse/utils/error.js";

const QUOTA_BODY = JSON.stringify({
  error: {
    status: "RESOURCE_EXHAUSTED",
    message: "Resource has been exhausted (e.g. check quota).",
  },
});

const RESET_BODY = JSON.stringify({
  error: { message: "Your quota will reset after 3s" },
});

const GENERIC_BODY = JSON.stringify({
  error: { message: "model is not available for this account" },
});

// Mirrors createBypassRequest(): plain object, Map headers, no clone().
function bypassResponse(status, bodyText) {
  const state = { textCalls: 0, reads: 0, consumed: false };
  const response = {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: new Map(),
    text: async () => {
      state.textCalls++;
      if (state.consumed) return "";
      state.consumed = true;
      state.reads++;
      return bodyText;
    },
    json: async () => JSON.parse(await response.text()),
  };
  return { response, state };
}

describe("readBodyText (phase 01)", () => {
  it("case 1: reads a clone-less JSON body once and exposes the message", async () => {
    const { response } = bypassResponse(429, QUOTA_BODY);

    const bodyText = await readBodyText(response);

    expect(bodyText).toBe(QUOTA_BODY);
    expect(JSON.parse(bodyText).error.message).toBe(
      "Resource has been exhausted (e.g. check quota)."
    );
  });

  it("case 2: two calls return the same promise and read the stream once", async () => {
    const { response, state } = bypassResponse(429, QUOTA_BODY);

    const first = readBodyText(response);
    const second = readBodyText(response);

    expect(second).toBe(first);
    expect(await first).toBe(QUOTA_BODY);
    expect(await second).toBe(QUOTA_BODY);
    expect(state.textCalls).toBe(1);
  });

  it("case 3: a real Response stays consumable after the read", async () => {
    const response = new Response(QUOTA_BODY, { status: 429 });

    expect(await readBodyText(response)).toBe(QUOTA_BODY);
    expect(await response.text()).toBe(QUOTA_BODY);
  });

  it("case 4: resolves to an empty string when text() rejects", async () => {
    const response = {
      status: 500,
      headers: new Map(),
      text: async () => {
        throw new Error("stream closed");
      },
    };

    await expect(readBodyText(response)).resolves.toBe("");
  });

  it("case 5: leaves the response object untouched", async () => {
    const { response } = bypassResponse(429, QUOTA_BODY);
    const textBefore = response.text;
    const jsonBefore = response.json;
    const keysBefore = Object.keys(response);

    await readBodyText(response);

    expect(response.text).toBe(textBefore);
    expect(response.json).toBe(jsonBefore);
    expect(Object.keys(response)).toEqual(keysBefore);
  });

  it("case 6: a later clone (combo shape) still yields the full body", async () => {
    const response = new Response(QUOTA_BODY, { status: 429 });

    await readBodyText(response);

    const cloned = await response.clone().json();
    expect(cloned.error.message).toBe(
      "Resource has been exhausted (e.g. check quota)."
    );
  });
});

describe("computeRetryDelay on a clone-less bypass response", () => {
  const ag = new AntigravityExecutor();

  it("case 7: derives the delay from the body message", async () => {
    const { response } = bypassResponse(429, RESET_BODY);

    // Body says "reset after 3s"; status-only backoff would answer 2000.
    expect(await ag.computeRetryDelay(response, 1)).toBe(3000);
  });

  it("case 8: retry hook and error parser both see the body, one stream read", async () => {
    const { response, state } = bypassResponse(429, RESET_BODY);

    expect(await ag.computeRetryDelay(response, 1)).toBe(3000);

    const parsed = await parseUpstreamError(response, ag);

    expect(parsed.statusCode).toBe(429);
    expect(parsed.message).toContain("reset after 3s");
    expect(state.reads).toBe(1);
  });
});

describe("async parseError through parseUpstreamError", () => {
  const ag = new AntigravityExecutor();

  it("case 9: message is the real body text, not the status fallback", async () => {
    const { response } = bypassResponse(400, GENERIC_BODY);

    const parsed = await parseUpstreamError(response, ag);

    expect(parsed.statusCode).toBe(400);
    expect(parsed.message).toContain("model is not available for this account");
    expect(parsed.message).not.toBe("Bad request");
  });
});
