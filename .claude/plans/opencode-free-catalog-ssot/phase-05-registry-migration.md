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
- **DD-2 — Only the genuinely-410 id GOES.** `muse-spark-1.2-contributor-free` **STAYS**: three repo sources corroborate that 1.2 is **served** while only 1.3 is 410 — `registry/opencode.js:37-41` (live-verified 2026-10-17: *"ABSENT from the /models listing but the inference endpoint still serves it (dashboard ping 200) — keep declared"*), `tests/unit/executor-const-guard.test.js:55-66` (asserts 1.2 present, 1.3 absent), and `CHANGELOG.md:90` (1.2 deliberately restored). An earlier draft of this phase removed 1.2 as a 410 model — **that was wrong and is retracted.** What DOES go on the inference lane is the stale `forceAutoToolChoiceModels` entry naming `muse-spark-1.3-contributor-free` (L30), which is 410. **The L34-41 comment block is KEPT, not deleted** — its claims are accurate and it is the only on-disk record of the 1.2/1.3 distinction. *Named verification step:* re-probe 1.2 before editing; if it returns 410, restore it to the removal set.
- **DD-3 — Header `"desktop"` → `"cli"`.** `OPENCODE_CLIENT = "cli"` in `open-sse/executors/opencode.js` L23 and `open-sse/executors/opencode-zen.js` L25; the executors honour a caller-supplied `x-opencode-client` and otherwise send `"cli"` (opencode.js L501, opencode-zen.js L224). The registry's `"desktop"` default is therefore the *only* source of the fingerprint rejection. Change it in four places: `registry/opencode.js` L18 (transport headers) and L50 (`systemoneConfig.headers`); `registry/opencode-zen.js` L127 (`systemoneConfig.headers`; its transport headers at L23 are empty). All four must agree with the executor constant.
- **DD-4 — Lane-keyed, not shared — and `big-pickle` is NOT absent from zen.** The two registries must NOT be treated as one merged free list. **Corrected on disk (2026-10-23):** `big-pickle` is already declared in the zen registry at `opencode-zen.js:106` as a **paid-lane** model (`{ id: "big-pickle", name: "Big Pickle", supportedFormats: ["openai"] }`), sitting *above* the `// Free tier on the keyed lane` comment at L108. It is therefore **not** a missing id and **nothing needs adding**. Two consequences: (a) the master index §5 row P05's instruction to "add `big-pickle`" to zen is **superseded — do not follow it** (it would create a duplicate); (b) an earlier draft of this DD asserted big-pickle was absent from zen, which is **wrong and is retracted**. The lane-keyed principle still holds: do not move ids between the paid and free blocks, and do not assume an inference-lane id is zen-lane live.
- **DD-5 — Field preservation per surviving id.** Migration preserves `targetFormat`, `supportedFormats`, and `kind` verbatim on every surviving id. Dropping `targetFormat: "openai-responses"` or `kind: "systemone"` would silently change routing.
- **DD-6 — No hand-maintained free ids after migration (zen lane only).** On the **zen** lane the declared free ids are `listFreeModels(LANES.ZEN)` filtered by the lane's transport requirements; no literal free list survives there. **Exception (audit 2026-10-23): the inference lane keeps its 3 literal declarations**, because each carries a per-id routing field (`targetFormat: "openai-responses"`, `kind: "systemone"`) that `listFreeModels` does not supply — deriving them would lose routing metadata (DD-5). The inference lane's literal list is *verified against* the SSOT by the test, not replaced by it. Both registries still share **one SSOT**; neither duplicates a *liveness* constant.

---

## 🏛️ 2. Architectural Specification

### `open-sse/providers/registry/opencode.js` (free/inference lane)
- **Declared models list (L33-45) after migration — 3 → 3 entries (NO removal on this lane):**
  - KEEP `muse-spark-1.2-contributor-free` (L42) — 1.2 is **live** (DD-2); keeps `targetFormat: "openai-responses"` (DD-5).
  - KEEP `deepseek-v4.1-flash-free` (L43) WITH `supportedFormats: ["openai"]` (DD-5).
  - KEEP `jev-1.13-free` (L44) WITH `kind: "systemone"` (DD-5).
