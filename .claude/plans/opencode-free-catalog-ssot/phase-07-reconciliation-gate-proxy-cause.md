# Phase 07 — Reconciliation Gate + Proxy `cause` Fix (`proxyFetch.js`)

**Parent PRD:** [index.md](./index.md)
**Status:** 🟡 READY
**Completed Date:** _(blank — filled at execution)_
**Target Codebase:**
- `open-sse/utils/proxyFetch.js` (AMEND — preserve `cause` at both strict-throw sites; add ONE bounded connect-level retry)
- `tests/unit/free-catalog-five-way-agreement.test.js` (NEW — reconciliation test)
- `tests/unit/proxy-health-probe.test.js` (AMEND — EXISTS on disk, verified this turn)

**Verification:** `cd tests && npx vitest run unit/free-catalog-five-way-agreement.test.js unit/proxy-health-probe.test.js` → 100% PASS; then `node tests/__baseline__/verify-no-regression.mjs` → 0 NEW failures against the E9 baseline (326 passed / 44 failed of 386 files; 3674 passed / 96 failed of 3883 tests).

---

## 🎯 1. Objective & Explicit Non-Goals

### Objective
Close the blueprint with its two terminal gates. **(A) The reconciliation gate:** prove on live ground truth that all FIVE consumer sites read the Phase-01 SSOT and agree with it, and that the live `/v1/models` `oc/` id set contains **0 phantom** and **0 missing** ids (master index §6 KPI rows "Phantom exposure" and "Missing exposure", both target 0). **(B) The proxy-cause fix:** stop `open-sse/utils/proxyFetch.js` from discarding `proxyError.cause` when it re-throws under `strictProxy`, so a caller can tell a retryable connect-level hop failure from a non-retryable one (E7), and add EXACTLY ONE bounded retry for connect-level hop failures only.

### Scope Guard (STRICT — Phase 07 MUST NOT touch)
1. `open-sse/providers/freeModelCatalog.js` — Phase 01 owns its schema. Phase 07 **consumes**, never edits.
2. The five consumer sites themselves — `src/app/api/providers/suggested-models/filters.js` (Phase 03), `open-sse/providers/capabilities.js` (Phase 04), `open-sse/providers/registry/opencode.js` + `opencode-zen.js` (Phase 05), the combo repair path (Phase 06). Phase 07 **asserts** them, never edits them.
3. `open-sse/config/errorConfig.js` and the executors (Phase 02, the 429/quota classifier). A 429/410 is Phase 02's retry concern and MUST NOT be retried here (DD-07-2).
4. No DDL (E10). No hand-edit of the auto-generated `open-sse/providers/registry/index.js` (E10). No change to upstream-merge posture (E1).

