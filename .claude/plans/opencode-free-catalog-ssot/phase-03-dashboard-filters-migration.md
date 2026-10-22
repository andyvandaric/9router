# Phase 03 — Dashboard Filters Migration (`suggested-models/filters.js`)

**Parent PRD:** [index.md](./index.md)
**Status:** 🟡 READY
**Completed Date:** _(blank — filled at execution)_
**Target Codebase:**
- `src/app/api/providers/suggested-models/filters.js` (AMEND — delete the two hardcoded constants; classify `"opencode-free"` against the Phase 01 SSOT)
- `tests/unit/minimax-code-usage.test.js` (AMEND — the sole existing suggested-models `FILTERS` test; add the `"opencode-free"` describe block. NONE NEW.)

**Verification:** `cd tests && npx vitest run unit/minimax-code-usage.test.js` → 100% PASS; then `node tests/__baseline__/verify-no-regression.mjs` → **0 NEW failures** against the E9 baseline (326 passed / 44 failed of 386 files; 3674 passed / 96 failed of 3883 tests).

---

## 🎯 1. Objective & Explicit Non-Goals

### Objective
Retire the two hand-maintained free-opencode constants in `src/app/api/providers/suggested-models/filters.js` (L4 `KNOWN_FREE_OPENCODE_MODELS`, L7 `DEAD_FREE_OPENCODE_MODELS`) and make the `"opencode-free"` filter (L21-24) answer from the Phase 01 SSOT (`open-sse/providers/freeModelCatalog.js`) — offering **ALIVE ids only**. This closes the master-index KPI **"Missing exposure"** (currently 3, target 0, index.md L149) and stops the dashboard advertising the phantom id.

Measured defect (E4.1, master index L149, L169-170): the dashboard currently offers the **phantom** id `oc/minimax-m3.1-flash-free` (upstream answers HTTP 410) and **hides three published free ids** — `beam-free`, `nemotron-3.5-super-vl-free`, `nemotron-3.5-lightning-free`.

### Scope Guard (STRICT — Phase 03 MUST NOT touch)
1. `open-sse/providers/freeModelCatalog.js` — Phase 01 owns the schema; Phase 03 **consumes, never edits**.
2. `open-sse/providers/capabilities.js` — Phase 04.
3. `open-sse/providers/registry/opencode.js` and `open-sse/providers/registry/opencode-zen.js` — Phase 05.
4. The combo repair path — Phase 06. `open-sse/config/errorConfig.js` and the executors — Phase 02. `open-sse/utils/proxyFetch.js` — Phase 07.
5. No new DB tables, no DDL. No `strictProxy` change. No hand-edit of the auto-generated `open-sse/providers/registry/index.js`.

### Recorded Design Decisions (explicit — master index deliberately left these open; this phase resolves them and records the rationale)
- **DD-03-1 — Coupling is RUNTIME (unlike Phase 04).** `filters.js` is **server-only** and may therefore carry a runtime `import` of the SSOT. *Evidence used to decide:* the only importer of `filters.js` is `src/app/api/providers/suggested-models/route.js` L2 (`import { FILTERS } from "./filters.js";`) — a Next.js **route handler** marked `export const dynamic = "force-dynamic"` (route.js L4), which executes on the server. No client module imports `filters.js`; the one browser consumer of this endpoint, `src/shared/utils/providerModelsFetcher.js` L21, reaches it over **HTTP** (`fetch("/api/providers/suggested-models?...")`), not via import. Contrast Phase 04's DD-04-1: `capabilities.js` *is* bundled into the browser (its own header comment and the `globalThis` catalog-source seam), so a runtime SSOT import there would drag `node:fs` into the client bundle. Here it cannot — the SSOT's `fs.statSync` cache stays behind the server boundary. *Trade-off:* if a future refactor ever imports `filters.js` from a client component, this decision inverts; the §4 guard assertion pins the server-only assumption.
- **DD-03-2 — Delete the two constants outright; no deprecated shim.** `KNOWN_FREE_OPENCODE_MODELS` (L4) and `DEAD_FREE_OPENCODE_MODELS` (L7) are module-private (`const`, no `export` keyword) — no external importer can exist, so a re-export shim would be unreachable dead code and a second drift site. Removing them removes the drift. *Rationale:* the whole phase exists to collapse two ad-hoc lists into one SSOT; keeping a shadow list defeats it.
- **DD-03-3 — SSRF allowlist source is an EXPLICIT OPEN QUESTION (no accessor invented).** Index.md L135 and L202 assign an E8 SSRF note to this phase's **route scope**, and `route.js` L21 currently calls bare `fetch(url)` on an unvalidated, query-string-supplied `url` — an unguarded SSRF sink. The repo already ships a three-layer guard at `src/shared/utils/ssrfGuard.js` (`assertPublicUrl` L162, `assertPublicUrlResolved` L172, `fetchPublic` L202 — rejects loopback / link-local `169.254.0.0/16` / RFC1918 `10/8`, `172.16/12`, `192.168/16`). The index names the allowlist source only as *"the provider registry's known catalog URLs"* — the exact accessor is **not** verified on disk, so this spec carries it as an open question (§7) with a named verification step rather than asserting an accessor that may not exist.

