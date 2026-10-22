# Phase 05 — Migrate Consumers 3+4: Provider Registry Drift Sites (`opencode.js`, `opencode-zen.js`)

**Parent PRD:** [index.md](./index.md)
**Status:** 🟡 READY
**Completed Date:** _(blank — filled at execution)_
**Target Codebase:**
- `open-sse/providers/registry/opencode.js` (AMEND — free/inference lane registry)
- `open-sse/providers/registry/opencode-zen.js` (AMEND — zen lane registry)
- `tests/unit/opencode-free-registry.test.js` (NEW — inference-lane registry assertions)
- `tests/unit/opencode-zen-free-registry.test.js` (NEW — zen-lane registry assertions)
- `open-sse/providers/registry/index.js` (AUTO-GENERATED — regenerate ONLY via `scripts/migrate-registry.mjs` / `scripts/injectDisplayToRegistry.mjs`; never hand-edit — E10)
- `tests/unit/opencode-free-tool-choice.test.js` (AMEND — only if it pins the removed stale quirk; see Chunk 3)

**Verification:** `cd tests && npx vitest run unit/opencode-free-registry.test.js` and `cd tests && npx vitest run unit/opencode-zen-free-registry.test.js` → 100% PASS; then `node tests/__baseline__/verify-no-regression.mjs` → 0 NEW failures against the E9 baseline (326 passed / 44 failed of 386 files; 3674 passed / 96 failed of 3883 tests).

---

## 🎯 1. Objective & Explicit Non-Goals

### Objective
Migrate the two hand-written provider registry files off their locally-maintained free-model lists so the declared free ids, per lane, are derived from the Phase 01 SSOT (`freeModelCatalog.js`: `listFreeModels(lane)`, `getState(lane, modelId)`, `FREE_MODEL_STATE`, `LANES`). Eliminate the two measured drift sites: the free/inference registry declares a 410 model and a false comment, both registries emit the fingerprint-rejecting `x-opencode-client: "desktop"`, and the zen registry declares 6 of 10 free ids the zen lane does not publish.

### Scope Guard (STRICT — Phase 05 MUST NOT touch)
1. The other three consumer sites: `src/app/api/providers/suggested-models/filters.js` + its route (Phase 03), `open-sse/providers/capabilities.js` (Phase 04), the live `combos` table repair path (Phase 06).
2. `open-sse/utils/freeTierEgress.js`, `open-sse/config/errorConfig.js`, `open-sse/executors/opencode.js` (Phase 02) and `open-sse/utils/proxyFetch.js` (Phase 07).
3. The SSOT module's own schema/exports — Phase 01 owns `open-sse/providers/freeModelCatalog.js`. Phase 05 only CALLS it.
4. `open-sse/providers/registry/opencode-go.js` — the PAID go-lane catalogue (`deepseek-v4.1-flash`, `glm-5.1/5.2/5.3`, `grok-4.6/4.7`, `muse-spark-1.2/1.3-contributor`, `space-bunny-free`, `beam-free`; L90 `modelsFetcher: https://opencode.ai/zen/go/v1/models`) is **out of scope for editing**. The SSOT's `resolveLiveSubstitute` may *point into* it (`go:muse-spark-1.3-contributor` is live and is the substitute for the 410 free-lane `-free` form — E5).
5. No new DB tables / no DDL (E10). No upstream merge (E1). No `strictProxy` change (E7).

### Auto-generated-registry boundary (explicit)
`open-sse/providers/registry/index.js` is **AUTO-GENERATED** — its content is the static import list of provider files, not their model arrays. Editing the model arrays inside `registry/opencode.js` / `registry/opencode-zen.js` does **not** change that import list, so this phase does **not** expect a regenerated `index.js`. The phase MUST still run the generator (`scripts/migrate-registry.mjs`, `scripts/injectDisplayToRegistry.mjs`) and confirm a **zero diff**; if a non-zero diff appears, regenerate and commit it as its own atomic commit — never hand-edit the file.

