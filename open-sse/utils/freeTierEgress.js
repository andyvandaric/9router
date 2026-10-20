/**
 * Classifier and rewriter for the two OpenCode free-tier 403 variants.
 *
 * A 403 FreeTierError answers for two unrelated causes that need opposite
 * handling: a client-fingerprint rejection (identity is wrong — retrying
 * cannot fix it) and an egress/IP-reputation block (transient — retrying
 * through a different egress helps). Live captures, verbatim:
 *   - egress:   "detected abusive traffic from this IP address"
 *   - fingerprint: "can only be used from within OpenCode"
 * Matching is message-text only, case-insensitive; no IP literals or host
 * names live here. Pure module — no provider knowledge, no I/O.
 */

import { HTTP_STATUS } from "../config/runtimeConfig.js";

export const FREETIER_KIND = { fingerprint: "client_fingerprint", egress: "egress_abuse" };

// Verbatim from live 403 FreeTierError captures. Do not paraphrase — the
// fingerprint phrase must outrank the egress phrase: it is the terminal
// variant (no retry can help), so a body containing both is fingerprint.
const EGRESS_PHRASE = "detected abusive traffic from this IP address";
const FINGERPRINT_PHRASE = "can only be used from within OpenCode";

/**
 * Read the response body through a clone so the caller still receives the
 * original. Fail-open: any read error returns null (the same guard the
 * executor's own FreeTierError probe used before this module replaced it).
 */
async function readResponseText(response) {
  try {
    // Inspect a clone so the caller still receives the original body.
    return await response.clone().text();
  } catch {
    return null;
  }
}

function textMatches(text, phrase) {
  if (typeof text !== "string") return false;
  return text.toLowerCase().includes(phrase.toLowerCase());
}

/**
 * Classify a 403 FreeTierError rejection body.
 * @returns {"client_fingerprint"|"egress_abuse"|null}
 */
export async function classifyFreeTierRejection(response) {
  if (response?.status !== HTTP_STATUS.FORBIDDEN) return null;

  const text = await readResponseText(response);
  if (textMatches(text, FINGERPRINT_PHRASE)) return FREETIER_KIND.fingerprint;
  if (textMatches(text, EGRESS_PHRASE)) return FREETIER_KIND.egress;
  return null;
}

/**
 * Actionable terminal-error body for a flagged egress.
 *
 * The upstream free tier has no credential — the request is `Bearer public` —
 * so a rejection here can only be the egress IP's reputation, never the
 * account. A three-egress probe on 2026-10-20 confirmed it: two IPs answered
 * 403 "abusive traffic", a third answered 200 for the same request. The
 * message must therefore name the remedy (a different egress) and must NOT
 * read like an account problem, or the operator has no idea that rotating
 * the egress node clears it.
 */
export function buildEgressUnavailableMessage(ctx) {
  const poolId = ctx?.poolId;
  const where = poolId ? ` egress pool "${poolId}"` : "";
  return [
    `Upstream rejected this${where} egress address with an abuse/traffic flag (egress_abuse).`,
    "This is an egress-IP reputation block, not an account problem — the free tier carries no credential.",
    poolId
      ? "Fix: rotate the proxy pool node (a different egress IP), enable another proxy pool in the Dashboard, or change the network to a different egress IP."
      : "Fix: route through a proxy pool (Dashboard → Providers), or change the network to a different egress IP.",
  ].join(" ");
}

/**
 * Swap an egress-rejection body for an actionable one while preserving the
 * status. Non-egress responses (fingerprint, unknown, non-403) pass through
 * untouched. Mirrors the bufferedResponse idiom in utils/proxyFetch.js.
 */
export async function rewriteEgressRejection(response, ctx) {
  const kind = await classifyFreeTierRejection(response);
  if (kind !== FREETIER_KIND.egress) return response;

  const text = await readResponseText(response);
  const headers = new Headers(response.headers);
  // The body was decoded while reading, so upstream framing no longer applies.
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(
    JSON.stringify({
      error: { type: "FreeTierError", kind, message: buildEgressUnavailableMessage(ctx) },
    }),
    { status: response.status, statusText: response.statusText, headers },
  );
}
