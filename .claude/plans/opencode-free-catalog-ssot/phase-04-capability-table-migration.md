# Phase 04 — Migrate Consumer 2: Free-Model Capability Table (`capabilities.js`)

**Parent PRD:** [index.md](./index.md)
**Status:** 🟡 READY
**Completed Date:** _(blank — filled at execution)_
**Target Codebase:**
- `open-sse/providers/capabilities.js` (AMEND — prune 9 stale free rows, narrow the over-broad free pattern, resolve the missing upstream free ids)
- `tests/unit/free-model-capabilities.test.js` (NEW — SSOT-alignment guard for the free rows)
- `tests/unit/capabilities.test.js` (AMEND — retarget the assertions that encode the pruned ids; see DD-04-7)

**Verification:** `cd tests && npx vitest run unit/free-model-capabilities.test.js unit/capabilities.test.js` → 100% PASS; then `cd tests && npx vitest run unit/model-catalog-scope.test.js unit/combo-caps-resolver.test.js unit/opencode-free-thinking-format.test.js` → PASS; then `node tests/__baseline__/verify-no-regression.mjs` → 0 NEW failures against the E9 baseline (326 passed / 44 failed of 386 files; 3674 passed / 96 failed of 3883 tests).

---

## 🎯 1. Objective & Explicit Non-Goals

### Objective
Make the hand-written capability table stop contradicting the free-model SSOT at the one site that drifts worst: `open-sse/providers/capabilities.js` carries 12 free rows, 9 of whose ids are in no upstream free lane (two of them — `muse-spark-1.2-contributor-free`, `muse-spark-1.3-contributor-free` — still advertise `vision: true, contextWindow: 1048576` for models upstream answers with **HTTP 410 `ModelDeprecated`**), while 8 upstream free ids have no row and a `-vl-` vision model resolves as text-only. Deliverable: 0 rows for a non-`ALIVE` SSOT pair, a row only where the pattern/catalog layers are actually wrong, and the non-free rows byte-identical.

### Scope Guard (STRICT — Phase 04 MUST NOT touch)
1. The other four consumer sites: `src/app/api/providers/suggested-models/filters.js` and its route (Phase 03), `open-sse/providers/registry/opencode.js` and `opencode-zen.js` (Phase 05), the `combos` table repair path (Phase 06).
2. The 429 quota classifier — `open-sse/utils/freeTierEgress.js`, `open-sse/config/errorConfig.js`, `open-sse/executors/opencode.js` (Phase 02), and `open-sse/utils/proxyFetch.js` (Phase 07).
3. The SSOT module's own schema/exports — `open-sse/providers/freeModelCatalog.js` is Phase 01's file and is consumed here **read-only and test-time only** (DD-04-1).
4. **Non-free rows are NOT in scope.** Every row that is not one of the 9 stale ids stays byte-identical: e.g. `space-bunny`, `longcat-2.0`, `union-alpha`, all Claude/GPT/Gemini/Kimi/GLM rows, every `PROVIDER_CAPABILITIES` block, the `DEFAULT_CAPABILITIES` floor, and `PATTERN_CAPABILITIES` entries other than the one broad free pattern named in DD-04-5. No new DB tables, no DDL, no `strictProxy` change, no hand-edit of the auto-generated `open-sse/providers/registry/index.js`.