### Recorded Design Decisions (DD — rationale recorded)
- **DD-1 — Fingerprint-blocked ids STAY declared.** `beam-free`, `nemotron-3.5-super-vl-free`, `nemotron-3.5-lightning-free` remain in the registry. They ARE published upstream (HTTP 200 on the lane catalogs) — their 403 `FINGERPRINT_BLOCKED` ("OpenCode's free tier can only be used from within OpenCode", E6) is a **client-fingerprint condition this repo can fix** (the `"desktop"` header, DD-3), not an upstream removal. Removing a published id would create a *missing-exposure* defect (index §6 KPI: Missing exposure 3 → 0).
- **DD-2 — 410 ids GO.** `muse-spark-1.2-contributor-free` returns HTTP 410 `Model muse-spark-1.2-contributor-free has been deprecated.` (E3) and must be removed from the registry **and** from `forceAutoToolChoiceModels`. It is announced-as-served by the false L38-41 comment, which is deleted.
- **DD-3 — Header `"desktop"` → `"cli"`.** `OPENCODE_CLIENT = "cli"` in `open-sse/executors/opencode.js` L23 and `open-sse/executors/opencode-zen.js` L25; the executors honour a caller-supplied `x-opencode-client` and otherwise send `"cli"` (opencode.js L501, opencode-zen.js L224). The registry's `"desktop"` default is therefore the *only* source of the fingerprint rejection. Change it in four places: `registry/opencode.js` L18 (transport headers) and L50 (`systemoneConfig.headers`); `registry/opencode-zen.js` L127 (`systemoneConfig.headers`; its transport headers at L23 are empty). All four must agree with the executor constant.
- **DD-4 — Lane-keyed, not shared.** The two registries must NOT be treated as one merged free list. `big-pickle` is free/inference-lane only; the zen lane does not publish it. `zen:big-pickle` is `UNKNOWN` in the SSOT (Phase 01 §7 S1) and the zen registry **must not** declare it. *Note:* master index §5 row P05 says "add `big-pickle`" to zen — that phrasing is **superseded by this spec**; the authoritative, lane-keyed rule is §7 S1 and the E2 evidence ("`big-pickle` — which upstream publishes on the FREE lane — is missing from the zen registry (correctly, since the zen lane does not publish it)").
- **DD-5 — Field preservation per surviving id.** Migration preserves `targetFormat`, `supportedFormats`, and `kind` verbatim on every surviving id. Dropping `targetFormat: "openai-responses"` or `kind: "systemone"` would silently change routing.
- **DD-6 — No hand-maintained free ids after migration.** The free ids the registry declares for a lane are `listFreeModels(lane)` filtered by the fields the lane's transport requires; no literal free list survives in either file.

---

## 🏛️ 2. Architectural Specification

### `open-sse/providers/registry/opencode.js` (free/inference lane)
- **Declared models list (L33-45) after migration — 3 → 2 entries:**
  - REMOVE `muse-spark-1.2-contributor-free` (L42) — SSOT `state = DEPRECATED`, upstream 410 (DD-2).
  - KEEP `deepseek-v4.1-flash-free` (L43) WITH `supportedFormats: ["openai"]` (DD-5).
  - KEEP `jev-1.13-free` (L44) WITH `kind: "systemone"` (DD-5).
- Other free ids (`glm-5.3-flash-free`, `nemotron-*`, `longcat`, `deepseek`, `mimo`, `beam`, `space-bunny`, `big-pickle`) continue to arrive through `passthroughModels` (L55) from `modelsFetcher` (L54, `https://opencode.ai/inference/v1/models`) — no literal declaration is added or removed for them; DD-1 keeps the fingerprint-blocked ones present in what the fetcher exposes.
- L34-41: the comment block is **deleted** (its "keep declared" claim for `muse-spark-1.2-contributor-free` is false — E3).
- L30: `forceAutoToolChoiceModels: ["muse-spark-1.3-contributor-free"]` — that id upstream-410s; the key is removed (leave `quirks: {}` or drop `quirks`; removing the stale entry, not the quirk mechanism).
- L18 transport header and L50 `systemoneConfig` header `"desktop"` → `"cli"` (DD-3).