---

## 🏛️ 2. Architectural Specification

### The consumer seam (`filters.js`)
Change is localized to the `"opencode-free"` entry (L21-24). Today:
```js
// L4
const KNOWN_FREE_OPENCODE_MODELS = ["big-pickle"];
// L7
const DEAD_FREE_OPENCODE_MODELS = new Set(["deepseek-v4-flash-free"]);
// L21-24
"opencode-free": (models) =>
  models
    .filter((m) => (m.id?.endsWith("-free") || KNOWN_FREE_OPENCODE_MODELS.includes(m.id)) && !DEAD_FREE_OPENCODE_MODELS.has(m.id))
    .map((m) => ({ id: m.id, name: m.id })),
```
After: the filter intersects the upstream-supplied `models` list with the SSOT's ALIVE set for the relevant lane, using the Phase 01 read API — `listFreeModels(lane)` returns stored entries (never `UNKNOWN`, phase-01 DD-2), each carrying `state`; the filter keeps rows whose `modelId` is present in the upstream list **and** whose SSOT `state === FREE_MODEL_STATE.ALIVE`. `"opencode-free"` maps to the **inference** lane (`LANES.INFERENCE`). No id-suffix heuristic (`endsWith("-free")`) and no `big-pickle` special-case remain — the SSOT is the sole truth.

### Contract consumed (Phase 01, read-only)
Per phase-01 §2 — `listFreeModels(lane) -> FreeModelEntry[]` with `FreeModelEntry = { lane, modelId, state, deadReason, lastVerified, replacement }`; `FREE_MODEL_STATE.ALIVE`; `LANES.INFERENCE = "inference"`. Phase 03 calls these and must not mutate or re-derive them.

### Expected filter outcome (E4.1 defects closed)
| id | today | after |
|---|---|---|
| `minimax-m3.1-flash-free` | **offered** (phantom, upstream 410) | **dropped** (SSOT `DEPRECATED`, phase-01 §2 flow) |
| `beam-free` | hidden | **offered** (SSOT `ALIVE`) |
| `nemotron-3.5-super-vl-free` | hidden | **offered** (SSOT `ALIVE`) |
| `nemotron-3.5-lightning-free` | hidden | **offered** (SSOT `ALIVE`) |
| `big-pickle` | offered via hardcoded list | offered **iff** SSOT says `ALIVE` on inference |
| `deepseek-v4-flash-free` | suppressed via `DEAD_FREE_OPENCODE_MODELS` | suppressed **iff** SSOT says non-ALIVE |

### Route-scope SSRF note (DD-03-3 — recorded, not implemented unless §7 resolves)
`route.js` L21 `const res = await fetch(url);` takes `url` straight from `searchParams` (route.js L8) with no validation, and `route.js` unconditionally allows any host. `src/shared/utils/ssrfGuard.js` is the verified existing mitigation; wiring it (or a registry-derived host allowlist) is scoped to this phase's route but gated on §7 Open Question 1.

---

## 🎨 3. Visual & Interface Design (dashboard UI — no new component)

**BEFORE — the dashboard model picker for a free OpenCode provider lies in both directions:**
```
[ OpenCode (Free) — suggested models ]
  ▸ opencode/minimax-m3.1-flash-free     <- offered, but every request 410s
  ▸ opencode/deepseek-v4-flash-free      <- hidden by DEAD_FREE_OPENCODE_MODELS
  ( beam-free, nemotron-3.5-super-vl-free, nemotron-3.5-lightning-free — never shown )
```
Three published ids invisible; one dead id selectable. Drift is baked into L4/L7.

