# Phase 02 — 429 Quota Classifier & Egress Rotation

**Parent PRD:** [index.md](./index.md)
**Status:** 🟡 READY
**Completed Date:** _(blank — filled at execution)_
**Target Codebase:**
- `open-sse/utils/freeTierEgress.js` (AMEND — classifier; `FREETIER_KIND` L16)
- `open-sse/config/errorConfig.js` (AMEND — `ERROR_RULES` L59-83 only)
- `open-sse/executors/opencode.js` (AMEND — 429 site L433-439; egress-rotation pattern L445-473)
- `tests/unit/free-tier-egress-classify.test.js` (NEW — see Chunk 1 note: master index §5 L123 / §7 L134 imply this file may already exist; **UNVERIFIED** — executor MUST check `Glob` first and CREATE-or-AMEND, never overwrite blind)

**Verification:** `cd tests && npx vitest run unit/free-tier-egress-classify.test.js unit/opencode-egress-retry.test.js unit/model-catalog-scope.test.js` → 24/24 PASS (index §7 L134); then `node tests/__baseline__/verify-no-regression.mjs` → **0 NEW failures** against the E9 baseline (`326 passed / 44 failed 386 files; 3674 passed / 96 failed 3883 tests`).

---

## 🎯 1. Objective & Explicit Non-Goals

### Objective
Make the gateway recognise the OpenCode free-tier **per-IP quota** rejection — HTTP 429 with body `FreeUsageLimitError` — as a first-class, retryable kind (`FREETIER_KIND.quota`), and replace the executor's quota handling (today: evict the stable session and re-prepare once, at `open-sse/executors/opencode.js` L433-439) with the **existing bounded attempt pattern** already used for egress 403 (L445-473), so a quota block is retried within a finite budget instead of being swallowed. The measured failure chain is the whole justification: over 4 rounds on the same egress IP for `oc/deepseek-v4.1-flash-free`, the result was **1 OK / 3 FAIL**, and HTTP 200 returned only after the egress IP changed; retrying the *same* IP does not help (E3, measured 2026-10-22).

### Scope Guard (STRICT — Phase 02 MUST NOT touch)
1. `open-sse/providers/freeModelCatalog.js` — Phase 01 owns its schema. Phase 02 **consumes**, never edits. The SSOT already declares `FREE_MODEL_STATE.QUOTA_BLOCKED` (phase-01 L38) and a `429 → QUOTA_BLOCKED` branch (phase-01 L78); Phase 02 emits a **local** classifier kind and does not write back (DD-02-2).
2. `open-sse/utils/proxyFetch.js` — Phase 07 owns per-attempt egress selection and the `strictProxy` fix.
3. The five consumer sites — `src/app/api/providers/suggested-models/filters.js`, `open-sse/providers/capabilities.js`, `open-sse/providers/registry/opencode.js`, `open-sse/providers/registry/opencode-zen.js`, and the `combos` repair path (Phases 03-06).
4. No new DB tables, no DDL (E10). No `strictProxy` change (E7). No upstream merge (E1). No change to `MAX_EGRESS_ATTEMPTS` semantics for the 403 path.