### Recorded Design Decisions (explicit — this phase resolves them and records the rationale)
- **DD-07-1 — How `cause` survives the throw.** Prefer `new Error(msg, { cause: proxyError })` (standard `Error.cause`, Node ≥16.9). *Rationale:* it preserves the original error object with its `.code`/`.errno`/`.syscall` intact, unlike string interpolation of `.message`. Node ≥22.5 is already a supported floor (`node:sqlite` in the persistence chain), and `tests/` runs on the repo's Node, so `Error(msg, {cause})` is safe. **Fallback if a legacy engine is ever targeted:** assign `err.cause = proxyError` post-construction — the assertion MAY accept either, but the committed code MUST use the options-bag form. The change is **additive**: keep `.message` text EXACTLY as-is (`[ProxyFetch] Proxy required but failed (strictProxy=true): ${proxyError.message}`) and ADD the cause, so no existing message-matching caller breaks.
- **DD-07-2 — Which errors qualify as "connect-level hop failure".** INCLUDE only transport/connect failures to the proxy hop: `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `ECONNABORTED`, `EHOSTUNREACH`, `ENETUNREACH`, `EPIPE`, and `UND_ERR_CONNECT_TIMEOUT` / `UND_ERR_SOCKET` (undici). EXCLUDE everything that is a *decision* by the upstream — `429`, `410`, `403`, `404`, any HTTP status response — plus `ERR_PROXY_DNS_MODE`. *Rationale:* a 429/410 is Phase 02's quota/deprecation signal (E6); retrying it here would double-count the retry budget and mask the classify path. The discriminator is `proxyError.cause?.code` (falling back to `proxyError.code`); a status-less `cause` is the only thing the retry may act on.
- **DD-07-3 — Where the retry lives.** INSIDE `proxyFetch.js`, wrapping only the `fetchWithTlsFallback(url, options, proxyUrl)` call in the two proxied branches. *Rationale:* the retry is a property of the hop dial, not of the caller's request semantics; keeping it local means the executors (Phase 02) and the direct-egress replay path stay untouched, and the retry cannot leak into the non-proxy branches.
- **DD-07-4 — `ERR_PROXY_DNS_MODE` short-circuit is preserved verbatim.** Both sites re-throw it immediately (`proxyFetch.js:460`, `:484`), before the strict check and before any retry. The retry MUST NOT consume it. *Rationale:* constraint (b) below — the DNS-mode rejection is a deliberate signal, not a flake.

---

## 🏛️ 2. Architectural Specification

### The proxy defect (E7) — verified line anchors this turn
`open-sse/utils/proxyFetch.js` has TWO strict-throw sites, both confirmed on disk:

- MITM DNS-bypass block — `:460` `if (proxyError?.code === "ERR_PROXY_DNS_MODE") throw proxyError;`, then `:461-463` with the throw message at `:462`:
  ```js
  throw new Error(`[ProxyFetch] Proxy required but failed (strictProxy=true): ${proxyError.message}`);
  ```
- Main proxied branch — `:484` `if (proxyError?.code === "ERR_PROXY_DNS_MODE") throw proxyError;`, then `:486-488` with the throw message at `:487` (same string template), and the non-strict fallback at `:489-490` (`console.warn(...)` + `return fetchWithTlsFallback(url, options, null)`).

Requested anchors were given as ~L462 / ~L487 (throw-message lines) and ~L460 / ~L484 (`ERR_PROXY_DNS_MODE` re-throws) and ~L489-490 (non-strict fallback) and ~L504-510 (the `proxyIntended` gate + `:509` `[ProxyFetch] Proxy required but none resolved (strictProxy=true)`). **All anchors match disk as of this turn — no drift.**

Both throw sites interpolate `proxyError.message` and DROP `proxyError.cause` — the only discriminator a caller has to decide whether the connect failure is retryable. Measured impact (E7): during a local tunnel flap the gateway saw 6/107 `proxyAwareFetch` failures (5.6%), and a direct SOCKS5 CONNECT loop measured `OK:16 / ECONNRESET:1 / ECONNREFUSED:13` — 43% failure. Every one surfaced to callers as the same opaque 503 with no cause attached.

### Fix shape (additive, bounded)
```js
const PROXY_CONNECT_RETRY_LIMIT = 1;                 // ONE bounded retry — named constant

const RETRYABLE_CONNECT_CODES = new Set([            // DD-07-2 — connect-level hop failures only
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ECONNABORTED",
  "EHOSTUNREACH", "ENETUNREACH", "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
]);

