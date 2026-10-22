# Phase 06 — Combo Repair Migration

**Parent PRD:** [index.md](./index.md)
**Status:** 🟡 READY
**Completed Date:** _(blank — filled at execution)_
**Target Codebase:**
- `src/lib/db/repair/opencodeComboRepair.js` (NEW — repair module: planner + orchestrator)
- `tests/unit/combo-repair.test.js` (NEW — unit test)

**Verification:** `cd tests && npx vitest run unit/combo-repair.test.js` → 100% PASS; then `node tests/__baseline__/verify-no-regression.mjs` → 0 NEW failures against the E9 baseline (`326 passed / 44 failed 386 files; 3674 passed / 96 failed 3883 tests`).

---

## 🎯 1. Objective & Explicit Non-Goals

### Objective
Repair the 5 live `combos` rows whose LEAD model id answers upstream HTTP 410 `ModelDeprecated` (E4.5: `1st_combo`, `muse`, `muse-spark-1.3-contributor`, `mimo-v2.6-flash`, `gemini-3.1-pro-max`). Repair **REPOINTS** each dead lead to a live `(lane, modelId)` pair supplied by the Phase 01 SSOT (`resolveLiveSubstitute`) — the combo row SURVIVES with its `id`/`name`/`kind` intact. Drive master-index KPI "Combo health" from 5 to 0, proven by `POST /v1/chat/completions` returning HTTP 200.

### Scope Guard (STRICT — Phase 06 MUST NOT touch)
1. `open-sse/providers/freeModelCatalog.js` (Phase 01 owns its schema; Phase 06 **consumes** `FREE_MODEL_STATE`, `LANES`, `getState`, `resolveLiveSubstitute` — never edits them).
2. `src/app/api/providers/suggested-models/filters.js` (Phase 03), `open-sse/providers/capabilities.js` (Phase 04), both provider registries `open-sse/providers/registry/opencode.js` + `opencode-zen.js` (Phase 05).
3. `open-sse/config/errorConfig.js` + the executors (Phase 02), `open-sse/utils/proxyFetch.js` (Phase 07).
4. **No DDL.** No new table, no new column, no migration file appended to `src/lib/db/migrations/index.js` (L6) and no entry in `MIGRATIONS`.

### Verified Ground Truth (this session)
- **No combo repair / sanitize / heal path exists anywhere on disk.** `Grep` for `repairCombo|sanitizeCombo|pruneCombo|healCombo|deadModel|invalidModel` → **No matches found**; a broader `repair|sanitize|validateCombo|pruneStale|ModelDeprecated|410` sweep (64 files) returned no code that drops or rewrites a combo whose member id is dead. **Phase 06 therefore authors a NEW repair module** — it does not amend a pre-existing repair function, because none exists. (Master index §8 Open Question 1 explicitly left the repair-path file unnamed; this phase resolves it.)
- Existing combo code is pure CRUD + pure read, with **no liveness validation**:
  - `src/lib/db/repos/combosRepo.js` — `getCombos` L17, `getComboById` L23, `getComboByName` L29, `createCombo` L35, `updateCombo` L53-67, `deleteCombo` L69. `updateCombo` already issues `UPDATE combos SET name = ?, kind = ?, models = ?, updatedAt = ? WHERE id = ?` (L61-63) over the JSON-array `models` column — **this is the reuse target; no amend needed**.
  - `open-sse/services/combo.js` L254-266 `getComboModelsFromData` returns `combo.models` unvalidated; no repair on read.
  - `src/app/api/combos/route.js` exposes only GET/POST; `src/app/api/combos/[id]/route.js` and `src/app/api/combos/presets/route.js` add no repair endpoint.
  - `src/lib/db/schema.js` L93-103 — `combos(id TEXT PK, name TEXT UNIQUE NOT NULL, kind TEXT, models TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`. Single migration `001-initial.js` (`migrations/index.js` L4-6) — schema bootstrap only, no data migration.
- Existing combo tests verified on disk: `combo-routing`, `combo-autoswitch`, `combo-fusion`, `combo-capabilities`, `combo-presets`, `combo-caps-resolver` (all under `tests/unit/`). Phase 06 adds its own test file and must not weaken these.