### Recorded Design Decisions (explicit — master index §8 deliberately left these open; this phase resolves them and records the rationale)
- **DD-02-1 — Cooldown source (resolves master §8 Open Question 3).** Reuse `getQuotaCooldown(attempt)` (imported at `opencode.js` L11, defined at `open-sse/services/accountFallback.js` L9-13: `2000 * 2^(attempt-1)`, capped at `BACKOFF_CONFIG.max = 5 * 60 * 1000`, `errorConfig.js` L32-36). *Rationale:* the mechanism need is identical to the egress case — space bounded retries — and the function is already on the executor's import list. **Carried caveat (the master's Open Question 3 stays partly open):** quota recovery is **per-IP, not time-linear** (measured 1 OK / 3 FAIL then recovery after rotation, E3), so `getQuotaCooldown` is a **spacing device, not a recovery model**. Named verification step: on disk, read `open-sse/utils/proxyFetch.js` + the proxy-pool selection path and confirm whether a retry actually re-selects a **different** egress node. If it does **not**, the cap in DD-02-3 MUST be dropped to 1 (a same-IP backoff retry is pure added latency). Record the finding in this phase's `Completed Date` note.
- **DD-02-2 — `QUOTA_BLOCKED` stays local to the classifier.** Phase 02 emits `FREETIER_KIND.quota` (a value in `freeTierEgress.js`) and **does not** write into the Phase 01 SSOT. *Rationale:* Phase 02 demanding a schema change to `freeModelCatalog.js` would break the audit's exclusivity invariant (Phase 01 owns the module). The one-way convergence — wire value `FREETIER_KIND.quota` ↔ SSOT state `FREE_MODEL_STATE.QUOTA_BLOCKED` — is contractually asserted in this spec and wired by a later consumer phase.
- **DD-02-3 — Cap enforcement.** Introduce `const MAX_QUOTA_ATTEMPTS = 3;` next to `MAX_EGRESS_ATTEMPTS = 3` (`opencode.js` L32), with its **own** counter `quotaAttempt` — *not* shared with `egressAttempt`. *Rationale:* keeps the 403 egress path byte-for-byte unchanged so the `opencode-egress-retry` green baseline is untouched, and lets a future tuning of one kind not perturb the other. The loop is therefore bounded at **≤ `MAX_QUOTA_ATTEMPTS + MAX_EGRESS_ATTEMPTS` = 6 attempts** worst case (a mixed kind sequence); this is finite and asserted in Chunk 3.
- **DD-02-4 — Exhaustion behaviour: terminal PASSTHROUGH, not a rewritten error.** When `quotaAttempt` reaches `MAX_QUOTA_ATTEMPTS`, return the **final 429 `result` unchanged** (no `rewriteEgressRejection`). Contrast with the egress branch (L458-467), which *does* rewrite to a terminal actionable message. *Rationale:* (a) a 429 is self-describing and already maps to the client-facing `{type:"rate_limit_error", code:"rate_limit_exceeded"}` (`errorConfig.js` L9); (b) the free tier is credential-less (`Authorization: Bearer public`, `opencode.js` L499), so account rotation has no target — but the downstream combo/account-fallback layer still needs the **real** 429 status to fall to the next combo member; (c) the egress 403 rewrite exists only because it must name a **non-obvious** remedy (rotate the proxy node), which a 429 does not require; a quota rewrite would suppress the status semantics consumers depend on.
- **DD-02-5 — Text-rule priority.** The new `errorConfig.js` rule is a **text** rule and is inserted at the **top** of the text-rule block (after the `codex` provider rule, `errorConfig.js` L61), so no later text rule can shadow it. *Rationale:* `ERROR_RULES` is documented as "text rules first (by order), then status rules" (L52) — so any text rule is automatically ordered **before** the `{status:429, backoff:true}` fallback (L82); placement at the top additionally guarantees precedence over the generic `{text:"rate limit"}` (L65) and `{text:"quota exceeded"}` (L67) rules.

---

## 🏛️ 2. Architectural Specification

### Classifier extension (`open-sse/utils/freeTierEgress.js`)
`FREETIER_KIND` today (L16, VERIFIED this turn):
```js
export const FREETIER_KIND = { fingerprint: "client_fingerprint", egress: "egress_abuse" };
```
Becomes:
```js
export const FREETIER_KIND = { fingerprint: "client_fingerprint", egress: "egress_abuse", quota: "quota_exhausted" };
```
`classifyFreeTierRejection(response)` today (L47-54, VERIFIED) is **403-only**: it early-returns `null` for any `response?.status !== HTTP_STATUS.FORBIDDEN` (L48) and only ever reads `FINGERPRINT_PHRASE` / `EGRESS_PHRASE` (L21-22). Phase 02 extends it — **without renaming** — to add a 429 branch:

```
classifyFreeTierRejection(response)
   status 403 + "can only be used from within OpenCode"        ──► FREETIER_KIND.fingerprint   (unchanged)
   status 403 + "detected abusive traffic from this IP address"──► FREETIER_KIND.egress        (unchanged)
   status 429 + body text matches FreeUsageLimitError          ──► FREETIER_KIND.quota          (NEW)
   otherwise                                                   ──► null                          (unchanged)
```

New module-level `const QUOTA_PHRASE = "FreeUsageLimitError";` mirroring the verbatim-capture convention of L19-22 (do not paraphrase). Matching stays message-text-only, case-insensitive, via the existing `textMatches()` (L38-41). **403 precedence is preserved:** the fingerprint phrase must still outrank the egress phrase (L19-20 comment); the quota branch is status-gated (429) and cannot collide with either 403 phrase.

### Rule insert (`open-sse/config/errorConfig.js`, `ERROR_RULES` L59-83)
Insert, as the first text rule after `codex` (i.e. immediately after L61):
```js
  // Free-tier PER-IP quota (HTTP 429 "FreeUsageLimitError"). Text rule, so it
  // orders before the {status:429} fallback below; the quota retry loop owns
  // the bounded attempt budget, and the cooldown is spacing only (DD-02-1).
  { text: "freeusagelimiterror", backoff: true },
```
Position verified: all text rules sit above the `--- Status-based rules ---` divider (L77) and the `{status:429, backoff:true}` fallback (L82, VERIFIED). No status rule is reordered.

### Executor restructure (`open-sse/executors/opencode.js` `execute()` L419-474)
Preserve every existing branch, add exactly one. Current control flow (VERIFIED this turn):
- L422 `let rotatedForRateLimit = false;` / L423 `rotatedForFingerprint` / L424 `egressAttempt = 1`
- L433-439: 429 → `evictStableSession` + one re-prepare + `continue` (rotates the **session**, once)
- L445 `const kind = await classifyFreeTierRejection(response);`
- L446-452: fingerprint → evict + re-prepare, once
- L453: `if (kind !== FREETIER_KIND.egress) return result;`
- L458-467: egress cap reached → `rewriteEgressRejection(...)` terminal
- L469-472: evict + re-prepare + `await sleepUnlessAborted(getQuotaCooldown(egressAttempt), args?.signal)`, `egressAttempt++`

Phase 02 adds a `quotaAttempt` counter (L424 region) and a quota branch. **Ordering is load-bearing:** the 429 fast-path (L433-439) must only retain non-quota 429s, so the body must be classified before the generic session-eviction retry consumes the 429:

```
for (;;)
  result = await super.execute(...)
  if session source !== stable → return result          (L427 unchanged)
  kind = await classifyFreeTierRejection(response)      (hoisted above L433)

  kind === quota      → if (quotaAttempt >= MAX_QUOTA_ATTEMPTS) return result   (PASSTHROUGH, DD-02-4)
                        evictStableSession(prepared); prepared = re-prepare
                        if (await sleepUnlessAborted(getQuotaCooldown(quotaAttempt), signal)) return result
                        quotaAttempt++; continue

  response.status 429  → existing L433-439 session-eviction, once  (non-quota 429, unchanged)
  kind === fingerprint → existing L446-452, once                  (unchanged)
  kind === egress      → existing L453-472 block                  (unchanged)
  otherwise            → return result
```

**Evidence correction (report in spec, executor must respect):** the master index §5 L123 / §7 L150 phrases the reused pattern as "retry rotates EGRESS". On disk the existing block (L455-457 comment) is *"retry the **same** egress with bounded exponential backoff"* — it does **not** rotate the egress node; the executor has **no** per-attempt egress re-selection, and `prepareRequestCredentials(args)` (L369-378) only re-mints the session. Whether egress actually changes across attempts depends on `proxyFetch.js` / the proxy pool (Phase 07) and is **UNVERIFIED** — this is exactly the named verification step in DD-02-1.