- Other free ids (`glm-5.3-flash-free`, `nemotron-*`, `longcat`, `deepseek`, `mimo`, `beam`, `space-bunny`, `big-pickle`) continue to arrive through `passthroughModels` (L55) from `modelsFetcher` (L54, `https://opencode.ai/inference/v1/models`) — no literal declaration is added or removed for them; DD-1 keeps the fingerprint-blocked ones present in what the fetcher exposes.
- L34-41: the comment block is **KEPT verbatim** (DD-2 — its claims are accurate and it is the only on-disk record of the 1.2/1.3 distinction). Do **not** delete it, and do **not** edit its text.
- L30: `forceAutoToolChoiceModels: ["muse-spark-1.3-contributor-free"]` — 1.3 IS 410, so this entry is stale; the key is removed (leave `quirks: {}` or drop `quirks`; removing the stale entry, not the quirk mechanism).
- L18 transport header and L50 `systemoneConfig` header `"desktop"` → `"cli"` (DD-3).
- **No model addition and no model removal on this lane.** The only functional change is the header fix (DD-3) plus the stale quirk removal.

### `open-sse/providers/registry/opencode-zen.js` (zen lane)
- **Free ids after migration — 10 → 4 (stay):** `deepseek-v4.1-flash-free` (L110), `mimo-v2.6-flash-free` (L111), `nemotron-3.5-lightning-free` (L115), `jev-1.13-free` (L121, `kind: "systemone"`).
- **REMOVE 6 STALE (not in the zen lane catalog — E2/E4.4):** `deepseek-v4-flash-free` (L109), `mimo-v2.5-free` (L112), `ling-3.0-flash-fin-free` (L113), `nemotron-3-ultra-free` (L114), `muse-spark-1.3-contributor-free` (L117), `muse-spark-1.2-contributor-free` (L118).
  > **⚠️ AUDIT NOTE (2026-10-23).** The **1.2** removal here is a **lane-specific** claim and is NOT covered by the inference-lane liveness evidence in DD-2. The 1.2-served finding (`registry/opencode.js:37-41`) is against `https://opencode.ai/inference/v1/models`; the zen lane is a **different endpoint** (`zen/v1/models`, L131) and liveness is a `(lane, id)` property. 1.2 is therefore removed here **only if** the zen catalog genuinely omits it. *Named verification step (chunk 2, before edit):* probe `zen/v1/models` for both muse ids. If the zen lane serves 1.2, keep it and remove only 1.3. Do not infer zen liveness from the inference-lane evidence in either direction.
- Non-free `jev-1.13` (L120, `kind: "systemone"`) is untouched — it is not a free id.
- **NOT added:** `big-pickle` — already present at `opencode-zen.js:106` on the paid lane; do not duplicate it into the free block (DD-4).
- L127 `systemoneConfig` header `"desktop"` → `"cli"` (DD-3).
- Removal rule per id: an id is removed iff `getState("zen", id).state` is `DEPRECATED`, `DEAD_UPSTREAM`, or `UNKNOWN`-on-this-lane **and** a probe confirms it; it is kept iff `ALIVE` or `FINGERPRINT_BLOCKED` (DD-1). The lane is part of the key.

### Shared-derivation rule (DD-6)
Both files declare free ids as a projection of `listFreeModels(lane)` — `LANES.INFERENCE` / `LANES.ZEN` — filtered by the lane transport's format requirements. Neither file imports a literal free list. The two registries share **one SSOT, zero duplicated constants**.

---

## 🎨 3. Visual & Interface Design (terminal — no web UI)