### Recorded Design Decisions (DD-06-n — explicit; master index deliberately left WHERE open)
- **DD-06-1 — WHERE repair runs: a one-shot operator-invoked script.** The module exports a callable orchestrator run explicitly (`node -e "import('./src/lib/db/repair/opencodeComboRepair.js').then(m=>m.repairOpenCodeCombos())"` or a thin `scripts/` caller). *Rejected alternatives:* (a) **startup hook** — self-healing, but it couples gateway boot to the SSOT fs cache and would mutate the user-facing DB at every process start; the blast radius of a bad catalog at boot is every combo, so it is rejected as the default. (b) **admin HTTP endpoint** — useful later, but Phase 06's scope guard forbids touching `src/app/api/combos/*`; the module is written callable so a future phase may wire one. (c) **lazy-at-read** — rejected outright: it silently mutates the DB inside the chat request path, which is neither auditable nor safe. The one-shot needs an operator to run it, but it is explicit, inspectable, and dry-run-able.
- **DD-06-2 — Idempotency mechanism: computed-array equality gate.** `planComboRepair(combo, catalog)` returns `{ changed: boolean, models: string[], report }`; the orchestrator issues `updateCombo` **only** when `changed === true`. A second run over an already-healthy DB computes identical arrays → `changed === false` for every row → zero UPDATE statements. Observable invariant (test 3): a spy on the adapter's `run` records zero `UPDATE combos` calls on the second pass, and `updatedAt` is unchanged.
- **DD-06-3 — No-substitute behaviour: leave the combo untouched, report it.** When a dead lead has no live substitute (`resolveLiveSubstitute` → `null`) — e.g. the catalog is loaded but the id is genuinely gone — the combo is left byte-for-byte unchanged and recorded in the report as `unresolved`. *Rejected:* dropping the member (could empty a single-member combo — worse than a broken lead) and quarantine (needs a new status column → **DDL, forbidden**). Leave-untouched is the only non-destructive, no-DDL default; the operator sees the unresolved list and decides.
- **DD-06-4 — SSOT non-EMPTY gate (DATA-LOSS GUARD, HARD REQUIREMENT).** The orchestrator reads the catalog first; if `listFreeModels(lane)` is EMPTY for all lanes **or** the catalog is missing/unparseable, repair **ABORTS before any write** — zero rows touched, loud report line. A missing or corrupt catalog can therefore **never** wipe or rewrite live combos. Test 6 asserts this edge explicitly.

### Design Decisions NOT in scope
The 5 combos share the same underlying defect (dead lead) but may differ in whether a substitute exists; DD-06-3 covers the general case. Whether a combo's non-lead members should also be checked is out of scope — E4.5 measured the LEAD only; Phase 06 repairs the lead.

---

## 🏛️ 2. Architectural Specification

### Module path & exports (`src/lib/db/repair/opencodeComboRepair.js`)
```js
export function planComboRepair(combo, catalog)   // -> { changed: boolean, models: string[], report: RepairLine }
export async function repairOpenCodeCombos(deps)  // -> { repaired: number, unresolved: number, aborted: boolean, lines: RepairLine[] }
```

### Dependencies (injected, so tests never touch the live DB)
`repairOpenCodeCombos({ catalog, getCombos, updateCombo, log })` accepts all four by injection; production callers pass the real ones from `@/lib/db/index.js` (`getCombos`, `updateCombo`) and `open-sse/providers/freeModelCatalog.js`; tests pass a fixture catalog and an in-memory/temp DB adapter. **No module-level `import` of the live adapter** — that is what keeps the test suite off the live DB.

```js
const FALLBACK_LANES = ["inference", "zen", "go"];   // LANES from SSOT
RepairLine = {
  comboId: string,
  comboName: string,
  previousLead: string,
  nextLead: string | null,
  substituted: boolean,     // true when nextLead came from resolveLiveSubstitute
  unresolved: boolean,      // DD-06-3
  lane: string | null,
}
```

