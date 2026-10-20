# Phase 07 — Seed script + operator runbook

**Status**: PROPOSED
**Author**: claude
**Confidence**: 97%
**Date**: 2026-10-20
**Target Files**: `scripts/seed-opencode-proxy-pool.mjs`, `docs/opencode-freetier-egress.md`

**Wave**: 3 | **Domain**: scripts + docs | **Files**: 2 (1 script + 1 doc)
**Depends on**: Phase 04 | **Unblocks**: none

## Part A — Fix the real reason VPSEase never took effect

Two defects in the existing `scripts/setup-vpsease-proxy.mjs` were confirmed by disk inspection:

| Defect | Evidence | Effect |
|---|---|---|
| **Path mismatch** | script hardcodes `%APPDATA%/9router/db/data.sqlite` (`:7-8`) but runtime resolves `DATA_DIR/db/data.sqlite` (`src/lib/db/paths.js:5-6`, `dataDir.js:14-16`) | if `DATA_DIR` is set, the script writes to a different file than the running server reads |
| **Wrong `rotateStrategy`** | script writes `rotateStrategy: "round-robin"` (`:52-55`) | `auth.js:51-62` overwrites the pinned `proxyPoolId` by rotating across ALL active pools — the pin silently loses effect |

**Correct pinning requires `rotateStrategy: "none"`.**

## Files

- `scripts/seed-opencode-proxy-pool.mjs` (NEW — replaces the old script's role)
- `docs/opencode-freetier-egress.md` (NEW)

## Implementation requirements

- Resolve the DB through the same SSOT the runtime uses (`DATA_DIR` → `src/lib/db/paths.js`). Do **not** hardcode `%APPDATA%`.
- Use repo APIs, not raw SQL: `createProxyPool` (`src/lib/db/repos/proxyPoolsRepo.js:59`) and `updateSettings` (`src/lib/db/repos/settingsRepo.js:110`).
- Write `providerStrategies.opencode = { proxyPoolId, rotateStrategy: "none" }`.
- Idempotent: running twice yields one pool row and one settings entry.
- Refuse to overwrite a *different* already-configured pool unless `--force`.
- `127.0.0.1:20808` appears **only here and in the doc** — never in runtime code.

## Part B — Runbook contents

- Why egress matters for OpenCode Free (IP reputation, not the account).
- The two FreeTierError variants and what each means.
- How to seed, how to verify (dashboard + DB query).
- What each terminal error means and the exact remedy.
- Note: `?dns=local` is a 9router transport opt-in, not a VPSEase requirement.
- Note: VPSEase prod only; dev/staging ports are out of scope for buyer distributions.

## TDD

No unit test (operational script). Instead: run twice against a scratch DB and assert one row; verify the settings blob shape; verify the old broken script is either deleted or clearly marked superseded.

## Acceptance

- Running twice → 1 pool row, 1 settings entry.
- `node --check` clean.
- Doc mentions no hardcoded port outside the seeding example.

## Verify

```bash
node --check scripts/seed-opencode-proxy-pool.mjs
node scripts/seed-opencode-proxy-pool.mjs && node scripts/seed-opencode-proxy-pool.mjs
# then assert row count == 1
```