### Recorded Design Decisions (explicit)
- **DD-04-1 — Coupling is TEST-TIME ONLY.** `capabilities.js` must never `import` `freeModelCatalog.js` at runtime. Phase 01's module mirrors `catalogOverride.js` L32-50 (an `fs.statSync` mtime cache) while `capabilities.js` is bundled into the browser (its own header comment at L1-12; the `globalThis` slot at the catalog-source seam). A runtime import would drag `node:fs` into the client bundle. The SSOT is consulted by the test, and by the verifier's Phase 07 five-way agreement test.
- **DD-04-2 — PRUNE, do not merge.** The free rows stay in the hand-maintained table and are pruned against the SSOT; the already-wired `open-sse/providers/catalogOverride.js` (`getCatalogModalities` / `getCatalogLimits`, refreshed daily by `src/lib/modelCatalog/sync.js`) keeps composing additively through the existing `refine()` seam. *Rationale:* merging the free rows into the synced catalog source would force file I/O into a browser-bundled module (DD-04-1) and would let a models.dev delta silently overwrite a gateway-observed limit. *Risk:* the table remains hand-maintained and can re-drift — mitigated by the guard assertions in §4 and by Phase 07's five-way agreement test.
- **DD-04-3 — Absence is the default; a row is an exception.** A free id gets a row **iff** (a) its SSOT state is `ALIVE` on at least one lane **and** (b) the pattern layer or the synced catalog resolves it incorrectly or not at all. Otherwise absence is the correct answer — the table is an exception table, not a mirror of `listFreeModels()`. Every added or retained free row carries a one-line comment naming its `(lane, state)`. This is what stops the migration from creating a sixth drift site.
- **DD-04-4 — Lane keying rides the existing provider axis.** `getCapabilitiesForModel(provider, model)` is unchanged (`(provider, model) => capability object`); the lane→provider map is `{ inference: "opencode" (alias `oc`, L400), zen: "opencode-zen", go: "opencode-go" }`. A lane-invariant free id lives in global `MODEL_CAPABILITIES` (so `refine()` overlays the synced catalog). A lane-divergent id lives in `PROVIDER_CAPABILITIES[<laneProvider>]` — and because step 1 short-circuits before `refine()` (`getCapabilitiesForModel` L767-771), such a row **must restate every limit it would otherwise inherit**, exactly as the existing `opencode-go` / `commandcode` rows document.
- **DD-04-5 — Deleting rows is NOT sufficient.** A broad pattern re-advertises a pruned id: the `*muse*spark*` entry in `PATTERN_CAPABILITIES` matches `muse-spark-1.2-contributor-free` / `muse-spark-1.3-contributor-free` and re-claims `vision: true, contextWindow: 1048576` for both 410 models even after their exact rows are removed. The pattern is narrowed to the ALIVE non-free form so the dead ids fall through to `DEFAULT_CAPABILITIES`. *Trade-off:* a dead id resolves at the floor (`reasoning: false`) instead of a fabricated claim — acceptable because no consumer offers a non-`ALIVE` id after Phase 03, and under-claiming a non-existent model is strictly safer than over-claiming it.
- **DD-04-6 — The `glm-5.3-flash-free` duplicate is divergent, and stays divergent on purpose.** The global row (L157) declares `maxOutput: 128000`; the `"opencode"` override block (~L257) declares `maxOutput: 131072` for the same id. The override is the lane-observed value and wins for `opencode`/`oc` (step 1 short-circuit); the global value is the one `opencode-zen` inherits, because zen has no override. Both are kept, each annotated with the lane it serves, and both values are asserted per lane so neither silently drifts.
- **DD-04-7 — The existing test file is a declared target.** `tests/unit/capabilities.test.js` asserts the pre-migration values of pruned ids (`space-bunny-free`, `exo-free`, and the muse free forms). The PRD standard's **Cascading Test Target Mandate** (§4.5) makes any test file carrying such assertions a mandatory target of the chunk that changes the catalog; leaving it out makes the phase DoD ("0 NEW failures") unachievable. The amendment **retargets** those assertions to the post-migration contract — it never deletes a check and never weakens one.

---

## 🏛️ 2. Architectural Specification

### Lookup API (unchanged — no new exports)
`getCapabilitiesForModel(provider, model) → object` (already complete because every result is merged over `DEFAULT_CAPABILITIES`). Resolution order is untouched: provider override → exact `MODEL_CAPABILITIES` → first-match `PATTERN_CAPABILITIES` → default floor, with `refine()` overlaying catalog modalities and limits on the last three paths only.