### Repair decision flow (text diagram)
```
repairOpenCodeCombos(deps)
   │
   ├─ catalog.listFreeModels(lane) for every lane
   │     └─ all EMPTY / catalog missing / unparseable ──► ABORT (DD-06-4): zero writes, aborted=true
   │
   └─ for each combo from getCombos():
         │
         ├─ planComboRepair(combo, catalog)
         │     ├─ lead = combo.models[0]
         │     ├─ state = catalog.getState(lane, lead)
         │     ├─ state === ALIVE / not-DEPRECATED ──► { changed: false } (DD-06-2: no write)
         │     └─ state is DEPRECATED / DEAD_UPSTREAM
         │           ├─ sub = catalog.resolveLiveSubstitute(lane, lead)
         │           ├─ sub != null ──► models[0] = `${sub.lane}/${sub.modelId}`  → { changed: true }
         │           └─ sub == null  ──► { changed: false, unresolved: true }   (DD-06-3)
         │
         └─ if changed === true: updateCombo(combo.id, { models: planned.models })
              (reuses combosRepo.updateCombo L53-67 — UPDATE combos SET models=?, updatedAt=? WHERE id=?)
```

### Persistence contract (NO DDL — asserted)
- The ONLY write is `UPDATE combos SET name = ?, kind = ?, models = ?, updatedAt = ? WHERE id = ?` — the existing statement at `src/lib/db/repos/combosRepo.js` L61-63, reached through the reused `updateCombo` (L53). The `models` column is `TEXT NOT NULL` (`src/lib/db/schema.js` L98) holding a JSON array; the repair rewrites the array string.
- **No** `CREATE`, `ALTER`, `DROP`, `INSERT INTO combos`, or `DELETE FROM combos` anywhere in the module. No migration is appended to `src/lib/db/migrations/index.js` (`MIGRATIONS`, L6). Test 7 asserts the module emits only `UPDATE combos`.
- The combo row's `id`, `name`, `kind`, `createdAt` are preserved by construction (`updateCombo` merges `{...rowToCombo(row), ...data}` at L59).

### Repoint, not delete (E5 / index §7 S4)
`muse-spark-1.3-contributor-free` is 410 on the free `inference` lane, but go-lane `muse-spark-1.3-contributor` is ALIVE (E5). `resolveLiveSubstitute("inference","muse-spark-1.3-contributor-free")` returns the go-lane pair (Phase 01, its test 10). Phase 06 writes only `models[0]`. The combo still exists; `POST /v1/chat/completions` with `model=muse` must return HTTP 200.

---

## 🎨 3. Visual & Interface Design (terminal — no web UI)

**BEFORE — 5 combos lead with a 410 id; nothing repairs them:**
```
$ node -e "import('./src/lib/db/repair/opencodeComboRepair.js')"
Error: module does not exist.  no repair path on disk (grep: 0 matches);
the 5 combos keep dead leads -> /v1/chat/completions returns upstream 410.
```

**AFTER — operator runs one explicit, idempotent, abort-on-empty repair:**
```
$ node -e "import('./src/lib/db/repair/opencodeComboRepair.js').then(m=>m.repairOpenCodeCombos({log:console.log}))"
repaired=3 unresolved=2 aborted=false
  1st_combo                     lead inference/gemini-3.1-pro-max(free)  -> go/gemini-3.1-pro-max   [repointed]
  muse                          lead inference/muse-spark-1.3-contributor-free -> go/muse-spark-1.3-contributor  [repointed]
  mimo-v2.6-flash               lead inference/mimo-v2.6-flash-free      -> inference/mimo-v2.6-flash  [repointed]
  muse-spark-1.3-contributor    lead ... no live substitute                      [unresolved, untouched]
  gemini-3.1-pro-max            lead ... already ALIVE on go lane               [unchanged]

$ node -e "...repairOpenCodeCombos()  # second run"
repaired=0 unresolved=2 aborted=false      # DD-06-2: zero UPDATE statements issued
```

---

## 🧪 4. Test Strategy & TDD Red-Green-Refactor (HARD RULE)

