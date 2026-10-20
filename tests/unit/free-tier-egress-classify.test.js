import { describe, it, expect } from "vitest";
import {
  FREETIER_KIND,
  classifyFreeTierRejection,
  rewriteEgressRejection,
  buildEgressUnavailableMessage,
} from "open-sse/utils/freeTierEgress.js";

const jsonResponse = (status, payload, extraHeaders = {}) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });

// Verbatim upstream bodies (captured live 2026-10-20). The classifier keys on
// message text because both variants share HTTP 403 + error.type FreeTierError
// — the message is the ONLY discriminator upstream offers. A paraphrased
// fixture would keep passing after upstream reworded it, which is exactly the
// drift this file exists to catch, so the captured strings are used verbatim.
const EGRESS_BODY = {
  type: "error",
  error: {
    type: "FreeTierError",
    message: "OpenCode's free models aren't available from your current network because we've detected abusive traffic from this IP address. This isn't related to your account. If you're on a VPN or proxy, turn it off and try again, or subscribe to OpenCode Go at https://opencode.ai/go to keep building.",
  },
};
// Same upstream shape with different surrounding wording — the matcher must
// key on the phrase, not on the whole message.
const EGRESS_BODY_LOWER = {
  error: { type: "FreeTierError", message: "Detected Abusive Traffic From This IP Address on the free tier." },
};
const FINGERPRINT_BODY = {
  type: "error",
  error: {
    type: "FreeTierError",
    message: "OpenCode's free tier can only be used from within OpenCode.",
  },
};
const COMBINED_BODY = {
  error: {
    type: "FreeTierError",
    message: "abusive traffic detected from this IP address. This model can only be used from within OpenCode.",
  },
};
const UNKNOWN_BODY = {
  error: { type: "FreeTierError", message: "Free tier quota exceeded for today." },
};

// A response-shaped object whose clone() throws, mirroring a body the
// transport has already consumed or a mangled stream.
class ThrowingCloneResponse {
  constructor(status) {
    this.status = status;
    this.headers = new Headers({ "content-type": "application/json" });
  }
  clone() {
    throw new Error("body already consumed");
  }
}

describe("classifyFreeTierRejection", () => {
  it('freeTierEgress: classifies "abusive traffic from this IP address" as egress_abuse', async () => {
    const exact = await classifyFreeTierRejection(jsonResponse(403, EGRESS_BODY));
    const lowercase = await classifyFreeTierRejection(jsonResponse(403, EGRESS_BODY_LOWER));

    expect(exact).toBe(FREETIER_KIND.egress);
    expect(exact).toBe("egress_abuse");
    expect(lowercase).toBe("egress_abuse");
  });

  it('freeTierEgress: classifies "can only be used from within OpenCode" as client_fingerprint', async () => {
    const kind = await classifyFreeTierRejection(jsonResponse(403, FINGERPRINT_BODY));

    expect(kind).toBe(FREETIER_KIND.fingerprint);
    expect(kind).toBe("client_fingerprint");
  });

  it("freeTierEgress: fingerprint wins when both phrases appear in one body", async () => {
    const kind = await classifyFreeTierRejection(jsonResponse(403, COMBINED_BODY));

    expect(kind).toBe("client_fingerprint");
  });

  it("freeTierEgress: returns null for non-403 and for FreeTierError without a known phrase", async () => {
    const notForbidden = await classifyFreeTierRejection(jsonResponse(401, UNKNOWN_BODY));
    const missingBody = await classifyFreeTierRejection(jsonResponse(403, UNKNOWN_BODY));
    const absentResponse = await classifyFreeTierRejection(null);

    expect(notForbidden).toBeNull();
    expect(missingBody).toBeNull();
    expect(absentResponse).toBeNull();
  });

  it("freeTierEgress: classifier never disturbs the original body (clone-guarded, try/catch)", async () => {
    const original = jsonResponse(403, EGRESS_BODY);

    const kind = await classifyFreeTierRejection(original);
    expect(kind).toBe("egress_abuse");

    // The caller's body must be untouched and still consumeable afterwards.
    await expect(original.text()).resolves.toContain("abusive traffic from this IP address");

    // A response whose clone cannot be taken fails open to null, not a throw.
    await expect(classifyFreeTierRejection(new ThrowingCloneResponse(403))).resolves.toBeNull();
  });
});

describe("rewriteEgressRejection", () => {
  it("freeTierEgress: rewriteEgressRejection preserves status and swaps body to actionable code", async () => {
    const ctx = { provider: "opencode", model: "grok-code", poolId: "vpsease" };
    const original = jsonResponse(403, EGRESS_BODY, {
      "content-encoding": "gzip",
    });

    const rewritten = await rewriteEgressRejection(original, ctx);

    expect(rewritten.status).toBe(403);
    const body = await rewritten.text();
    expect(body).toContain("egress_abuse");
    expect(body).toContain("vpsease");
    expect(body).toContain("proxy pool");
    expect(body).toContain("Dashboard");
    expect(body).toContain("change the network");
    expect(body).not.toContain("abusive traffic from this IP address");
  });

  it("leaves responses that are not egress rejections untouched", async () => {
    const fingerprint = jsonResponse(403, FINGERPRINT_BODY);
    const unknown = jsonResponse(403, UNKNOWN_BODY);
    const non403 = jsonResponse(401, EGRESS_BODY);

    const keptFingerprint = await rewriteEgressRejection(fingerprint, { poolId: "p" });
    const keptUnknown = await rewriteEgressRejection(unknown, { poolId: "p" });
    const kept401 = await rewriteEgressRejection(non403, { poolId: "p" });

    await expect(keptFingerprint.text()).resolves.toContain("within OpenCode");
    await expect(keptUnknown.text()).resolves.toContain("quota exceeded");
    expect(kept401.status).toBe(401);
  });
});

describe("buildEgressUnavailableMessage", () => {
  it("names the pool id when present and both remedies either way", () => {
    const withPool = buildEgressUnavailableMessage({ provider: "opencode", model: "grok-code", poolId: "vpsease" });
    const withoutPool = buildEgressUnavailableMessage({});

    expect(withPool).toContain("vpsease");
    expect(withPool).toContain("proxy pool");
    expect(withPool).toContain("Dashboard");
    expect(withPool).toContain("change the network");

    expect(withoutPool).not.toContain("undefined");
    expect(withoutPool).toContain("proxy pool");
    expect(withoutPool).toContain("Dashboard");
    expect(withoutPool).toContain("change the network");
  });
});