### The three edits
1. **Prune (9 keys removed from `MODEL_CAPABILITIES`, exactly these):** `muse-spark-1.2-contributor-free`, `muse-spark-1.3-contributor-free`, `space-bunny-free`, `exo-free`, `fledge-alpha-free`, `longcat-2.0-free`, `longcat-2.5-preview-free`, `north-mini-code-free`, `x-preview-f-free`. Nothing else in the file is reordered or reformatted.
2. **Narrow (DD-04-5):** the `*muse*spark*` pattern entry is restricted to the ALIVE non-free form so the two 410 free ids resolve at the floor.
3. **Resolve the missing upstream free ids (DD-04-3 triage)** — per id, in this order: synced catalog via `catalogOverride.js` → existing pattern if correct → a new exact row only if both are wrong/absent.
   | Upstream free id | Resolved by | Action |
   |---|---|---|
   | `nemotron-3.5-super-vl-free` | `*nemotron*` pattern only ⇒ `vision: false` | **ADD** exact row (a VL model advertised as text-only is the one evidenced gap) |
   | `flint-40b-free`, `beam-free`, `jev-1.13-free` | no pattern; not `ALIVE` on the chat lane | **NO ROW** (absence is correct — DD-04-3) |
   | `mimo-v2.6-flash-free`, `deepseek-v4.1-flash-free` | `*mimo*v2.6*`, `*deepseek-v4.*` patterns already correct | **NO ROW** |
   | `nemotron-3.5-lightning-free` | `*nemotron*` pattern acceptable | **NO ROW** |
   | `big-pickle` | already has a row in the table (asserted today by `tests/unit/capabilities.test.js`) | **AUDIT** — reconcile the evidence packet's "no row" claim against disk at chunk start (§Open Questions 1) |

   Chunk 3 step 1 is a line audit of the file's free-row region that must complete before any row is added, so the add-set is confirmed against disk rather than the packet.

### Reappearance prevention
Three layers, all deterministic: (a) the guard assertion that no row exists for any id whose SSOT state is not `ALIVE` on any lane; (b) the justification-comment rule in DD-04-3, checked by the reviewer; (c) the pattern narrowing in DD-04-5, which removes the second advertisement path. A future re-add is caught by (a) as a test failure, not by convention.

---

## 🎨 3. Visual & Interface Design (terminal — no web UI)

**BEFORE — the table contradicts upstream on both axes:**
```
$ node -e "…getCapabilitiesForModel('opencode','muse-spark-1.2-contributor-free')"
{ vision: true, reasoning: true, thinkingFormat: 'openai', contextWindow: 1048576, maxOutput: 131072 }
        ↑ upstream answers this id with HTTP 410 ModelDeprecated — a 1 MiB vision claim for a model that does not exist

$ node -e "…getCapabilitiesForModel('opencode','nemotron-3.5-super-vl-free')"
{ vision: false, reasoning: true, contextWindow: 128000, maxOutput: 64000 }
        ↑ a published vision-language model, advertised as text-only

$ node -e "…getCapabilitiesForModel('opencode-zen','glm-5.3-flash-free')"
{ …, contextWindow: 1000000, maxOutput: 128000 }   ← global row; provider 'opencode' returns 131072 for the same id (undocumented divergence)
```

**AFTER — every free row is SSOT-consistent, absence is deliberate:**
```
$ node -e "…getState('inference','muse-spark-1.2-contributor-free')"
{ state: 'DEPRECATED', deadReason: 'HTTP 410 ModelDeprecated', replacement: { lane: 'go', modelId: 'muse-spark-1.3-contributor' } }

$ node -e "…getCapabilitiesForModel('opencode','muse-spark-1.2-contributor-free')"
{ vision: false, reasoning: false, contextWindow: 200000, maxOutput: 64000 }   ← DEFAULT floor: no claim survives for a dead id

$ node -e "…getCapabilitiesForModel('opencode-go','nemotron-3.5-super-vl-free')"
{ vision: true, reasoning: true, contextWindow: 128000, maxOutput: 64000 }     ← added row

$ node -e "…getCapabilitiesForModel('opencode','glm-5.3-flash-free').maxOutput"      → 131072   (lane 'inference' / 'oc')
$ node -e "…getCapabilitiesForModel('opencode-zen','glm-5.3-flash-free').maxOutput"  → 128000   (lane 'zen'; no override — DD-04-6)
```

---

## 🧪 4. Test Strategy & TDD Red-Green-Refactor (HARD RULE)

**Step 1 — RED.** Author `tests/unit/free-model-capabilities.test.js` first; run it and confirm it fails because the stale rows are still present, not for setup/import noise.
**Step 2 — GREEN.** Make the minimal table edit (prune / narrow / add) that satisfies each assertion.
**Step 3 — REFACTOR.** Keep tests green; the file is already over the 500-LOC block threshold, so this phase must produce a **net size reduction** — no reformatting, no reordering, no comment churn beyond the free rows.