**Step 1 — RED.** Author `tests/unit/combo-repair.test.js` first with the assertions below; run and confirm it fails for the expected reason (module absent), not setup noise.
**Step 2 — GREEN.** Write the minimal module that satisfies every assertion.
**Step 3 — REFACTOR.** Keep tests green while enforcing ≤50 lines/function, ≤3 nesting levels, 300 LOC warn / 500 LOC block.

**Test harness (mandatory):** every test constructs a **fixture catalog** and a **temp/in-memory DB** (adapter from `src/lib/db/driver.js` or the sql.js fallback) seeded with the 5 named combos. **No test may read or write the live `~/.9router` DB.** Assert on the injected `updateCombo` spy, never on a real DB path.

### Named test cases
1. **repoint lead** — combo `muse` (lead `muse` dead) → planned `models[0]` is the go-lane `muse-spark-1.3-contributor`; `id`/`name`/`kind` unchanged.
2. **repoint, not delete** — after repair, `getCombos()` returns the same number of combos and `muse` is still present.
3. **idempotent (observable invariant)** — a second `repairOpenCodeCombos()` over the repaired DB issues **zero** `UPDATE combos` calls (spy `run`), and every `updatedAt` is byte-identical to the first run's result.
4. **healthy combo untouched** — a combo whose lead state is ALIVE → `planComboRepair().changed === false`, no write.
5. **no-substitute (DD-06-3)** — a combo whose dead lead yields `resolveLiveSubstitute → null` → `unresolved: true`, `changed: false`, row untouched, and it appears in `lines` with `unresolved: true`.
6. **abort on EMPTY catalog (DD-06-4, data-loss guard)** — `catalog.listFreeModels` returns `[]` for all lanes (or catalog missing/unparseable) → `aborted: true`, **zero** `updateCombo` calls, every combo byte-identical. Hard requirement: assert no write occurred.
7. **NO DDL** — collect every statement the adapter executes during repair; assert the set contains only `UPDATE combos ...` (no `CREATE`/`ALTER`/`DROP`/`INSERT INTO combos`/`DELETE FROM combos`), and that `MIGRATIONS` length is unchanged.
8. **all 5 named combos resolve** — the E4.5 set (`1st_combo`, `muse`, `muse-spark-1.3-contributor`, `mimo-v2.6-flash`, `gemini-3.1-pro-max`) is present in the fixture and each appears in `lines` exactly once.

**Regression Guard Assertion:** assert DD-06-4 — a second call after swapping the catalog to EMPTY leaves the DB untouched (guards against a future refactor that reads the catalog per-combo instead of gating once).
**Anti-Test-Tampering:** never weaken, delete, or skip a failing assertion; a red test means fix the module, never the assertion. The existing `tests/unit/combo-*.test.js` files must remain untouched and green.
**Definition of Done:** **0 NEW failures against the 96-failure baseline (E9)** — not "all green". Focused run: `cd tests && npx vitest run unit/combo-repair.test.js`; then `node tests/__baseline__/verify-no-regression.mjs`.

---

## 📦 5. Micro-Chunk Dispatch Units

Both chunks target the **same 2 files**, so they share a file boundary and MUST execute **sequentially** (never parallel). **ONE chunk per sub-agent dispatch turn.** The executor must NOT run the repair against the live DB during development — all runs are fixture/temp-DB only (test harness, §4).

### 📦 Chunk 1: planner + no-DDL write path (domain: src/lib/db/repair)
- **Target File(s):** `src/lib/db/repair/opencodeComboRepair.js` [NEW] & `tests/unit/combo-repair.test.js` [NEW]
- **Scope Boundary:** 1 module + 1 test only (tests 1, 2, 4, 7)
- **Exact Task:** (1) implement `planComboRepair(combo, catalog)` with the decision flow; (2) inject `getCombos`/`updateCombo`; (3) wire the REPOINT write through the reused `updateCombo`; (4) assert NO DDL.
- **Deterministic Verification:** `cd tests && npx vitest run unit/combo-repair.test.js -t "repoint"`
- **Expected Output:** PASS
- **DoD:** 0 NEW failures vs baseline; no `CREATE`/`ALTER`/`DROP` emitted.