**AFTER — the picker reflects SSOT liveness:**
```
[ OpenCode (Free) — suggested models ]
  ▸ opencode/beam-free
  ▸ opencode/nemotron-3.5-super-vl-free
  ▸ opencode/nemotron-3.5-lightning-free
  ▸ opencode/big-pickle
  ( minimax-m3.1-flash-free and deepseek-v4-flash-free — correctly absent )
```
No markup changes: `providerModelsFetcher.js` (L12-31) renders whatever the endpoint returns. The fix is entirely in the data the `"opencode-free"` filter yields.

---

## 🧪 4. Test Strategy & TDD Red-Green-Refactor (HARD RULE)

**Step 1 — RED.** Add an `"opencode-free"` describe block to `tests/unit/minimax-code-usage.test.js` (the sole existing file importing `FILTERS`, L11) with the assertions below; run and confirm it fails for the expected reason — the filter still special-cases `big-pickle` / `deepseek-v4-flash-free` and still offers `minimax-m3.1-flash-free` — not setup/import noise.
**Step 2 — GREEN.** Swap `"opencode-free"` (L21-24) to read the SSOT; delete L4 and L7 (DD-03-2).
**Step 3 — REFACTOR.** Keep tests green while enforcing ≤50 lines/function, ≤3 nesting levels, 300 LOC warn / 500 LOC block.

### Named test cases
1. **phantom dropped** — `FILTERS["opencode-free"](<upstream rows incl. minimax-m3.1-flash-free>)` yields no row with `id === "minimax-m3.1-flash-free"` (E4.1; SSOT non-ALIVE).
2. **hidden ids exposed** — the result includes `beam-free`, `nemotron-3.5-super-vl-free`, `nemotron-3.5-lightning-free` when upstream lists them and the SSOT marks them `ALIVE` (KPI "Missing exposure" → 0, index.md L149).
3. **ALIVE-only** — no returned row's SSOT state is non-`ALIVE`; asserted against `listFreeModels(LANES.INFERENCE)`.
4. **no suffix heuristic** — a non-ALIVE id that merely `endsWith("-free")` is still excluded (the old `endsWith("-free")` bypass is gone).
5. **`big-pickle` via SSOT** — offered iff SSOT says `ALIVE` on inference; absent if the SSOT says otherwise.
6. **`deepseek-v4-flash-free` via SSOT** — suppressed because the SSOT marks it non-ALIVE, **not** because a local `Set` says so (assert the constant is gone).
7. **defensive empty** — `FILTERS["opencode-free"]([])` and `FILTERS["opencode-free"](undefined)` yield `[]` and do not throw (fail-open, matching the RTK convention).

**Regression Guard Assertion:** assert `filters.js` no longer defines `KNOWN_FREE_OPENCODE_MODELS` / `DEAD_FREE_OPENCODE_MODELS` (source-scan or module-shape), and that `filters.js`'s behavior is unchanged for the sibling filters — `"minimax-code"` (L42-51), `"openrouter-free"` (L10-19), `"opencode-go"` (L28-31) — so DD-03-1's server-only assumption and the untouched-filter contract are both pinned.
**Anti-Test-Tampering:** never weaken, delete, or skip a failing assertion. The amendment to `tests/unit/minimax-code-usage.test.js` **adds** an `"opencode-free"` describe; it must not remove or weaken the existing `"minimax-code"` checks (L167-190). A red test is fixed in `filters.js`, never in the assertion.
**Definition of Done:** **0 NEW failures against the 96-failure baseline (E9)** — not "all green". Focused run: `cd tests && npx vitest run unit/minimax-code-usage.test.js`; then `node tests/__baseline__/verify-no-regression.mjs`.

---

## 📦 5. Micro-Chunk Dispatch Units

Both chunks touch `src/app/api/providers/suggested-models/filters.js` **and** `tests/unit/minimax-code-usage.test.js`, so they **share a file boundary and MUST run sequentially** (never parallel). ONE chunk per sub-agent dispatch turn; each commits atomically on PASS.