Line drift audit (VERIFIED on disk this turn, master claims confirmed):
- `freeTierEgress.js:16` `FREETIER_KIND` ✓ ; classifier entry `L47` ✓ ; 403-only gate `L48` ✓
- `errorConfig.js` `ERROR_RULES` L59-83 ✓ ; `{status:429}` fallback `L82` ✓
- `opencode.js` 429 site **L433-439** ✓ (exact) ; egress pattern **L445-473** ✓ (exact) ; `MAX_EGRESS_ATTEMPTS` **L32** ✓
- `accountFallback.js` `getQuotaCooldown` **L9-13** ✓

No line-number corrections were required; the only correction is the semantic "rotates EGRESS" claim above.

---

## 🎨 3. Visual & Interface Design (terminal — no web UI)

**BEFORE — quota reads as a generic rate limit, retried on the same identity:**
```
$ # oc/deepseek-v4.1-flash-free, 4 rounds, SAME egress IP (E3, 2026-10-22)
round 1  -> 429 FreeUsageLimitError   (executor L433: evict session, re-prepare, continue)
round 2  -> 429 FreeUsageLimitError   (L434: rotatedForRateLimit true -> return raw 429)
round 3  -> 429 FreeUsageLimitError
round 4  -> 429 FreeUsageLimitError
after egress IP change:
round 5  -> 200 OK
```
Classification: `classifyFreeTierRejection(429 ...)` returns `null` (L48) — the kind is invisible and the quota case never enters the bounded-retry block.

**AFTER — quota is a named, bounded, actionable kind:**
```
$ node -e "import('./open-sse/utils/freeTierEgress.js').then(m=>console.log(m.FREETIER_KIND))"
{ fingerprint: 'client_fingerprint', egress: 'egress_abuse', quota: 'quota_exhausted' }

$ # oc/deepseek-v4.1-flash-free, SAME egress IP
round 1  -> 429 FreeUsageLimitError  -> kind=quota  quotaAttempt 1/3  wait getQuotaCooldown(1)=2000ms
round 2  -> 429 FreeUsageLimitError  -> kind=quota  quotaAttempt 2/3  wait getQuotaCooldown(2)=4000ms
round 3  -> 429 FreeUsageLimitError  -> kind=quota  quotaAttempt 3/3  cap -> PASSTHROUGH raw 429 (DD-02-4)
```
No new UI. Terminal only.

---

## 🧪 4. Test Strategy & TDD Red-Green-Refactor (HARD RULE)

**Step 1 — RED.** Write the 429 assertion first in `tests/unit/free-tier-egress-classify.test.js` (create-or-amend — see Chunk 1 note): `classifyFreeTierRejection(new Response(<FreeUsageLimitError body>, {status:429}))` must equal `FREETIER_KIND.quota`. Run; confirm it fails for the expected reason (`undefined`/`null` — kind absent), not setup noise.
**Step 2 — GREEN.** Extend `freeTierEgress.js` (QUOTA_PHRASE + 429 branch), add the `errorConfig.js` rule, add the executor quota branch + `MAX_QUOTA_ATTEMPTS`.
**Step 3 — REFACTOR.** Keep tests green while enforcing ≤50 lines/function, ≤3 nesting levels, 300 LOC warn / 500 LOC block.