**BEFORE — the declared registry and the measured upstream result:**
```
$ node -e "import('./open-sse/providers/registry/opencode.js').then(m=>console.log(m.default.models.map(x=>x.id)))"
[ 'muse-spark-1.2-contributor-free', 'deepseek-v4.1-flash-free', 'jev-1.13-free' ]
# 1.2 is LIVE (inference ping 200) — this list is correct; the DEFECT is the header
# headers: x-opencode-client: "desktop"  (registry L18/L50)  vs executor OPENCODE_CLIENT = "cli"

$ curl -s -X POST https://opencode.ai/inference/v1/chat/completions ... -d '{"model":"beam-free"}'
HTTP 403 FINGERPRINT_BLOCKED  "OpenCode's free tier can only be used from within OpenCode"
$ curl -s ... -d '{"model":"muse-spark-1.3-contributor-free"}'
HTTP 410 Model muse-spark-1.3-contributor-free has been deprecated.
```

**AFTER — corrected header, stale quirk gone, every live model still declared:**
```
$ node -e "import('./open-sse/providers/registry/opencode.js').then(m=>console.log(m.default.models.map(x=>x.id)))"
[ 'muse-spark-1.2-contributor-free', 'deepseek-v4.1-flash-free', 'jev-1.13-free' ]   # UNCHANGED — 1.2 is live
# muse-spark-1.2-contributor-free -> targetFormat: "openai-responses"  (preserved)
# deepseek-v4.1-flash-free       -> supportedFormats: ["openai"]       (preserved)
# jev-1.13-free                  -> kind: "systemone"                  (preserved)
# quirks: forceAutoToolChoiceModels no longer names the 410 1.3 id
# comment block L34-41 KEPT (accurate)
# headers (transport L18 + systemoneConfig L50): x-opencode-client: "cli"

$ node -e "import('./open-sse/providers/registry/opencode-zen.js').then(m=>console.log(m.default.models.filter(x=>x.id.endsWith('-free')).map(x=>x.id)))"
[ 'deepseek-v4.1-flash-free', 'mimo-v2.6-flash-free', 'nemotron-3.5-lightning-free', 'jev-1.13-free' ]
# zen free block closed; 1.3 gone
# big-pickle already present on the PAID lane (zen L106) — unchanged, not duplicated
# systemoneConfig header (L127): x-opencode-client: "cli"
```

---

## 🧪 4. Test Strategy & TDD Red-Green-Refactor (HARD RULE)

**Step 1 — RED.** Author both test files first; run and confirm they fail for the expected reason (the drifted registry), not setup noise.
**Step 2 — GREEN.** Edit the two registries minimally so every assertion passes.
**Step 3 — REFACTOR.** Keep tests green; ≤50 lines/function, ≤3 nesting levels, 300 LOC warn / 500 LOC block.

### `tests/unit/opencode-free-registry.test.js` — assertions
1. Every declared id's SSOT state is not `DEPRECATED` / `DEAD_UPSTREAM`; every id the SSOT marks `ALIVE` on the inference lane is declared or reachable via `passthroughModels`.
2. `muse-spark-1.2-contributor-free` is **PRESENT** with `targetFormat === "openai-responses"` (1.2 is live — DD-2); `muse-spark-1.3-contributor-free` is **absent**.
3. `jev-1.13-free` is present **with** `kind === "systemone"`.
4. `deepseek-v4.1-flash-free` keeps `supportedFormats` deep-equal `["openai"]`.
5. `transport.headers["x-opencode-client"] === "cli"` **and** `systemoneConfig.headers["x-opencode-client"] === "cli"` — and both equal `OPENCODE_CLIENT` read from the executor.
6. `forceAutoToolChoiceModels` does not contain any 410 model id (specifically not `muse-spark-1.3-contributor-free`).
7. `modelsFetcher.url === "https://opencode.ai/inference/v1/models"` (unchanged).
8. The L34-41 comment block is **still present** (DD-2 — it is the on-disk record of the 1.2/1.3 distinction; deleting it is a regression).