### `open-sse/providers/registry/opencode-zen.js` (zen lane)
- **Free ids after migration — 10 → 4 (stay):** `deepseek-v4.1-flash-free` (L110), `mimo-v2.6-flash-free` (L111), `nemotron-3.5-lightning-free` (L115), `jev-1.13-free` (L121, `kind: "systemone"`).
- **REMOVE 6 STALE (not in the zen lane catalog — E2/E4.4):** `deepseek-v4-flash-free` (L109), `mimo-v2.5-free` (L112), `ling-3.0-flash-fin-free` (L113), `nemotron-3-ultra-free` (L114), `muse-spark-1.3-contributor-free` (L117), `muse-spark-1.2-contributor-free` (L118).
- Non-free `jev-1.13` (L120, `kind: "systemone"`) is untouched — it is not a free id.
- **NOT added:** `big-pickle` (DD-4).
- L127 `systemoneConfig` header `"desktop"` → `"cli"` (DD-3).
- Removal rule per id: an id is removed iff `getState("zen", id).state` is `DEPRECATED`, `DEAD_UPSTREAM`, or `UNKNOWN`-on-this-lane; it is kept iff `ALIVE` or `FINGERPRINT_BLOCKED` (DD-1). The lane is part of the key.

### Shared-derivation rule (DD-6)
Both files declare free ids as a projection of `listFreeModels(lane)` — `LANES.INFERENCE` / `LANES.ZEN` — filtered by the lane transport's format requirements. Neither file imports a literal free list. The two registries share **one SSOT, zero duplicated constants**.

---

## 🎨 3. Visual & Interface Design (terminal — no web UI)

**BEFORE — the declared registry and the measured upstream result:**
```
$ node -e "import('./open-sse/providers/registry/opencode.js').then(m=>console.log(m.default.models.map(x=>x.id)))"
[ 'muse-spark-1.2-contributor-free', 'deepseek-v4.1-flash-free', 'jev-1.13-free' ]   # declares a 410 model
# headers: x-opencode-client: "desktop"  (registry L18/L50)  vs executor OPENCODE_CLIENT = "cli"

$ curl -s -X POST https://opencode.ai/inference/v1/chat/completions ... -d '{"model":"beam-free"}'
HTTP 403 FINGERPRINT_BLOCKED  "OpenCode's free tier can only be used from within OpenCode"
$ curl -s ... -d '{"model":"muse-spark-1.2-contributor-free"}'
HTTP 410 Model muse-spark-1.2-contributor-free has been deprecated.
```

**AFTER — corrected registry and corrected header, routing fields intact:**
```
$ node -e "import('./open-sse/providers/registry/opencode.js').then(m=>console.log(m.default.models.map(x=>x.id)))"
[ 'deepseek-v4.1-flash-free', 'jev-1.13-free' ]        # 410 id gone; no false comment
# deepseek-v4.1-flash-free -> supportedFormats: ["openai"]   (preserved)
# jev-1.13-free           -> kind: "systemone"              (preserved)
# quirks: forceAutoToolChoiceModels no longer names a 410 model
# headers (transport L18 + systemoneConfig L50): x-opencode-client: "cli"

$ node -e "import('./open-sse/providers/registry/opencode-zen.js').then(m=>console.log(m.default.models.filter(x=>x.id.endsWith('-free')).map(x=>x.id)))"
[ 'deepseek-v4.1-flash-free', 'mimo-v2.6-flash-free', 'nemotron-3.5-lightning-free', 'jev-1.13-free' ]
# 6 stale ids gone; big-pickle NOT present (zen lane does not publish it)
# systemoneConfig header (L127): x-opencode-client: "cli"
```

---