### Named assertions
1. **no dead rows** — for each of the 9 stale ids, `MODEL_CAPABILITIES[id] === undefined`; the same for every `PROVIDER_CAPABILITIES` lane block.
2. **the 410 pair advertises nothing** — `getCapabilitiesForModel('opencode','muse-spark-1.2-contributor-free')` and the `1.3` form do **not** report `contextWindow: 1048576` and do not report `vision: true` (guards DD-04-5: proves the pattern narrowing, not just the row deletion).
3. **the 8 upstream ids resolve per DD-04-3** — `nemotron-3.5-super-vl-free` resolves with `vision: true`; the six no-row ids resolve without a hand row and are asserted as floor/pattern-resolved, not asserted as absent-and-untested.
4. **non-free rows untouched** — a representative non-free row still resolves with its declared values (`getCapabilitiesForModel('kiro','gpt-5.6-sol')` → the 272k Kiro limits; `getCapabilitiesForModel(undefined,'deepseek-v4.1-flash')` → 1M/384k), proving the prune did not reach outside the free set.
5. **lane-keyed, no cross-lane leak** — `glm-5.3-flash-free` returns `maxOutput: 131072` for `opencode` and `128000` for `opencode-zen` (DD-04-6); an id served on one lane is not reachable through an unrelated provider key.
6. **SSOT agreement** — for every entry returned by `listFreeModels(lane)` whose state is not `ALIVE`, no capability row exists for that id; for every `ALIVE` free id, either a row exists or the pattern/catalog layer resolves it (the DD-04-3 predicate, asserted id-by-id rather than assumed).

**Regression Guard Assertion:** assert the service-registration seam is intact — `setCatalogSource()` still overlays modalities/limits on a `MODEL_CAPABILITIES` hit, and no `node:fs` import is reachable from `capabilities.js` (DD-04-1/DD-04-2).
**Anti-Test-Tampering:** never weaken, delete, or skip a failing assertion. The `tests/unit/capabilities.test.js` amendment (DD-04-7) **retargets** an assertion to the post-migration contract; it must not remove the check, and any red test is fixed in the table, never in the assertion.
**Definition of Done:** **0 NEW failures against the 96-failure baseline (E9)** — not "all green".

---

## 📦 5. Micro-Chunk Dispatch Units

All three chunks touch `open-sse/providers/capabilities.js`, so they **share a file boundary and MUST run sequentially** (never parallel). ONE chunk per sub-agent dispatch turn; each chunk commits atomically on PASS.

### 📦 Chunk 1: Prune the 9 stale free rows (domain: open-sse/providers)
- **Target File(s):** `tests/unit/free-model-capabilities.test.js` [NEW] & `open-sse/providers/capabilities.js` [AMEND]
- **Scope Boundary:** 1 test file + the free-row region of 1 module. No other key touched.
- **Exact Task:** (1) write assertions 1, 2, 4, 5 RED; (2) delete exactly the 9 named keys from `MODEL_CAPABILITIES`; (3) narrow the `*muse*spark*` pattern so the two 410 forms fall through to the floor.
- **Deterministic Verification:** `cd tests && npx vitest run unit/free-model-capabilities.test.js`
- **Expected Output:** PASS (RED confirmed first: assertion 1 fails with the 9 rows present).
- **DoD:** 0 NEW failures vs baseline; non-free rows byte-identical.

### 📦 Chunk 2: Retrofit the existing capability test (domain: tests/unit)
- **Target File(s):** `tests/unit/capabilities.test.js` [AMEND] & `open-sse/providers/capabilities.js` [AMEND — comment/annotation only if chunk 1 left the divergence undocumented]
- **Scope Boundary:** the assertions that reference pruned ids only (the "OpenCode Free ids newer than the capability tables" block, and the `space-bunny` / `exo-free` / `ring-2.6-1t-free` expectations). No new assertions beyond the retarget.
- **Exact Task:** (1) run the file and record which cases fail after chunk 1; (2) retarget each to the post-migration contract (floor/pattern-resolved values for a pruned id; unchanged values for a retained non-free id); (3) re-run to green.
- **Deterministic Verification:** `cd tests && npx vitest run unit/capabilities.test.js`
- **Expected Output:** PASS — no assertion deleted, none weakened (DD-04-7).
- **DoD:** 0 NEW failures vs baseline.

