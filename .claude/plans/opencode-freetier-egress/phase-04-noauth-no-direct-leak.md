# Phase 04 — noauth selection must never leak direct

**Status**: ✅ Done (2026-10-22 11:42 (UTC+0700), Commit: 68d8b1bb)
**Completed Date:** 2026-10-22 11:42 (UTC+0700)
**Duration:** ~2 days (Created records date only, no clock time — date-level precision)
**Completed in**: Commit `68d8b1bb` — `src/sse/services/auth.js` (EDIT), `tests/unit/noauth-egress-resolution.test.js` (NEW)
**Reconciled 2026-10-22**: Reconciled against live disk at 11:42 (UTC+0700). Layout drifted with the Phase 08 failover chain (both landed in `68d8b1bb`): the probe now sits in the `usingPool` branch at `auth.js:130-150` with `EGRESS_PROXY_UNAVAILABLE` built at `:110-121`, and the bare `noauth` direct path is kept for the no-pool case (`auth.js:104-107`) — target behaviour table holds; the `noauth` account is never written lock/cooldown state.
**Author**: claude
**Confidence**: 97%
**Date**: 2026-10-20
**Target Files**: `src/sse/services/auth.js`, `tests/unit/noauth-egress-resolution.test.js`

**Wave**: 2 | **Domain**: src/sse/services | **Files**: 1 source + 1 test
**Depends on**: Phase 03 | **Unblocks**: Phase 07

## Goal

When a pool **is** configured but unusable, fail terminally. When **no** pool is configured, direct is legal (manual-VPN users).

## Files

- `src/sse/services/auth.js` (EDIT noauth block, ~47-85)
- `tests/unit/noauth-egress-resolution.test.js` (NEW)

## Current behaviour (the bug)

```js
// auth.js:63-66 — pinned pool excluded
} else if (pickedId && (excludeSet.has(`proxy:${pickedId}`) || excludeSet.has(pickedId))) {
  return null;   // → proxyless, silent
}
// and when providerStrategies.opencode is absent entirely:
// pickedId = null → connectionId "noauth" → direct egress, unprompted
```

## Target behaviour

| Configured? | Pool healthy? | Result |
|---|---|---|
| no pool key at all | n/a | `connectionId:"noauth"`, no proxy — **unchanged**, legal |
| pool pinned | probe ok | connection with `connectionProxyUrl` from the pool row |
| pool pinned | probe failed | **throw terminal `EGRESS_PROXY_UNAVAILABLE`** — never proxyless |
| pool pinned, excluded by fallback | another pool exists | next active pool (Phase 08) |
| pool pinned, excluded | no alternative | terminal error, never direct |

## TDD — tests written FIRST (must fail)

1. `auth noauth: configured pool that fails probe throws EGRESS_PROXY_UNAVAILABLE with remediation text`
2. `auth noauth: configured pool that probes ok yields connectionProxyUrl and strictProxy from the pool row`
3. `auth noauth: no pool configured yields connectionId "noauth" with no proxy (unchanged)`
4. `auth noauth: proxy url comes from the pool row, never from a hardcoded host or port`
5. `auth noauth: strictProxy from the pool row is preserved on the returned connection`

## Test seam (important)

`auth.js` reaches `getSettings`, `getProxyPools`, `resolveConnectionProxyConfig` at module scope. Existing tests already mock `@/lib/network/connectionProxy`. Import the probe through a thin indirection so the test can `vi.mock` it — do not call `probeProxyEgress` directly from the test.

## Constraints

- **Never** synthesize a proxy URL. Only `resolveConnectionProxyConfig` produces it.
- Do not write lock/cooldown state for `noauth` (index invariant 5).
- Terminal error must name the pool id and both remedies.

## Acceptance

- No code path returns a proxyless connection while a `proxyPoolId` is configured.
- Existing `noauth-proxy-fallback.test.js` contract at line 20-30 still passes.

## Verify

```bash
cd tests && npx vitest run unit/noauth-egress-resolution.test.js unit/noauth-proxy-fallback.test.js
```
