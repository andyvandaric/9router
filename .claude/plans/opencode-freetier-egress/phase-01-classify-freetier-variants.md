# Phase 01 — Classify the two FreeTierError variants

**Status**: IN PROGRESS
**Author**: claude
**Confidence**: 97%
**Date**: 2026-10-20
**Target Files**: `open-sse/utils/freeTierEgress.js`, `tests/unit/free-tier-egress-classify.test.js`

**Wave**: 1 | **Domain**: open-sse/utils | **Files**: 1 source + 1 test
**Depends on**: none | **Unblocks**: Phase 02

## Goal

One pure classifier + one terminal-error rewriter. No I/O, no provider knowledge, no network.

## Files

- `open-sse/utils/freeTierEgress.js` (NEW)
- `tests/unit/free-tier-egress-classify.test.js` (NEW)

## Exports

```js
export const FREETIER_KIND = { fingerprint: "client_fingerprint", egress: "egress_abuse" };
export function classifyFreeTierRejection(response)   // → kind | null
export function rewriteEgressRejection(response, ctx) // → Response (status preserved, actionable body)
export function buildEgressUnavailableMessage(ctx)    // → string
```

## TDD — tests written FIRST (must fail)

1. `freeTierEgress: classifies "abusive traffic from this IP address" as egress_abuse`
2. `freeTierEgress: classifies "can only be used from within OpenCode" as client_fingerprint`
3. `freeTierEgress: fingerprint wins when both phrases appear in one body`
4. `freeTierEgress: returns null for non-403 and for FreeTierError without a known phrase`
5. `freeTierEgress: rewriteEgressRejection preserves status and swaps body to actionable code`
6. `freeTierEgress: classifier never disturbs the original body (clone-guarded, try/catch)` ← mirrors `opencode.js:135-141`

## Constraints

- Match on **message text only**. No IP literals, no host names.
- Always `response.clone()` inside `try/catch`; return `null` on any throw (fail-open, same as `isFreeTierRejection`).
- Rewriter uses the `bufferedResponse` idiom from `proxyFetch.js:342-348` (drop `content-length`, `content-encoding`).
- Actionable message names: the pool id (if any), and the two remedies (configure/enable a proxy pool in Dashboard; or change network).

## Acceptance

- Both variants map to distinct kinds; unknown 403 passes through untouched.
- Message text constants live in this one file — no duplication elsewhere.

## Verify

```bash
cd tests && npx vitest run unit/free-tier-egress-classify.test.js
```
