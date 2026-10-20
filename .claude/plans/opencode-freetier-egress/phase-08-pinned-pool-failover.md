# Phase 08 — Pinned-pool failover (port of PR #5046)

**Status**: PROPOSED
**Author**: claude
**Confidence**: 97%
**Date**: 2026-10-20
**Target Files**: `src/sse/services/auth.js`, `tests/unit/noauth-pinned-pool-failover.test.js`

**Wave**: 4 | **Domain**: src/sse/services | **Files**: 1 source (+ its test)
**Depends on**: Phase 04, Phase 06 | **Unblocks**: none

## Goal

For users with **multiple** active pools: when the pinned pool is excluded after a fallbackable error, try the next healthy pool instead of `return null`.

## Upstream source

`decolua/9router#5046` — "fix(auth): fail over from a pinned proxy pool on fallbackable errors" (anojndr, open, +277/−5 across 7 files, ships `tests/unit/noauth-pinned-pool-failover.test.js`).

**Port it, do not rewrite it.** If the cherry-pick applies cleanly, take it as-is. Only hand-edit on conflict.

## What it does

- Pinned pool excluded → select the next active pool with a `proxyUrl` from `getProxyPools({isActive:true})`.
- Exclusion set is per-request and grows per failed attempt → natural walk of the list.
- `strictProxy` untouched: failover stays proxy→proxy, never direct.
- Fail-closed at the end (returns null when every candidate is excluded).

## Interaction with Phase 04 (must be reconciled)

Phase 04 says: configured pool unusable → **terminal error, never direct**.
Phase 08 says: configured pool excluded → **try another pool**.

These agree. The rule is:

```
if another active pool exists  → try it        (Phase 08)
else                         → terminal error (Phase 04 / 06 renderer)
never                        → direct
```

## Note on the current deployment

VPSEase has exactly **one** local inbound (`127.0.0.1:20808`; no second mixed inbound). So on this machine Phase 08 currently has **no second candidate** — it collapses to the terminal-error path. Port it anyway: it is correct for buyers who configure multiple pools, and it is upstream-maintained.

## TDD — tests (ported + local)

From #5046:
1. `auth noauth: uses the pinned pool while it is healthy`
2. `auth noauth: pinned pool excluded after a 403 falls over to another active pool`
3. `auth noauth: walks past a second excluded pool`
4. `auth noauth: returns null only when every candidate is excluded`
5. `auth noauth: skips pools without a proxyUrl`

Local additions:
6. `auth noauth: single-pool deployment reports no-failover rather than looping`
7. `auth noauth: failover never selects a direct/unproxied candidate` ← enforces index invariant 3

## Acceptance

- Multi-pool: failover proxy→proxy works; single-pool: no loop, terminal error.
- No direct egress introduced by the port.

## Verify

```bash
cd tests && npx vitest run unit/noauth-pinned-pool-failover.test.js unit/noauth-proxy-fallback.test.js
node __baseline__/verify-providers.mjs && node __baseline__/verify-alias.mjs
```