function connectLevelCode(proxyError) {
  return proxyError?.cause?.code ?? proxyError?.code ?? null;   // cause first, then top-level
}
function isRetryableConnectFailure(proxyError) {
  if (proxyError?.code === "ERR_PROXY_DNS_MODE") return false;  // DD-07-4 — never retried
  return RETRYABLE_CONNECT_CODES.has(connectLevelCode(proxyError));
}
```
Each proxied branch becomes: attempt the dial; on failure, if `isRetryableConnectFailure(proxyError)` AND the attempt count is below `PROXY_CONNECT_RETRY_LIMIT`, retry the SAME hop dial once; when the retry budget is exhausted, fall through to the existing logic unchanged (strict → throw with `cause` attached; non-strict → `:489-490` direct fallback). `ERR_PROXY_DNS_MODE` is re-thrown at `:460`/`:484` before this block is ever reached.

### Reconciliation gate — the FIVE consumer sites (asserted, never edited)
| # | Consumer site | Phase | SSOT API asserted against |
|---|---|---|---|
| 1 | `src/app/api/providers/suggested-models/filters.js` | 03 | `listFreeModels("inference")`; `FREE_MODEL_STATE` |
| 2 | `open-sse/providers/capabilities.js` | 04 | `listFreeModels(lane)` per lane |
| 3 | `open-sse/providers/registry/opencode.js` | 05 | `listFreeModels("inference")` |
| 4 | `open-sse/providers/registry/opencode-zen.js` | 05 | `listFreeModels("zen")` |
| 5 | live DB `combos` table repair path | 06 | `resolveLiveSubstitute(lane, modelId)`; `getState(lane, modelId)` |

Verified this turn: `filters.js` still holds `const KNOWN_FREE_OPENCODE_MODELS` (`:4`) and `const DEAD_FREE_OPENCODE_MODELS` (`:7`) — the RED assertion that Phase 03 removed these is a real check, not a tautology. `freeModelCatalog.js` does NOT yet exist (Phase 01 output).

### `/v1/models` set equality (master index §6, both exposures → 0)
- **0 phantom:** no `oc/<id>` in the live `/v1/models` response resolves to an upstream-absent (410/404) entry — baseline had 1 (`oc/minimax-m3.1-flash-free`).
- **0 missing:** every published upstream free id is exposed — baseline missed 3 (`beam-free`, `nemotron-3.5-super-vl-free`, `nemotron-3.5-lightning-free`).

### Test file status (declared honestly — Glob this turn)
- `tests/unit/free-catalog-five-way-agreement.test.js` — **CREATE** (no match found).
- `tests/unit/proxy-health-probe.test.js` — **AMEND** (EXISTS; currently 6 `proxyHealth` cases against `probeProxyEgress` from `open-sse/utils/proxyHealth.js`, no `cause`-preservation case yet).

---

## 🎨 3. Visual & Interface Design (terminal — no web UI)

**BEFORE — an opaque 503 with no cause:**
```
$ curl -s -o /dev/null -w '%{http_code}' localhost:20128/v1/chat/completions   # tunnel flap
503
# proxyFetch.js:487 -> new Error('...: fetch failed')   <- cause (ECONNREFUSED) DROPPED
# caller cannot tell retryable connect flake from a hard rejection
```

**AFTER — one retry on a connect flake, then a cause-carrying throw:**
```
$ curl -s localhost:20128/v1/chat/completions
200
# proxyFetch: dial failed (cause ECONNREFUSED) -> 1 retry -> dial OK
#          exhaustion -> throw Error(msg, { cause: <ECONNREFUSED err> })
#          ERR_PROXY_DNS_MODE -> rethrown immediately, cause preserved, NO retry

