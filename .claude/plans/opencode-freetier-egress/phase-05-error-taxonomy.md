# Phase 05 — Error taxonomy for both FreeTierError variants

**Status**: IN PROGRESS
**Author**: claude
**Confidence**: 97%
**Date**: 2026-10-20
**Target Files**: `open-sse/config/errorConfig.js`, `tests/unit/error-config-freetier.test.js`

**Wave**: 1 | **Domain**: open-sse/config | **Files**: 1 source + 1 test
**Depends on**: none | **Unblocks**: Phase 06

## Goal

`checkFallbackError()` sees both variants explicitly instead of falling through to the bare `status: 403` rule.

## Files

- `open-sse/config/errorConfig.js` (EDIT `ERROR_RULES`, ~59-77)
- `tests/unit/error-config-freetier.test.js` (NEW)

## Change

Insert **above** the `{ status: 403, cooldownMs: COOLDOWN.long }` rule:

```js
// Egress blocked by IP reputation — transient, worth retrying with backoff.
{ text: "abusive traffic", backoff: true },
// Client fingerprint rejected — retrying cannot fix identity; fail fast.
{ text: "can only be used from within opencode", cooldownMs: COOLDOWN.long },
```

Order matters: text rules are evaluated before status rules, and the fingerprint rule must win when both phrases appear.

## TDD — tests written FIRST (must fail)

1. `errorConfig: "abusive traffic" matches a backoff rule before the status-403 rule`
2. `errorConfig: "can only be used from within opencode" matches the non-retry rule, not backoff`
3. `errorConfig: both phrases present resolves to the fingerprint rule (fail fast)`
4. `errorConfig: unrelated 403 still resolves to the long cooldown` ← regression
5. `errorConfig: existing rate-limit text rules keep their precedence` ← regression

## Constraints

- Do **not** reorder or edit any existing rule.
- Lowercase matching only (`checkFallbackError` lowercases input at `accountFallback.js:24-26`).
- Keep the fingerprint rule after the egress rule so egress backoff is chosen when both appear — wait: reverse. Both-phrases → fingerprint wins, so the fingerprint rule must be **first**. Verify with test 3 before implementing.

> **Ordering note for the executor:** test 3 pins the intended resolution. Write the test, run it, then place the rules so it passes — do not guess.

## Acceptance

- All 5 tests pass; no existing rule text changed.
- `getQuotaCooldown()` drives the backoff (via `backoff: true`), no new curve.

## Verify

```bash
cd tests && npx vitest run unit/error-config-freetier.test.js unit/account-fallback-4xx.test.js
```