### Named test cases
1. **429 → quota** — `classifyFreeTierRejection(<429 FreeUsageLimitError>)` === `FREETIER_KIND.quota`.
2. **Regressions preserved** — 403 fingerprint body still → `fingerprint`; 403 egress body still → `egress`; 403 body containing **both** phrases still → `fingerprint` (L19-20 precedence); non-403/429 (e.g. 500) → `null`.
3. **Quota body without the phrase** — 429 with unrelated text → `null` (no false positive), and the executor returns the raw 429 (generic-429 session-eviction path L433-439 survives, once).
4. **Rule ordering** — assert the new text rule index sits **before** the `{status:429}` entry in `ERROR_RULES`, and that `resolveCooldown(429, "FreeUsageLimitError")` (via `accountFallback.js`) resolves `backoff: true` (family from `getQuotaCooldown`), not the status fallback.
5. **Bounded cap** — a mock executor that always answers 429 `FreeUsageLimitError` is called at most `MAX_QUOTA_ATTEMPTS` (3) times, then the third result is returned **unrewritten** and with `status === 429` (DD-02-4 passthrough).
6. **Cap does not leak into egress** — a mock returning 403 egress still terminates at `MAX_EGRESS_ATTEMPTS`, and the `opencode-egress-retry` baseline stays green.
7. **Abort-during-wait** — an aborted signal during `getQuotaCooldown` wait returns the current result rather than looping (mirrors `sleepUnlessAborted` L471 semantics).

**Regression Guard Assertion:** assert the fingerprint-over-egress precedence (test 2) and the cap bound (test 5) — these guard the two contracts most likely to be silently broken by the executor restructure.
**Anti-Test-Tampering:** never weaken, delete, or skip a failing assertion; a red test means fix the source, never the assertion.
**Definition of Done:** **0 NEW failures against the 96-failure baseline (E9)** — not "all green". Focused run: `cd tests && npx vitest run unit/free-tier-egress-classify.test.js unit/opencode-egress-retry.test.js unit/model-catalog-scope.test.js` → 24/24; then `node tests/__baseline__/verify-no-regression.mjs`.

---

## 📦 5. Micro-Chunk Dispatch Units

All chunks touch the **same 3 shared source files** (`freeTierEgress.js`, `errorConfig.js`, `opencode.js`) plus the one test file, so they share a file boundary and MUST execute **sequentially** — never parallel. ONE chunk per sub-agent dispatch turn.

