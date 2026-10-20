# Phase 02 — Bounded egress retry with backoff in the opencode executor

**Status**: PROPOSED
**Author**: claude
**Confidence**: 97%
**Date**: 2026-10-20
**Target Files**: `open-sse/executors/opencode.js`, `tests/unit/opencode-egress-retry.test.js`

**Wave**: 2 | **Domain**: open-sse/executors | **Files**: 1 source + 1 test
**Depends on**: Phase 01 | **Unblocks**: Phase 06

## Goal

Retry **only** `egress_abuse`, with real exponential backoff and session eviction. Fingerprint variant never retries.

## Files

- `open-sse/executors/opencode.js` (EDIT `execute()` at ~407-421)
- `tests/unit/opencode-egress-retry.test.js` (NEW)

## Change shape

Replace the current unconditional single evict+retry:

```js
// today
const rotates = status === 429 || await isFreeTierRejection(response);
if (!rotates) return result;
evictStableSession(prepared);
return super.execute(...);   // exactly once, same egress
```

with a bounded loop:

```js
// target
const MAX_EGRESS_ATTEMPTS = 3;
for (let attempt = 1; ; attempt++) {
  const result = await super.execute({...});
  if (status === 429) { evictStableSession(prepared); continue-with-rotation; }   // unchanged 429 path
  const kind = classifyFreeTierRejection(result?.response);
  if (kind === FREETIER_KIND.fingerprint) { evictStableSession(prepared); continue-once; } // unchanged legacy path
  if (kind !== FREETIER_KIND.egress) return result;        // other → passthrough
  if (attempt >= MAX_EGRESS_ATTEMPTS) return rewriteEgressRejection(result.response, ctx);
  evictStableSession(prepared);
  await sleep(getQuotaCooldown(attempt));                   // reuse accountFallback.js:9-13
}
```

## TDD — tests written FIRST (must fail)

1. `opencode executor: retries egress_abuse up to MAX_EGRESS_ATTEMPTS then returns actionable error`
2. `opencode executor: rotates the session once on client_fingerprint then returns the second result` (exactly 2 upstream calls — the fingerprint variant is never retried in a loop)
3. `opencode executor: evicts stable session between egress retries` (session id differs per attempt)
4. `opencode executor: backoff delay grows between attempts` (fake timers, assert `getQuotaCooldown(1) < …(2)`)
5. `opencode executor: 429 still rotates session exactly as before` ← regression guard on `opencode-session-rotation.test.js` behaviour
6. `opencode executor: native/derived session sources are never rotated`

> **Correction (2026-10-20, after a live regression):** the fingerprint message is **ambiguous**. Upstream answers a poisoned/stale stable session with 403 FreeTierError carrying "can only be used from within OpenCode" (live probes 2026-10-17), and the recovery for that is evict + retry once. Treating it as "never retry" broke the pre-existing contract in `opencode-session-rotation.test.js`. The old behaviour is live-proven, so it wins: a `client_fingerprint` 403 rotates the session exactly once and returns the second result. Only `egress_abuse` gets the new bounded backoff loop.

## Constraints

- Reuse `getQuotaCooldown()` — do NOT invent a new backoff curve.
- `MAX_EGRESS_ATTEMPTS` is a named constant, not a magic number.
- Respect `AbortSignal`: abort must interrupt the sleep.
- Never retry when `result.response` is absent (network throw) — existing behaviour owns that.

## Acceptance

- `super.execute` called ≤ `MAX_EGRESS_ATTEMPTS` on abuse; exactly 1 on fingerprint.
- 429 behaviour byte-identical to today.
- No new clone beyond the existing guarded one, plus one per retry iteration (safe — see index §8).

## Verify

```bash
cd tests && npx vitest run unit/opencode-egress-retry.test.js unit/opencode-session-rotation.test.js unit/noauth-proxy-fallback.test.js
```