### `tests/unit/opencode-zen-free-registry.test.js` — assertions
1. The zen free block uses no literal free-id list; its members deep-equal `listFreeModels(LANES.ZEN)` projected through the lane rules; `muse-spark-1.3-contributor-free` is **absent**.
2. `muse-spark-1.2-contributor-free`'s zen-lane presence matches the **probed** `zen/v1/models` result (chunk 2 verification step) — asserted against the probe outcome, not assumed either way.
3. `big-pickle` IS present at `opencode-zen.js:106` on the **paid** lane and is **not duplicated** into the free block (DD-4).
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
- **Exact Task:** (1) **first, re-probe `muse-spark-1.2-contributor-free` on the inference endpoint and record the status** — if it returns 410 the prune set changes (DD-2 named verification step); (2) change L18 + L50 `x-opencode-client` to `"cli"`; (3) remove the stale 410 id from `forceAutoToolChoiceModels` (L30); (4) **KEEP** the L34-41 comment block verbatim and **KEEP** all 3 declared models with their fields; preserve `supportedFormats`/`kind`/`targetFormat` on the survivors. No model addition or removal on this lane.
- **Deterministic Verification:** `cd tests && npx vitest run unit/opencode-free-registry.test.js unit/executor-const-guard.test.js`
- **Expected Output:** PASS — including the existing `executor-const-guard` guard that asserts 1.2 present / 1.3 absent.
- **DoD:** 0 NEW failures vs baseline.

### 📦 Chunk 2: Zen-lane registry (domain: open-sse/providers/registry)
- **Target File(s):** `open-sse/providers/registry/opencode-zen.js` [AMEND] & `tests/unit/opencode-zen-free-registry.test.js` [NEW]
- **Scope Boundary:** 1 registry + 1 test; zen only
- **Exact Task:** (1) **first, probe `zen/v1/models` for both muse ids and record the result** — the inference-lane liveness finding does not transfer across lanes; (2) remove the stale free ids (L109, L112-L114, and L117/L118 per the probe outcome); (3) change L127 `x-opencode-client` to `"cli"`; (4) keep `deepseek-v4.1-flash-free`, `mimo-v2.6-flash-free`, `nemotron-3.5-lightning-free`, `jev-1.13-free` with their fields intact; (5) do NOT add `big-pickle` (already present at L106 on the paid lane — DD-4).
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

- [ ] `registry/opencode.js` headers (L18 + L50) send `x-opencode-client: "cli"`; the stale `muse-spark-1.3-contributor-free` quirk is gone; **all 3 declared models survive** (1.2 is live) and the L34-41 comment block is **kept**.
- [ ] `registry/opencode-zen.js` L127 sends `x-opencode-client: "cli"`; the stale free ids are gone per the zen-lane probe; `big-pickle` at L106 (paid lane) is unchanged and NOT duplicated into the free block (DD-4).
- [ ] `deepseek-v4.1-flash-free` keeps `supportedFormats: ["openai"]`; `jev-1.13-free` keeps `kind: "systemone"` in both files; `muse-spark-1.2-contributor-free` keeps `targetFormat: "openai-responses"`.
- [ ] Fingerprint-blocked ids (`beam-free`, `nemotron-3.5-super-vl-free`, `nemotron-3.5-lightning-free`) remain declared/exposed (DD-1).
- [ ] The existing `tests/unit/executor-const-guard.test.js` guard (1.2 present / 1.3 absent) still passes — it is the pre-existing witness that this phase must not contradict.
- [ ] Both 1.2/1.3 liveness probes were run per lane and their results recorded in the `Completed Date` note.
- [ ] `registry/opencode-go.js` untouched; no SSOT schema change; no other consumer site touched; no DDL.
- [ ] `registry/index.js` regenerated only via script and byte-identical (zero diff).
- [ ] Both new test files 100% PASS; `verify-no-regression.mjs` → **0 NEW failures** vs the 96-failure baseline (E9).
- [ ] ≤50 lines/function, ≤3 nesting levels, ≤300 LOC warn / 500 block; atomic commits `fix(registry): migrate free-model lists to SSOT + correct x-opencode-client [phase-05]` (one per chunk).

**Blockers:** Phase 01 (`freeModelCatalog.js`) is REQUIRED — the registry lists are derived from `listFreeModels(lane)` / `getState(lane, id)`. Phase 02 is NOT required.

**Open Questions:** none new for Phase 05. Carried only: if the registry generator emits a diff on this checkout, the generator invocation and its committed output belong to Chunk 3 — confirm the exact generator entrypoint at phase start before running it.
