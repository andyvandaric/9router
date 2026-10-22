# Phase 06 — Client-facing terminal error

**Status**: ✅ Done (2026-10-22 12:18 (UTC+0700), Commit: `68d8b1bb`)
**Author**: claude
**Confidence**: 97%
**Date**: 2026-10-20
**Target Files**: `src/sse/handlers/chat.js`, `tests/unit/noauth-egress-resolution.test.js`

**Wave**: 3 | **Domain**: src/sse/handlers | **Files**: 1 source + 1 test
**Depends on**: Phase 02, Phase 05 | **Unblocks**: none
**Completed Date**: 2026-10-22 12:18 (UTC+0700)
**Duration**: –
**Completed in**: `68d8b1bb` — `open-sse/executors/opencode.js` (EDIT; co-touched `src/sse/services/auth.js`, `tests/unit/noauth-egress-resolution.test.js`, `tests/unit/noauth-proxy-fallback.test.js`, `tests/unit/opencode-egress-retry.test.js`)
**Reconciled 2026-10-22**: file reconciled against live disk. DEVIATION from plan: the rewrite did NOT land in `src/sse/handlers/chat.js` — the file was never modified. It landed in `open-sse/executors/opencode.js` via `rewriteEgressRejection` from `open-sse/utils/freeTierEgress.js` (utility landed in `6886f112`, phase 01). Final body contract verified on live disk: `{ error: { type: "FreeTierError", kind: "egress_abuse", message: buildEgressUnavailableMessage(ctx) } }` with HTTP status preserved at **403** — 503 was explicitly rejected (it invites client-side retry storms). `grep -rn rewriteEgressRejection` confirms the only production call site is `open-sse/executors/opencode.js`; `freeTierEgress.js` defines the builder.

## Goal

After egress retries are exhausted the client receives an actionable message naming the fix — not a raw upstream 403 and not a generic "all connections exhausted".

## Files

- `src/sse/handlers/chat.js` (EDIT exhaustion path ~241-260 and ~344-353) — **not executed as planned; see Reconciled note**
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