## 🧪 4. Test Strategy & TDD Red-Green-Refactor (HARD RULE)

**Step 1 — RED.** Author both test files first; run and confirm they fail for the expected reason (the drifted registry), not setup noise.
**Step 2 — GREEN.** Edit the two registries minimally so every assertion passes.
**Step 3 — REFACTOR.** Keep tests green; ≤50 lines/function, ≤3 nesting levels, 300 LOC warn / 500 LOC block.

### `tests/unit/opencode-free-registry.test.js` — assertions
1. Every declared id's SSOT state is not `DEPRECATED` / `DEAD_UPSTREAM`; every id the SSOT marks `ALIVE` on the inference lane is declared or reachable via `passthroughModels`.
2. `muse-spark-1.2-contributor-free` is **absent**; `muse-spark-1.3-contributor-free` is **absent** (both 410).
3. `jev-1.13-free` is present **with** `kind === "systemone"`.
4. `deepseek-v4.1-flash-free` keeps `supportedFormats` deep-equal `["openai"]`.
5. `transport.headers["x-opencode-client"] === "cli"` **and** `systemoneConfig.headers["x-opencode-client"] === "cli"` — and both equal `OPENCODE_CLIENT` read from the executor.
6. `forceAutoToolChoiceModels` does not contain any 410 model id.
7. `modelsFetcher.url === "https://opencode.ai/inference/v1/models"` (unchanged).

### `tests/unit/opencode-zen-free-registry.test.js` — assertions
1. The zen free set deep-equals `listFreeModels(LANES.ZEN)` projected through the lane rules; `muse-spark-1.2-contributor-free` is **absent**.
2. The zen registry does **NOT** contain `big-pickle` (DD-4).
3. `muse-spark-1.3-contributor-free` is **absent**.
4. `jev-1.13-free` present with `kind === "systemone"`; non-free `jev-1.13` untouched.
5. `systemoneConfig.headers["x-opencode-client"] === "cli"`.
6. `modelsFetcher.url === "https://opencode.ai/zen/v1/models"`.

**Regression Guard Assertion:** after the registry edits, `registry/index.js` is byte-identical after running `scripts/migrate-registry.mjs` + `scripts/injectDisplayToRegistry.mjs` (zero diff), guarding the auto-generated boundary (E10).
**Anti-Test-Tampering:** never weaken, delete, or skip a failing assertion — a red test means fix the registry, never the assertion. Do not add a literal free list to a registry to make a test pass (DD-6).
**Definition of Done:** **0 NEW failures against the 96-failure baseline (E9)** — not "all green". Focused: `cd tests && npx vitest run unit/opencode-free-registry.test.js unit/opencode-zen-free-registry.test.js`; then `node tests/__baseline__/verify-no-regression.mjs`.

---

## 📦 5. Micro-Chunk Dispatch Units

### 📦 Chunk 1: Inference-lane registry (domain: open-sse/providers/registry)
- **Target File(s):** `open-sse/providers/registry/opencode.js` [AMEND] & `tests/unit/opencode-free-registry.test.js` [NEW]
- **Scope Boundary:** 1 registry + 1 test; no zen file, no `index.js`, no SSOT change
- **Exact Task:** (1) delete the L38-41 false comment and the `muse-spark-1.2-contributor-free` entry (L42); (2) change L18 + L50 `x-opencode-client` to `"cli"`; (3) remove the 410 id from `forceAutoToolChoiceModels` (L30); preserve `supportedFormats`/`kind` on the survivors.
- **Deterministic Verification:** `cd tests && npx vitest run unit/opencode-free-registry.test.js`
- **Expected Output:** PASS
- **DoD:** 0 NEW failures vs baseline.