### 📦 Chunk 3: Resolve the missing upstream free ids + guards (domain: open-sse/providers)
- **Target File(s):** `open-sse/providers/capabilities.js` [AMEND] & `tests/unit/free-model-capabilities.test.js` [AMEND]
- **Scope Boundary:** the free-row region plus assertions 3 and 6. No other row, pattern, or block.
- **Exact Task:** (1) line-audit the file's free-row region and reconcile the `big-pickle` discrepancy (§Open Questions 1); (2) apply the §2 triage table — add only the rows the audit proves are required, each with its `(lane, state)` comment; (3) add the SSOT-agreement assertions 3 and 6, then run the whole focused set.
- **Deterministic Verification:** `cd tests && npx vitest run unit/free-model-capabilities.test.js unit/capabilities.test.js unit/model-catalog-scope.test.js unit/combo-caps-resolver.test.js unit/opencode-free-thinking-format.test.js && node tests/__baseline__/verify-no-regression.mjs`
- **Expected Output:** PASS; 0 NEW failures.
- **DoD:** all DoD items below checked.

---

## ✅ 6. Definition of Done (DoD) Checklist

- [ ] The 9 stale ids have no capability row in `MODEL_CAPABILITIES` or in any `PROVIDER_CAPABILITIES` block.
- [ ] `muse-spark-1.2-contributor-free` and `muse-spark-1.3-contributor-free` no longer resolve to `contextWindow: 1048576` or `vision: true` (pattern narrowing proven, not just row deletion).
- [ ] Every upstream free id from the packet is either pattern/catalog-resolved with a passing assertion or carries an audited exact row with a `(lane, state)` comment; `nemotron-3.5-super-vl-free` resolves as vision-capable.
- [ ] Non-free rows are byte-identical: representative Claude/GPT/DeepSeek rows and the `opencode-go` / `commandcode` blocks still resolve unchanged.
- [ ] Lane divergence is asserted both ways (`opencode` vs `opencode-zen` on `glm-5.3-flash-free`) and no row leaks across lanes.
- [ ] `capabilities.js` gains no runtime dependency on `freeModelCatalog.js` and no `node:fs`; `setCatalogSource()` overlay still works.
- [ ] `tests/unit/capabilities.test.js` amended by retargeting only — no assertion deleted, weakened, or skipped.
- [ ] `capabilities.js` net line count decreases; ≤50 lines/function, ≤3 nesting levels.
- [ ] `cd tests && npx vitest run unit/free-model-capabilities.test.js unit/capabilities.test.js` → 100% PASS; `verify-no-regression.mjs` → **0 NEW failures** vs the 96-failure baseline (E9).
- [ ] Single conventional commit `feat(capabilities): align free-model capability rows with the free-model SSOT [phase-04]`.

**Blockers:** Phase 01 (`open-sse/providers/freeModelCatalog.js`) is required — the prune and the pattern narrowing are justified by `getState`/`listFreeModels` and the guard assertions call them directly. Phase 02 is **NOT** required. Phase 03 is not required but softens DD-04-5's trade-off (after Phase 03, no consumer offers a non-`ALIVE` id).

**Open Questions:**
1. **`big-pickle` row existence.** The evidence packet lists `big-pickle` among the 8 upstream free ids with no capability row, but the table contains a `big-pickle` row in the same region (asserted today by `tests/unit/capabilities.test.js`). Chunk 3 step 1 reconciles this against disk; the add-set is then 7 or 8, never assumed.
2. **`ring-2.6-1t-free`.** A free-suffixed row that appears in neither the 9-stale set nor the 8-missing set, and whose upstream lane membership is not in the evidence packet. Left untouched by this phase; Phase 07's five-way agreement test is the place that decides it.
3. **`muse-spark-1.3-contributor` (non-free, go lane).** DD-04-5 narrows the broad pattern to this ALIVE form; the exact pattern/row shape that keeps it resolving is confirmed in chunk 1's line audit, since the packet does not name a row for it.