### 📦 Chunk 2: orchestrator + idempotency + abort gate (domain: src/lib/db/repair)
- **Target File(s):** `src/lib/db/repair/opencodeComboRepair.js` [AMEND] & `tests/unit/combo-repair.test.js` [AMEND]
- **Scope Boundary:** 1 module + 1 test only (tests 3, 5, 6, 8 + regression guard)
- **Exact Task:** implement `repairOpenCodeCombos(deps)`: read catalog once, apply the **DD-06-4 non-EMPTY gate** (abort on empty/missing), per-combo `changed` gate (DD-06-2), and the DD-06-3 no-substitute report; assemble `lines`.
- **Deterministic Verification:** `cd tests && npx vitest run unit/combo-repair.test.js && node tests/__baseline__/verify-no-regression.mjs`
- **Expected Output:** PASS; 0 NEW failures.
- **DoD:** all DoD items below checked.

---

## ✅ 6. Definition of Done (DoD) Checklist

- [ ] `src/lib/db/repair/opencodeComboRepair.js` exists exporting `planComboRepair` and `repairOpenCodeCombos`.
- [ ] The 5 named combos (E4.5) each have a `RepairLine`; dead leads are REPOINTED via `resolveLiveSubstitute`, and every combo row SURVIVES (`id`/`name`/`kind`/`createdAt` unchanged).
- [ ] **NO DDL asserted:** the only write is `UPDATE combos SET ... models = ? ...` via the reused `combosRepo.updateCombo` (L53-67); no `CREATE`/`ALTER`/`DROP`/`INSERT INTO combos`/`DELETE FROM combos`; `MIGRATIONS` (`src/lib/db/migrations/index.js` L6) unchanged.
- [ ] **Idempotent:** a second run issues zero `UPDATE combos` calls and leaves `updatedAt` unchanged (DD-06-2, test 3).
- [ ] **No-substitute behaviour defined and asserted:** combo left untouched and reported `unresolved` (DD-06-3, test 5) — never dropped, never quarantined.
- [ ] **DD-06-4 data-loss guard asserted:** missing/EMPTY/unparseable catalog aborts with zero writes (test 6).
- [ ] Tests run against a fixture catalog + temp/in-memory DB; no live `~/.9router` DB read or write; the executor never runs the repair against the live DB during development.
- [ ] Phase 01 SSOT is consumed only (`getState`, `resolveLiveSubstitute`, `LANES`); `freeModelCatalog.js` is not edited.
- [ ] Existing `tests/unit/combo-*.test.js` untouched and green.
- [ ] `cd tests && npx vitest run unit/combo-repair.test.js` → 100% PASS.
- [ ] `verify-no-regression.mjs` → **0 NEW failures vs the 96-failure baseline (E9)**.
- [ ] ≤50 lines/function, ≤3 nesting levels, ≤300 LOC warn / 500 block; single conventional commit `fix(combo-repair): repoint 5 stale combo leads via SSOT live-substitute [phase-06]`.

---

**Blockers:** Phase 01 (`freeModelCatalog.js` — `resolveLiveSubstitute`/`getState`/`LANES`), Phase 03, Phase 04, Phase 05 (all feed SSOT liveness the repair trusts). Per index §5, P06 blockers are P03/P04/P05.

**Open Questions:**
1. **Whether to wire the module to an admin endpoint or startup hook later** — DD-06-1 picks the one-shot script now; any self-healing wiring is deferred to a future phase and is explicitly out of this phase's scope (`src/app/api/combos/*` untouched).
2. **Whether non-lead combo members should also be validated** — E4.5 measured the LEAD only; left open, out of scope.
3. **The exact 4-of-5 vs 5-of-5 repoint split** — E5 confirms at least `muse-spark-1.3-contributor-free` repoints to the go lane; the per-combo substitute for the other four is resolved at execution time from the SSOT, not asserted here (avoiding an invented mapping). The report surface (`lines`) makes any `unresolved` row visible rather than silent.
4. **`tests/unit/v1-models-combo-context.test.js` existence** — UNVERIFIED by this phase's glob. Phase 06 does not depend on it; confirm at execution before citing it in any DoD.