### 📦 Chunk 1: RED — author the `"opencode-free"` assertions (domain: src/app/api/providers)
- **Target File(s):** `tests/unit/minimax-code-usage.test.js` [AMEND]
- **Scope Boundary:** 1 test file only (tests 1, 2, 7 + regression guard's sibling-filter check). No production file touched.
- **Exact Task:** add the `"opencode-free"` describe block asserting phantom-dropped, hidden-ids-exposed, and defensive-empty; run and confirm it fails for the SSOT reason.
- **Deterministic Verification:** `cd tests && npx vitest run unit/minimax-code-usage.test.js -t "opencode-free"`
- **Expected Output:** FAIL (RED) — the pre-migration `filters.js` still offers the phantom / honors the local `Set`.
- **DoD:** RED confirmed for the expected reason, not setup noise.

### 📦 Chunk 2: GREEN — swap the filter to the SSOT, delete both constants (domain: src/app/api/providers)
- **Target File(s):** `src/app/api/providers/suggested-models/filters.js` [AMEND] & `tests/unit/minimax-code-usage.test.js` [AMEND]
- **Scope Boundary:** 1 module + 1 test only (tests 3, 4, 5, 6 + full regression guard).
- **Exact Task:** (1) delete L4 `KNOWN_FREE_OPENCODE_MODELS` and L7 `DEAD_FREE_OPENCODE_MODELS` (DD-03-2); (2) rewrite `"opencode-free"` (L21-24) to `import` the Phase 01 SSOT at runtime (DD-03-1) and keep only rows whose upstream `id` is present in the upstream list **and** whose SSOT `(LANES.INFERENCE, id)` state is `FREE_MODEL_STATE.ALIVE`; (3) refactor to ≤50 lines/function, ≤3 nesting levels.
- **Deterministic Verification:** `cd tests && npx vitest run unit/minimax-code-usage.test.js && node tests/__baseline__/verify-no-regression.mjs`
- **Expected Output:** PASS; **0 NEW failures**.
- **DoD:** all DoD items below checked.

---

## ✅ 6. Definition of Done (DoD) Checklist

- [ ] `KNOWN_FREE_OPENCODE_MODELS` (filters.js L4) and `DEAD_FREE_OPENCODE_MODELS` (filters.js L7) are **deleted**; no deprecated shim, no re-export (DD-03-2).
- [ ] `"opencode-free"` (filters.js L21-24) answers from the Phase 01 SSOT via a **runtime** import; no id-suffix heuristic, no `big-pickle` special-case remain (DD-03-1).
- [ ] Phantom `minimax-m3.1-flash-free` is no longer offered; `beam-free`, `nemotron-3.5-super-vl-free`, `nemotron-3.5-lightning-free` are exposed → KPI **"Missing exposure" = 0** (index.md L149).
- [ ] Every returned row's SSOT state is `FREE_MODEL_STATE.ALIVE`; `listFreeModels(LANES.INFERENCE)` is the reference set.
- [ ] Sibling filters (`minimax-code`, `openrouter-free`, `opencode-go`) are byte-identical.
- [ ] SSRF behavior of `route.js` L21 is either wired to `src/shared/utils/ssrfGuard.js` **or** left as-is with §7 Open Question 1 explicitly recorded — never silently asserted as fixed.
- [ ] No edit to `open-sse/providers/freeModelCatalog.js`, `capabilities.js`, the provider registry files, the combo path, `errorConfig.js`, the executors, or `proxyFetch.js`; no DDL.
- [ ] `cd tests && npx vitest run unit/minimax-code-usage.test.js` → 100% PASS.
- [ ] `verify-no-regression.mjs` → **0 NEW failures** vs the 96-failure baseline (E9).
- [ ] ≤50 lines/function, ≤3 nesting levels, ≤300 LOC warn / 500 block; single conventional commit `feat(suggested-models): read opencode-free filter from the free-model SSOT [phase-03]`.

**Blockers:** Phase 01 (`open-sse/providers/freeModelCatalog.js`) is REQUIRED and **not yet on disk** (verified absent — Phase 01 is still TODO). Chunk 2 cannot import a module that does not exist, so Phase 01 must land before Phase 03's Chunk 2.

**Open Questions:**
1. **E8 SSRF allowlist source (DD-03-3).** Index.md L202 names it only as *"the provider registry's known catalog URLs"* — the exact accessor is UNVERIFIED. *Named verification step:* grep `open-sse/providers/registry/*` for an exported catalog-URL list (e.g. a `modelsUrl` / `modelsFetcher.url` field on each provider), then decide whether `route.js` L21 uses `assertPublicUrlResolved` / `fetchPublic` from `src/shared/utils/ssrfGuard.js` alone (literal-only, no allowlist) or an allowlist-first check. Do not implement until this is verified; if the phase stays "2 files" per index.md L124, this remains a recorded note, not a chunk.
2. **Test file placement.** The sole existing suggested-models `FILTERS` test is `tests/unit/minimax-code-usage.test.js` (L11, L167) — its name understates its scope once an `"opencode-free"` block is added. The block is added there; renaming or splitting the file is out of scope and deferred.
