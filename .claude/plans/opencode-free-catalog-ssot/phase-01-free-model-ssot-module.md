# Phase 01 — Free-Model SSOT Module (`freeModelCatalog.js`)

**Parent PRD:** [index.md](./index.md)
**Status:** 🟡 READY
**Completed Date:** _(blank — filled at execution)_
**Target Codebase:**
- `open-sse/providers/freeModelCatalog.js` (NEW — SSOT module)
- `tests/unit/free-model-catalog.test.js` (NEW — unit test)

**Verification:** `cd tests && npx vitest run unit/free-model-catalog.test.js` → 100% PASS; then `node tests/__baseline__/verify-no-regression.mjs` → 0 NEW failures against the E9 baseline (326 passed / 44 failed of 386 files; 3674 passed / 96 failed of 3883 tests).

---

## 🎯 1. Objective & Explicit Non-Goals

### Objective
Author the single source of truth (SSOT) for free-model liveness, keyed on the **(lane, modelId) pair** — because liveness is a property of the pair, not the id (E2). The module classifies every free `(lane, id)` into a six-state enum plus `UNKNOWN` (E3), carries `deadReason` and `lastVerified`, and exposes the read APIs every downstream consumer (Phases 03-06) will call.

### Scope Guard (STRICT — Phase 01 MUST NOT touch)
1. The five consumer sites — `src/app/api/providers/suggested-models/filters.js`, `open-sse/providers/capabilities.js`, `open-sse/providers/registry/opencode.js`, `open-sse/providers/registry/opencode-zen.js`, and the live `combos` table repair path (Phases 03-06).
2. The 429 quota classifier in `open-sse/utils/freeTierEgress.js` / `open-sse/config/errorConfig.js` / `open-sse/executors/opencode.js` (Phase 02). Phase 01 owns only the **pure** status→state function inside its own module; wiring is Phase 02.
3. The executors, the auto-generated `open-sse/providers/registry/index.js` (never hand-edit — E10), and `open-sse/utils/proxyFetch.js` (Phase 07).
4. No new DB tables, no DDL (E10). No `strictProxy` change (E7). No upstream merge (E1).

### Recorded Design Decisions (explicit — master index deliberately left these open; this phase resolves them and records the rationale)
- **DD-1 — Persistence:** the SSOT is a **pure in-memory, mtime-cached reader**, mirroring `catalogOverride.js` L32-50. It writes **no** disk snapshot. *Rationale:* index §8 Open Question 2; the hot path is one `stat` (~1µs) and re-parse only after a refresh; a snapshot would create a sixth drift site.
- **DD-2 — `UNKNOWN` is not a stored state:** it is the synthesized return for any `(lane, id)` with no entry. `listFreeModels(lane)` never emits it. *Rationale:* mirrors index §7 S1 (a lane where the id is absent yields `UNKNOWN`, not a fabricated classification).
- **DD-3 — Fail-open:** any read error returns `EMPTY` and never throws, matching the RTK fail-open convention.
- **DD-4 — `PROTOCOL_UNSUPPORTED` policy:** classification is **per-lane**. `jev-1.13-free` on lane `inference` is `PROTOCOL_UNSUPPORTED` (E3, `{kind:"systemone"}`), not ALIVE-on-another-lane. *Rationale:* resolves index §8 Open Question 4; kept local to the module so a later phase may add `lanes[]` without contract break.

---

## 🏛️ 2. Architectural Specification

### Module path & exports (`open-sse/providers/freeModelCatalog.js`)
```js
export const FREE_MODEL_STATE;     // Object.freeze({ ALIVE, QUOTA_BLOCKED, DEPRECATED,
                                   //   FINGERPRINT_BLOCKED, PROTOCOL_UNSUPPORTED, DEAD_UPSTREAM, UNKNOWN })
export const LANES;                // Object.freeze({ INFERENCE: "inference", ZEN: "zen", GO: "go" })
export function classifyUpstreamStatus(status, body)   // -> string (a FREE_MODEL_STATE value)
export function getState(lane, modelId)                // -> FreeModelEntry   (never null; UNKNOWN-shaped when absent)
export function listFreeModels(lane)                   // -> FreeModelEntry[] (ALIVE + non-ALIVE stored entries; no UNKNOWN)
export function resolveLiveSubstitute(lane, modelId)   // -> { lane, modelId } | null
export function invalidateFreeCatalog()                // -> void
export function describe()                             // -> string          (terminal table; index §3)
```