### 📦 Chunk 2: Zen-lane registry (domain: open-sse/providers/registry)
- **Target File(s):** `open-sse/providers/registry/opencode-zen.js` [AMEND] & `tests/unit/opencode-zen-free-registry.test.js` [NEW]
- **Scope Boundary:** 1 registry + 1 test; zen only
- **Exact Task:** (1) remove the 6 stale free ids (L109, L112-L114, L117-L118); (2) change L127 `x-opencode-client` to `"cli"`; (3) keep `deepseek-v4.1-flash-free`, `mimo-v2.6-flash-free`, `nemotron-3.5-lightning-free`, `jev-1.13-free` with their fields intact; do NOT add `big-pickle`.
- **Deterministic Verification:** `cd tests && npx vitest run unit/opencode-zen-free-registry.test.js`
- **Expected Output:** PASS
- **DoD:** 0 NEW failures vs baseline.

### 📦 Chunk 3: Auto-generated registry + stale quirk reconciliation (domain: open-sse/providers/registry)
- **Target File(s):** `open-sse/providers/registry/index.js` [REGENERATE ONLY if non-zero diff] & `tests/unit/opencode-free-tool-choice.test.js` [AMEND — only if it pins the removed stale quirk]
- **Scope Boundary:** regeneration + one existing test file; max 2 files
- **Exact Task:** (1) run `scripts/migrate-registry.mjs` + `scripts/injectDisplayToRegistry.mjs` and confirm zero diff (regenerate + commit separately if non-zero — never hand-edit); (2) if `opencode-free-tool-choice.test.js` asserts `muse-spark-1.3-contributor-free` in `forceAutoToolChoiceModels`, update that assertion to the corrected behaviour (fix the test to the new contract, never to weaken it).
- **Deterministic Verification:** `powershell -NoProfile -NonInteractive -Command "git diff --stat open-sse/providers/registry/index.js"` shows zero for index.js; `cd tests && npx vitest run unit/opencode-free-tool-choice.test.js unit/model-catalog-scope.test.js unit/executor-const-guard.test.js` → PASS
- **Expected Output:** PASS; `index.js` zero diff (or a regenerated diff committed separately)
- **DoD:** all DoD items below checked; 0 NEW failures vs baseline.

---

## ✅ 6. Definition of Done (DoD) Checklist

- [ ] `registry/opencode.js` declares no 410 id; L34-41 comment deleted; `forceAutoToolChoiceModels` names no 410 model.
- [ ] `registry/opencode.js` L18 + L50 and `registry/opencode-zen.js` L127 all send `x-opencode-client: "cli"`, matching `OPENCODE_CLIENT` in `open-sse/executors/opencode.js` L23 / `opencode-zen.js` L25.
- [ ] Zen registry holds exactly the 4 surviving free ids; the 6 stale ids are gone; `big-pickle` is absent from zen (DD-4).
- [ ] `deepseek-v4.1-flash-free` keeps `supportedFormats: ["openai"]`; `jev-1.13-free` keeps `kind: "systemone"` in both files.
- [ ] Fingerprint-blocked ids (`beam-free`, `nemotron-3.5-super-vl-free`, `nemotron-3.5-lightning-free`) remain declared/exposed (DD-1).
- [ ] `registry/opencode-go.js` untouched; no SSOT schema change; no other consumer site touched; no DDL.
- [ ] `registry/index.js` regenerated only via script and byte-identical (zero diff).
- [ ] Both new test files 100% PASS; `verify-no-regression.mjs` → **0 NEW failures** vs the 96-failure baseline (E9).
- [ ] ≤50 lines/function, ≤3 nesting levels, ≤300 LOC warn / 500 block; atomic commits `fix(registry): migrate free-model lists to SSOT + correct x-opencode-client [phase-05]` (one per chunk).

**Blockers:** Phase 01 (`freeModelCatalog.js`) is REQUIRED — the registry lists are derived from `listFreeModels(lane)` / `getState(lane, id)`. Phase 02 is NOT required.

**Open Questions:** none new for Phase 05. Carried only: if the registry generator emits a diff on this checkout, the generator invocation and its committed output belong to Chunk 3 — confirm the exact generator entrypoint at phase start before running it.