$ node -e "import('./open-sse/providers/freeModelCatalog.js').then(m=>console.log(m.describe()))" | head
lane=inference  big-pickle                 ALIVE        # 5 consumers agree; oc/ set: 0 phantom / 0 missing
```

---

## 🧪 4. Test Strategy & TDD Red-Green-Refactor (HARD RULE)

**Step 1 — RED.** Author `tests/unit/free-catalog-five-way-agreement.test.js` and the new `proxy-health-probe` `cause` case first; run and confirm they fail for the expected reason (SSOT not yet consumed by Phases 03-06; `cause` dropped at `:462`/`:487`), not setup noise.
**Step 2 — GREEN.** Apply the `proxyFetch.js` cause+retry fix; the reconciliation assertions pass once Phases 03-06 have landed their consumer migrations (Phase 07's blockers P02 + P06).
**Step 3 — REFACTOR.** Keep tests green while enforcing ≤50 lines/function, ≤3 nesting levels, 300 LOC warn / 500 LOC block on `proxyFetch.js`.

### Named test cases — reconciliation (`free-catalog-five-way-agreement.test.js`)
1. **five sites agree** — for each of the 5 consumers (table in §2), assert the ids it exposes equal `listFreeModels(lane)` filtered by `state === FREE_MODEL_STATE.ALIVE` for that lane; ONE mismatch fails.
2. **0 phantom** — every `oc/<id>` in the live `/v1/models` payload has `getState("inference", <id>).state !== DEAD_UPSTREAM` and `!== DEPRECATED` (baseline `minimax-m3.1-flash-free` is the RED fixture).
3. **0 missing** — every `listFreeModels(lane)` ALIVE id appears in the `/v1/models` `oc/` set (`beam-free`, the 2 `nemotron-3.5-*-free` ids are the RED fixtures).
4. **consumer 5 substitute** — the 5 stale combos each resolve to a live `(lane,id)` via `resolveLiveSubstitute` (go-lane `muse-spark-1.3-contributor`).
5. **no hand-maintained list remains** — `filters.js` no longer exports/contains `KNOWN_FREE_OPENCODE_MODELS` / `DEAD_FREE_OPENCODE_MODELS` (guards the Phase 03 migration).

### Named test cases — proxy (`proxy-health-probe.test.js`, AMEND)
6. **cause preserved on strict throw** — a strict `proxyAwareFetch` against a closed port throws an `Error` whose `.message` string is unchanged AND whose `.cause.code === "ECONNREFUSED"`.
7. **one bounded retry on connect failure** — a hop that fails `ECONNREFUSED` then succeeds is retried EXACTLY once (dial-count spy === 2); a hop that never recovers is retried exactly `PROXY_CONNECT_RETRY_LIMIT` times, then throws with `cause` attached (budget-exhausted assertion).
8. **429 is never retried here** — a proxied response with status `429` does NOT trigger the connect retry (dial-count === 1); it passes through to Phase 02.
9. **`ERR_PROXY_DNS_MODE` short-circuits** — a `proxyError.code === "ERR_PROXY_DNS_MODE"` is re-thrown at `:460`/`:484` with zero retry attempts.

**Regression Guard Assertion:** assert the strict-throw `.message` text at `:462`/`:487` is byte-identical to the pre-fix string (guards DD-07-1 — additive, not a rewrite), and assert the non-strict fallback at `:489-490` and the `proxyIntended` gate at `:504-510` are unchanged (guards constraints c/d).
**Anti-Test-Tampering:** never weaken, delete, or skip a failing assertion; a red test means fix the module, never the assertion.
**Definition of Done:** **0 NEW failures against the 96-failure baseline (E9)** — not "all green". Focused run: `cd tests && npx vitest run unit/free-catalog-five-way-agreement.test.js unit/proxy-health-probe.test.js`; then `node tests/__baseline__/verify-no-regression.mjs`.

---

## 📦 5. Micro-Chunk Dispatch Units

Hard cap 2 files per chunk; ONE chunk per sub-agent dispatch turn. Chunks 1 and 2 target disjoint files and MAY run in parallel, but each remains a single dispatch.

### 📦 Chunk 1: Reconciliation gate test (domain: tests/unit)
- **Target File(s):** `tests/unit/free-catalog-five-way-agreement.test.js` [NEW]
- **Scope Boundary:** 1 test file only; reads the 5 consumer sites + `freeModelCatalog.js`; edits NONE of them.
- **Exact Task:** implement named cases 1-5 against the §2 table; RED until Phases 03-06 land.
- **Deterministic Verification:** `cd tests && npx vitest run unit/free-catalog-five-way-agreement.test.js`
- **Expected Output:** PASS (post P02/P06) → 5 consumers agree; 0 phantom / 0 missing.
- **DoD:** 0 NEW failures vs baseline.

### 📦 Chunk 2: `proxyFetch.js` `cause` + one bounded retry (domain: open-sse/utils)
- **Target File(s):** `open-sse/utils/proxyFetch.js` [AMEND] & `tests/unit/proxy-health-probe.test.js` [AMEND]
- **Scope Boundary:** 1 module + 1 test only (named cases 6-9 + regression guard); touches ONLY the two proxied branches.
- **Exact Task:** add `PROXY_CONNECT_RETRY_LIMIT = 1` + `RETRYABLE_CONNECT_CODES`; attach `cause` via `new Error(msg, { cause: proxyError })` at `:462`/`:487` keeping `.message` byte-identical; wrap the two `fetchWithTlsFallback(url, options, proxyUrl)` dials with the bounded connect-only retry; leave `:460`/`:484` `ERR_PROXY_DNS_MODE` re-throws, `:489-490` non-strict fallback, and `:504-510` gate untouched.
- **Deterministic Verification:** `cd tests && npx vitest run unit/proxy-health-probe.test.js && node tests/__baseline__/verify-no-regression.mjs`
- **Expected Output:** PASS; 0 NEW failures.
- **DoD:** all DoD items below checked.

---

## ✅ 6. Definition of Done (DoD) Checklist

- [ ] Both strict-throw sites in `open-sse/utils/proxyFetch.js` (`:462`, `:487`) attach `proxyError` as `Error.cause`; `.message` text is byte-identical to pre-fix (DD-07-1).
- [ ] EXACTLY ONE bounded retry, gated by the named constant `PROXY_CONNECT_RETRY_LIMIT = 1`; retries ONLY connect-level hop codes (DD-07-2 INCLUDE set: `ECONNREFUSED`/`ECONNRESET`/`ETIMEDOUT`/`ECONNABORTED`/`EHOSTUNREACH`/`ENETUNREACH`/`EPIPE`/`UND_ERR_CONNECT_TIMEOUT`/`UND_ERR_SOCKET`).
- [ ] **Constraint (a):** `strictProxy` is NOT weakened — no strict path gains a direct-egress fallback; the `:504-510` gate still throws `[ProxyFetch] Proxy required but none resolved (strictProxy=true)` on `strictProxy && proxyIntended`.
- [ ] **Constraint (b):** `ERR_PROXY_DNS_MODE` short-circuits IMMEDIATELY at `:460` and `:484`, before the strict check and before any retry.
- [ ] **Constraint (c):** the non-strict fallback at `:489-490` is unchanged; a 429/410/403 response is NEVER retried here (DD-07-2 EXCLUDE; Phase 02 owns quota retry).
- [ ] **Constraint (d):** the retry budget's exhaustion path falls through to the existing strict-throw / non-strict-fallback logic; asserted by the budget-exhausted case (dial-count === `PROXY_CONNECT_RETRY_LIMIT` then throw).
- [ ] A transient proxy-hop flap (measured 6/107 = 5.6% failures; SOCKS5 `OK:16 / ECONNRESET:1 / ECONNREFUSED:13` = 43%) is distinguishable from a hard rejection because the `cause` reaches the caller.
- [ ] Reconciliation test asserts all FIVE consumers (the §2 table) agree with Phase-01 SSOT via `getState` / `listFreeModels` / `resolveLiveSubstitute` / `FREE_MODEL_STATE`.
- [ ] `/v1/models` `oc/` set has **0 phantom** and **0 missing** (master index §6 "Phantom exposure" and "Missing exposure" both 0).
- [ ] `freeModelCatalog.js` is NOT edited; the 5 consumer sites are NOT edited; `errorConfig.js`/executors NOT edited; no DDL; `registry/index.js` NOT hand-edited.
- [ ] `cd tests && npx vitest run unit/free-catalog-five-way-agreement.test.js unit/proxy-health-probe.test.js` → 100% PASS.
- [ ] `node tests/__baseline__/verify-no-regression.mjs` → **0 NEW failures** vs the 96-failure baseline (E9): 326 passed / 44 failed of 386 files; 3674 passed / 96 failed of 3883 tests.
- [ ] ≤50 lines/function, ≤3 nesting levels, ≤300 LOC warn / 500 block; single conventional commit `feat(proxy-fetch): preserve proxy error cause + one bounded connect retry; add five-way reconciliation gate [phase-07]`.

**Blockers:** P02 (quota classifier — the EXCLUDE contract), P06 (combo repair — consumer 5 must land before agreement can be asserted). W4 sequential.

**Open Questions:**
1. **Does the repo's Node floor guarantee `Error(msg, {cause})` options-bag support everywhere `proxyFetch.js` runs (DD-07-1 fallback)?** — resolved by the suite's Node at execution; VERIFY before finalizing.
2. **Combo-repair file path** — resolved by Phase 06 (`src/lib/db/repair/opencodeComboRepair.js`, NEW); consumer-5 agreement depends on it landing.
3. **Whether the reconciliation test can read the live `/v1/models` route or must construct the payload in-process** — the route lives at `src/app/api/v1/models/route.js` (present on disk); confirm the access pattern at execution.