### 📦 Chunk 1: Classifier + rule + RED test (domain: open-sse/utils + config)
- **Target File(s):** `open-sse/utils/freeTierEgress.js` [AMEND], `open-sse/config/errorConfig.js` [AMEND], `tests/unit/free-tier-egress-classify.test.js` [NEW — **Glob first**; CREATE if absent, AMEND if the master's green-baseline reference means it already exists]
- **Scope Boundary:** 2 source files + 1 test only (named tests 1, 2, 4)
- **Exact Task:** (1) add `quota: "quota_exhausted"` to `FREETIER_KIND` (L16) and a status-429 `QUOTA_PHRASE` branch to `classifyFreeTierRejection` (L47-54), preserving the 403 fingerprint-over-egress precedence; (2) insert the `{ text: "freeusagelimiterror", backoff: true }` rule at the top of the text block (after L61), above the `{status:429}` fallback (L82).
- **Deterministic Verification:** `cd tests && npx vitest run unit/free-tier-egress-classify.test.js`
- **Expected Output:** PASS
- **DoD:** 0 NEW failures vs baseline.

### 📦 Chunk 2: Executor quota branch + bounded cap (domain: open-sse/executors)
- **Target File(s):** `open-sse/executors/opencode.js` [AMEND], `tests/unit/free-tier-egress-classify.test.js` [AMEND]
- **Scope Boundary:** 1 source file + 1 test only (named tests 3, 5, 6, 7)
- **Exact Task:** hoist `classifyFreeTierRejection` above the 429 fast-path; add `MAX_QUOTA_ATTEMPTS = 3` (L32 region) + `quotaAttempt` counter; add the quota branch (evict + re-prepare + `getQuotaCooldown(quotaAttempt)` spacing) with **passthrough** on cap exhaustion (DD-02-4); leave the L433-439 generic-429, fingerprint, and egress paths byte-for-byte unchanged.
- **Deterministic Verification:** `cd tests && npx vitest run unit/free-tier-egress-classify.test.js unit/opencode-egress-retry.test.js`
- **Expected Output:** PASS (incl. the untouched egress-retry baseline)
- **DoD:** 0 NEW failures vs baseline; the egress path and its cap are provably unchanged.

### 📦 Chunk 3: Verification pass + regression gate (domain: tests)
- **Target File(s):** `tests/unit/free-tier-egress-classify.test.js` [AMEND — regression-guard assertions]
- **Scope Boundary:** 1 test file only (regression guard + full 24/24 chain)
- **Exact Task:** add the fingerprint-precedence and cap-bound regression guards; run the full 3-file chain; confirm ≤6-attempt worst-case bound is asserted and the DD-02-1 named verification step (`proxyFetch.js` / proxy-pool re-selection read) is recorded in the `Completed Date` note.
- **Deterministic Verification:** `cd tests && npx vitest run unit/free-tier-egress-classify.test.js unit/opencode-egress-retry.test.js unit/model-catalog-scope.test.js && node tests/__baseline__/verify-no-regression.mjs`
- **Expected Output:** 24/24 PASS; 0 NEW failures
- **DoD:** all DoD items below checked.

---

## ✅ 6. Definition of Done (DoD) Checklist

- [ ] `FREETIER_KIND.quota` exists (`freeTierEgress.js` L16); `classifyFreeTierRejection` returns it for a 429 `FreeUsageLimitError` body and still returns `fingerprint`/`egress`/`null` for the existing cases (403 precedence intact).
- [ ] `errorConfig.js` `ERROR_RULES` carries the new text rule ordered **before** the `{status:429}` fallback; no status rule reordered.
- [ ] Executor 429 site (L433-439) no longer swallows a quota 429; the quota branch reuses `getQuotaCooldown` + cap semantics; the generic-429/fingerprint/egress branches are unchanged.
- [ ] Cap is explicitly bounded: `MAX_QUOTA_ATTEMPTS = 3` with its own `quotaAttempt`; worst-case ≤ `MAX_EGRESS_ATTEMPTS + MAX_QUOTA_ATTEMPTS` = 6 attempts, asserted; **no unbounded loop**.
- [ ] Exhaustion behaviour asserted: terminal **passthrough** of the raw 429 (DD-02-4), not a rewritten error.
- [ ] DD-02-1 named verification step executed and its result recorded (does a retry change the egress node? if not, cap → 1).
- [ ] No write to `freeModelCatalog.js`, no `proxyFetch.js` touch, no consumer-site touch, no DDL, no `strictProxy` change.
- [ ] `cd tests && npx vitest run unit/free-tier-egress-classify.test.js unit/opencode-egress-retry.test.js unit/model-catalog-scope.test.js` → 24/24 PASS.
- [ ] `verify-no-regression.mjs` → **0 NEW failures** vs the 96-failure baseline (E9).
- [ ] ≤50 lines/function, ≤3 nesting levels, ≤300 LOC warn / 500 block; single conventional commit `feat(free-tier-egress): classify 429 quota and bound the quota retry [phase-02]`.

**Blockers:** Phase 01 (`open-sse/providers/freeModelCatalog.js`) is **NOT** required — Phase 02 is a pure classifier/executor change. Phase 01's six-state enum already reserves `QUOTA_BLOCKED`, so the two converge without coupling (DD-02-2).

**Open Questions:**
1. **Does a bounded retry actually change the egress node?** The executor has no per-attempt egress re-selection (verified: `prepareRequestCredentials` L369-378 only re-mints the session); the existing 403 block's own comment (L455-457) says it retries the **same** egress. If `proxyFetch.js` / the proxy pool does not re-select on retry, this phase's retry is pure added latency and the cap must be 1. Named verification step in DD-02-1; result recorded at execution.
2. **`tests/unit/free-tier-egress-classify.test.js` existence.** Master index §7 L134 cites a 24/24 green baseline spanning this filename, which implies it exists — but no read confirmed it. Chunk 1 Globs first and CREATE-or-AMEND accordingly.
