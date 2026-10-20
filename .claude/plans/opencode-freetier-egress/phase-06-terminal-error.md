# Phase 06 — Client-facing terminal error

**Status**: PROPOSED
**Author**: claude
**Confidence**: 97%
**Date**: 2026-10-20
**Target Files**: `src/sse/handlers/chat.js`, `tests/unit/noauth-egress-resolution.test.js`

**Wave**: 3 | **Domain**: src/sse/handlers | **Files**: 1 source + 1 test
**Depends on**: Phase 02, Phase 05 | **Unblocks**: none

## Goal

After egress retries are exhausted the client receives an actionable message naming the fix — not a raw upstream 403 and not a generic "all connections exhausted".

## Files

- `src/sse/handlers/chat.js` (EDIT exhaustion path ~241-260 and ~344-353)
- `tests/unit/noauth-egress-resolution.test.js` (extend — second `describe` block)

## Change

When the last result before exhaustion is a `403` classified as `egress_abuse`:

- emit `rewriteEgressRejection`'s body (Phase 01) as the client response;
- preserve status **403** (decided — see index §8);
- include: provider, model, pool id (if any), and **both** remedies, because a live tunnel does not imply a clean egress:
  1. run the liveness probe (the tunnel may be dead), and
  2. change egress if the 403 persists (the egress IP's reputation is what was flagged — proven by the three-IP discriminator in index §8; switching IPv4/IPv6 does not help).

## TDD — tests written FIRST (must fail)

1. `chat noauth: configured pool exhausted by egress_abuse surfaces actionable error, not generic exhaustion`
2. `chat noauth: exclusion loop terminates (no infinite retry) when only one pool exists`
3. `chat noauth: no-pool direct 403 passes through unchanged`
4. `chat noauth: fingerprint 403 is not rewritten as an egress error`
5. `chat noauth: exactly one client response is produced`

## Constraints

- No `excludeConnectionIds` growth loop when only one candidate exists.
- Do not rewrite non-FreeTier 403s (auth/permission) — those pass through.
- Message text comes from Phase 01's builder; do not duplicate strings here.

## Acceptance

- Exactly one client response in every path.
- Message names pool id + remedies.
- No behaviour change for providers other than `opencode`.

## Verify

```bash
cd tests && npx vitest run unit/noauth-egress-resolution.test.js unit/account-fallback-4xx.test.js
```
