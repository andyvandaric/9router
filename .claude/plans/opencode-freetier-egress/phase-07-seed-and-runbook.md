# Phase 07 — Seed script + operator runbook

**Status**: ✅ Done (2026-10-22 12:18 (UTC+0700), Commits: `a14ff01b`, `79990894`, `ba64c975`)
**Author**: claude
**Confidence**: 97%
**Date**: 2026-10-20
**Target Files**: `scripts/seed-opencode-proxy-pool.mjs`, `docs/opencode-freetier-egress.md`

**Wave**: 3 | **Domain**: scripts + docs | **Files**: 2 (1 script + 1 doc)
**Depends on**: Phase 04 | **Unblocks**: none
**Completed Date**: 2026-10-22 12:18 (UTC+0700)
**Duration**: –
**Completed in**: `a14ff01b` (NEW `scripts/seed-opencode-proxy-pool.mjs` + NEW `tests/unit/seed-opencode-proxy-pool.test.js`, with `tests/unit/opencode-freetier-direct-replay.test.js` extended in the same commit), `79990894` and `ba64c975` (seed-script follow-ups). `docs/opencode-freetier-egress.md` exists on disk but is **untracked** — `.gitignore:52` ignores `docs/*` (only `!docs/ARCHITECTURE.md` is un-ignored).
**Reconciled 2026-10-22**: file reconciled against live disk. DEVIATION: `docs/opencode-freetier-egress.md` was written but never committed — the doc ships untracked only. The seed script deviates from the plan's standalone-test premise: Phase 10/11 chunk A folded the `providerStrategies.opencode = { proxyPoolId: "vpsease-main", rotateStrategy: "none" }` binding write and its own verification print into this script, so part of chunk A's substance lives here too.

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

No unit test at planning time (operational script). Changed in landing: `tests/unit/seed-opencode-proxy-pool.test.js` (NEW) landed with `a14ff01b` — a real, and security-relevant, test exists.

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