### Key shape
`entryKey = ${lane}:${modelId}` — the pair. `big-pickle` is free-lane only; `beam-free` exists independently on all three lanes (`inference`, `zen`, `go`) as **distinct entries** (E2). A query for a lane the id is absent from returns the `UNKNOWN` entry, never a cross-lane fall-through.

### Data contract
```js
FreeModelEntry = {
  lane: "inference" | "zen" | "go",
  modelId: string,
  state: FREE_MODEL_STATE,               // 6 states + UNKNOWN
  deadReason: string | null,             // populated for DEPRECATED / DEAD_UPSTREAM / QUOTA_BLOCKED /
                                         //   FINGERPRINT_BLOCKED / PROTOCOL_UNSUPPORTED
  lastVerified: string | null,           // ISO-8601 date, e.g. "2026-10-22"
  replacement: { lane: string, modelId: string } | null,  // set for DEPRECATED
}
```

### Classification decision flow (text diagram)
```
input (lane, modelId)
   │
   ├─ key `${lane}:${modelId}` present in loaded catalog?
   │     ├─ no ──────────────► synthesized entry { state: UNKNOWN, deadReason: null, lastVerified: null }
   │     └─ yes
   │           │
   │           ├─ stored state ALIVE ───────────────► ALIVE
   │           └─ stored state != ALIVE ────────────► stored state (+ deadReason, replacement)

upstream response body  ──► classifyUpstreamStatus(status, body)
   status 410  "ModelDeprecated"        ──► DEPRECATED          (+ replacement = resolveLiveSubstitute(lane, modelId))
   status 429  "FreeUsageLimitError"    ──► QUOTA_BLOCKED
   status 403  "only OpenCode"/fingerprint ──► FINGERPRINT_BLOCKED
   status 400  "ModelProtocolUnsupported"  ──► PROTOCOL_UNSUPPORTED
   status 404  "UNKNOWN"                ──► DEAD_UPSTREAM
   otherwise                             ──► UNKNOWN
```
`QUOTA_BLOCKED` is per-IP and transient (E3) — the classifier records it as a state but no cooldown constant is baked in here (index §8 Open Question 3 stays open; `getQuotaCooldown` is Phase 02's concern).

### Cache contract (mirrors `catalogOverride.js` L32-50)
- Module-level `cache` + `cachedMtime`; `load()` does `fs.statSync(CATALOG_FILE).mtimeMs`; re-parse iff `mtime !== cachedMtime`.
- `statSync` failure → `cache = EMPTY`, `cachedMtime = -1`, return `EMPTY` (no throw).
- `JSON.parse` failure → `cache = EMPTY`.
- `invalidateFreeCatalog()` sets `cachedMtime = -1`.
- **No** `fs.write*` anywhere in the module (DD-1).

### Lane seed table
The `LANES`-keyed seed entries are populated from the E2/E3 evidence already in the master index (e.g. `inference:big-pickle` ALIVE; `inference:beam-free` FINGERPRINT_BLOCKED; `inference:minimax-m3.1-flash-free` DEPRECATED → `deepseek-v4.1-flash-free`; `inference:jev-1.13-free` PROTOCOL_UNSUPPORTED; `go:muse-spark-1.3-contributor` ALIVE; `zen:muse-spark-1.3-contributor-free` DEPRECATED). Upstream lane snapshots (from the three `modelsFetcher` wirings — registry/opencode.js L54, opencode-zen.js L131, opencode-go.js L90) overlay the seed at read time.

---

## 🎨 3. Visual & Interface Design (terminal — no web UI)

**BEFORE — today's scattered knowledge:** two hardcoded constants in `src/app/api/providers/suggested-models/filters.js` L4 (`KNOWN_FREE_OPENCODE_MODELS`) and L7 (`DEAD_FREE_OPENCODE_MODELS`), plus 12 hand-maintained free rows in `open-sse/providers/capabilities.js` — five sites, no shared truth.
```
$ node -e "import('./open-sse/providers/freeModelCatalog.js')"
Error: module does not exist.  free liveness lives in 5 places; drift is unavoidable.
```

**AFTER — one query returns state per `(lane, id)`:**
```
$ node -e "import('./open-sse/providers/freeModelCatalog.js').then(m=>console.log(m.describe()))"
lane=inference  big-pickle                     ALIVE
lane=inference  beam-free                      FINGERPRINT_BLOCKED  (403 fingerprint)
lane=inference  jev-1.13-free                  PROTOCOL_UNSUPPORTED (wrong lane: systemone)
lane=inference  minimax-m3.1-flash-free        DEPRECATED  -> use deepseek-v4.1-flash-free
lane=zen        muse-spark-1.3-contributor-free DEPRECATED
lane=go         muse-spark-1.3-contributor      ALIVE  (substitute for the 410 free form)

$ node -e "import('./open-sse/providers/freeModelCatalog.js').then(m=>console.log(m.getState('zen','big-pickle')))"
{ lane:'zen', modelId:'big-pickle', state:'UNKNOWN', deadReason:null, lastVerified:null, replacement:null }
```

---

## 🧪 4. Test Strategy & TDD Red-Green-Refactor (HARD RULE)

**Step 1 — RED.** Author `tests/unit/free-model-catalog.test.js` first with the assertions below; run and confirm it fails for the expected reason (module absent), not setup noise.
**Step 2 — GREEN.** Write the minimal module that satisfies every assertion.
**Step 3 — REFACTOR.** Keep tests green while enforcing ≤50 lines/function, ≤3 nesting levels, 300 LOC warn / 500 LOC block.

### Named test cases
1. **pair keying** — `getState("inference","beam-free")` and `getState("go","beam-free")` return two independent entries with distinct `lane` values.
2. **lane absence** — `getState("zen","big-pickle")` returns `state === FREE_MODEL_STATE.UNKNOWN`, not `ALIVE`.
3. **410 → DEPRECATED** — `classifyUpstreamStatus(410, <ModelDeprecated body>)` yields `DEPRECATED`, and the entry's `replacement` is recorded.
4. **429 → QUOTA_BLOCKED** — `classifyUpstreamStatus(429, <FreeUsageLimitError body>)` yields `QUOTA_BLOCKED`.
5. **403 fingerprint → FINGERPRINT_BLOCKED** — 403 "only OpenCode" body yields `FINGERPRINT_BLOCKED`.
6. **400 protocol → PROTOCOL_UNSUPPORTED** — `ModelProtocolUnsupported` body yields `PROTOCOL_UNSUPPORTED`.
7. **404 → DEAD_UPSTREAM** — body yields `DEAD_UPSTREAM`.
8. **mtime cache** — parsed snapshot returned; a second read with unchanged `mtime` does not re-parse; a changed `mtime` re-parses (assert via a parse-count spy / fresh fixture).
9. **empty fallback** — missing `CATALOG_FILE` returns `EMPTY` and does not throw.
10. **live substitute** — `resolveLiveSubstitute("inference","muse-spark-1.3-contributor-free")` returns the go-lane `muse-spark-1.3-contributor` pair (the Phase 06 REPOINT input — index §7 S4, E5).
11. **describe() shape** — output contains one `lane=<lane>  <id>  <STATE>` line per stored entry.

**Regression Guard Assertion:** assert `invalidateFreeCatalog()` forces exactly one re-parse, guarding DD-1/DD-2 (no snapshot, `UNKNOWN` never emitted by `listFreeModels`).
**Anti-Test-Tampering:** never weaken, delete, or skip a failing assertion; a red test means fix the module, never the assertion.
**Definition of Done:** **0 NEW failures against the 96-failure baseline (E9)** — not "all green". Focused run: `cd tests && npx vitest run unit/free-model-catalog.test.js`; then `node tests/__baseline__/verify-no-regression.mjs`.

---

## 📦 5. Micro-Chunk Dispatch Units

All three chunks target the **same 2 files**, so they share a file boundary and MUST execute **sequentially** (never parallel). ONE chunk per sub-agent dispatch turn.

### 📦 Chunk 1: Enum + state reader (domain: open-sse/providers)
- **Target File(s):** `open-sse/providers/freeModelCatalog.js` [NEW] & `tests/unit/free-model-catalog.test.js` [NEW]
- **Scope Boundary:** 1 module + 1 test only (tests 1-3, 5-7, 11)
- **Exact Task:** (1) declare `FREE_MODEL_STATE` + `LANES`; (2) implement `classifyUpstreamStatus(status, body)`; (3) implement `getState(lane, modelId)` over the lane seed table with the `UNKNOWN` fallback.
- **Deterministic Verification:** `cd tests && npx vitest run unit/free-model-catalog.test.js -t "pair keying"`
- **Expected Output:** PASS
- **DoD:** 0 NEW failures vs baseline.

### 📦 Chunk 2: mtime cache + fail-open (domain: open-sse/providers)
- **Target File(s):** `open-sse/providers/freeModelCatalog.js` [AMEND] & `tests/unit/free-model-catalog.test.js` [AMEND]
- **Scope Boundary:** 1 module + 1 test only (tests 4, 8, 9 + regression guard)
- **Exact Task:** add the `load()` mtime cache mirroring `catalogOverride.js` L32-50, `invalidateFreeCatalog()`, empty fallback (DD-1/DD-3), and the 429 → `QUOTA_BLOCKED` classification.
- **Deterministic Verification:** `cd tests && npx vitest run unit/free-model-catalog.test.js -t "mtime cache"`
- **Expected Output:** PASS
- **DoD:** 0 NEW failures vs baseline; no `fs.write*` in the module.

### 📦 Chunk 3: live-substitute + describe (domain: open-sse/providers)
- **Target File(s):** `open-sse/providers/freeModelCatalog.js` [AMEND] & `tests/unit/free-model-catalog.test.js` [AMEND]
- **Scope Boundary:** 1 module + 1 test only (test 10 + `describe()` assertion)
- **Exact Task:** implement `listFreeModels(lane)`, `resolveLiveSubstitute(lane, modelId)`, `describe()`.
- **Deterministic Verification:** `cd tests && npx vitest run unit/free-model-catalog.test.js && node tests/__baseline__/verify-no-regression.mjs`
- **Expected Output:** PASS; 0 NEW failures.
- **DoD:** all DoD items below checked.

---

## ✅ 6. Definition of Done (DoD) Checklist

- [ ] `open-sse/providers/freeModelCatalog.js` exists with all 7 exports; `describe()` renders the index §3 table.
- [ ] Six states + `UNKNOWN` covered by assertions; `deadReason` populated for DEPRECATED / DEAD_UPSTREAM.
- [ ] `(lane, modelId)` pair keying proven (beam-free independent on `inference` and `go`; `big-pickle` absent on `zen`).
- [ ] mtime cache re-parses only on `mtime` change; missing/unparseable file returns `EMPTY` without throwing.
- [ ] `resolveLiveSubstitute` yields go-lane `muse-spark-1.3-contributor` for the dead free-lane `-free` form.
- [ ] No disk write, no DDL, no touch of the five consumer sites, classifier, executors, or `proxyFetch.js`.
- [ ] `cd tests && npx vitest run unit/free-model-catalog.test.js` → 100% PASS.
- [ ] `verify-no-regression.mjs` → **0 NEW failures** vs the 96-failure baseline (E9).
- [ ] ≤50 lines/function, ≤3 nesting levels, ≤300 LOC warn / 500 block; single conventional commit `feat(free-model-catalog): add (lane,modelId) free-model SSOT module [phase-01]`.
