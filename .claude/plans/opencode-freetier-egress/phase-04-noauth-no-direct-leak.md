# Phase 04 — noauth selection must never leak direct

**Status**: PROPOSED
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
