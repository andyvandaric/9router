# Master PRD Blueprint: OpenCode Free Tier Egress Retry & Backoff

**Document ID**: `PRD-20261020-OPENCODE-EGRESS-RETRY`
**Status**: ✅ COMPLETED for Phases 01–08 and 10 (all landed on `master`, unpushed). Phase 09 CUT (no file, never existed). Phase 11 PARTIAL: the dashboard strategy-merge fix landed; its chunk A binding test and chunk C rotation module did not. See §9 for the per-phase landing record.
**Confidence**: 97% (see §8 for what is resolved and what remains empirically unknowable)
**Last Verified Against Disk**: 2026-10-22 14:14 (UTC+0700)
**Supersedes**: `.claude/plans/opencode-freetier-fix/` (obsolete: targets muse-spark-1.3, `/zen/v1`, UA 1.19.0, dual-session headers — all already implemented or retired)

---

## 1. Problem

OpenCode Free returns `403 FreeTierError` with `"...detected abusive traffic from this IP address..."` and it reaches the client as a terminal error. No retry, no backoff, session dead.

### Verified root-cause chain

| # | Location | Behaviour |
|---|---|---|
| 1 | `src/sse/services/auth.js:47-85` | `providerStrategies.opencode` absent → `pickedId=null` → `connectionId:"noauth"`, **no proxy at all** |
| 2 | `src/sse/services/auth.js:261` | `connectionId==="noauth"` → `{shouldFallback:false}` → loop stops → 403 returned verbatim |
| 3 | `open-sse/executors/opencode.js:407-421` | 403 → evict session + retry **once**; session changes, egress IP does not |
| 4 | `open-sse/utils/proxyFetch.js:356` | replay proxy→direct only; no direct→proxy |
| 5 | `open-sse/config/errorConfig.js:59-77` | no rule matches `"abusive traffic"` |

Live DB evidence: `providerStrategies: {"antigravity": null}` — **no opencode key** — while pool `vpsease-main` exists, active, and unused.

### Two FreeTierError variants (verbatim, both captured)

| Variant | Meaning | Correct action |
|---|---|---|
| `"OpenCode's free tier can only be used from within OpenCode."` | client fingerprint | evict the stable session and retry **once** (upstream answers a stale/exhausted session with this same body — live probes 2026-10-17); never enter the bounded backoff loop |
| `"OpenCode's free models aren't available from your current network because we've detected abusive traffic from this IP address."` | **egress** | retry same egress + bounded backoff |

---

## 2. Design invariants (non-negotiable)

1. **No hardcoded host/port in runtime code.** Egress comes from the pool row via `getProxyPools()` / `resolveConnectionProxyConfig()`. `127.0.0.1:20808` appears ONLY in the seed script + docs (VPSEase prod is the only port buyers get; dev=20850 / staging=20855 out of scope).
2. **One local inbound only** → a pool list of length 1 means *no failover exists*. Never write ladder logic implying candidates that aren't there.
3. **Never silently fall back to direct when a pool is configured but unhealthy** → explicit terminal error. Direct+backoff is legal ONLY for users with no pool configured at all.
4. `strictProxy:true` never leaves the proxy path.
5. **Never lock/cooldown the synthetic `noauth` account** in DB — request-scope handling only.
6. **Health-probe mandatory**: a live sing-box with a dead upstream VLESS *hangs* (SOCKS5 accepts, then stalls) rather than refusing.
7. `?dns=local` is a 9router-side transport opt-in (PR #4987), NOT a VPSEase contract. Not documented as required.

---

## 3. File map

Status column reflects what is on disk as of 2026-10-22, not what was planned.

| Path | Change | Landed |
|---|---|---|
| `open-sse/utils/freeTierEgress.js` | **NEW** — `classifyFreeTierRejection()`, `buildEgressUnavailableMessage()`, `rewriteEgressRejection()` | ✅ 6886f112 |
| `open-sse/utils/proxyHealth.js` | **NEW** — `probeProxyEgress()`, SOCKS5 CONNECT liveness, hard timeout, 30s TTL single-flight | ✅ 6886f112 |
| `open-sse/config/errorConfig.js` | **EDIT** — two rules above the status-403 rule | ✅ 6886f112 |
| `open-sse/executors/opencode.js` | **EDIT** — bounded egress retry loop replacing single evict+retry; **also carries the Phase 06 terminal-error rewrite** | ✅ 68d8b1bb |
| `src/sse/services/auth.js` | **EDIT** — noauth: configured-but-unusable pool → terminal, never proxyless; pinned-pool failover | ✅ 68d8b1bb, 8d2116ce |
| `src/sse/handlers/chat.js` | **EDIT** — exhaustion path emits actionable error | ❌ **never modified** — see §9, Phase 06 |
| `open-sse/utils/proxyFetch.js` | **EDIT** — env-origin and egress-variant replay guards (Phase 10; was declared out of scope in the original draft) | ✅ a14ff01b |
| `scripts/seed-opencode-proxy-pool.mjs` | **NEW** — idempotent; uses `updateSettings` + `createProxyPool`, NOT raw SQL | ✅ a14ff01b, 79990894, ba64c975 |
| `docs/opencode-freetier-egress.md` | **NEW** — operator runbook, **untracked** (`.gitignore:52` ignores `docs/*`) | ✅ on disk only |
| `src/shared/providerStrategies.js` | **NEW** — `mergeProviderStrategy()`; not in the original plan (Phase 11) | ✅ 60f6de30 |

Not changed: `src/lib/db/*`, `package.json`.

---

## 4. Wave map (as shipped)

Actual landing order. Waves 1–4 all shipped; the dependency graph held, but Wave 3's Phase 06 landed inside the executor rather than `chat.js`, and Wave 4 (Phase 08) carried two commits the plan never described.

```
Wave 1 (parallel, no deps)                ✅ 6886f112 (one commit, all three)
  ├─ 01 freeTierEgress.js + test
  ├─ 03 proxyHealth.js + test
  └─ 05 errorConfig.js + test
        │
Wave 2 (after W1; 02 and 04 parallel)     ✅ 68d8b1bb (one commit, both)
  ├─ 02 opencode.js retry loop + test
  └─ 04 auth.js noauth
        │
Wave 3 (after W2)
  ├─ 06 terminal error                    ✅ 68d8b1bb — landed in open-sse/executors/opencode.js, NOT chat.js
  └─ 07 seed script + docs                ✅ a14ff01b (script), 79990894 + ba64c975 (docblock/print)
        │
Wave 4 (last, sequential)
  └─ 08 pinned-pool failover              ✅ 8d2116ce, plus af591a0d + 6ca7d389 (undocumented, see §9)
        │
Wave 5 (added after the plan)
  └─ 10 strictProxy / no direct replay    ✅ a14ff01b
        │
Wave 6 (Phase 11)
  ├─ chunk A — seed binds opencode pool   🟡 landed in substance (a14ff01b + 79990894 + ba64c975); its own test file tests/unit/seed-opencode-proxy-pool-binding.test.js was NOT created
  ├─ chunk B — strictProxy fix            ✅ a14ff01b (= Phase 10)
  ├─ dashboard strategy-merge fix         ✅ 60f6de30 (undocumented, see §9) — this is what made chunk A stick
  └─ chunk C — D3 rotation module         ❌ NOT IMPLEMENTED — open-sse/utils/vpseaseRotation.js and open-sse/config/vpseaseConfig.js do not exist

Phase 09                                  ⛔ CUT before implementation — no phase file exists, none will be created
```

**Recommended split (user decision):** ship **Wave 1–2** first — that alone delivers "don't stop, auto-retry with backoff". Wave 3–4 become a separate follow-up PRD. Total is ~620–700 LOC, above the 600 split threshold.

**What actually happened:** the split was not taken as a separate PRD — Waves 1–4, 5 and the Phase 11 dashboard fix all landed on `master` in one local run (6886f112 → 6ca7d389), none of it pushed. The only open work is Phase 11 chunk C.

---

## 5. Reuse inventory (do not rewrite)

| Reuse | Location |
|---|---|
| `computeRetryDelay(response, attempt, delayMs)` hook | `open-sse/executors/base.js:111-125` |
| `retryConfig` merge + `resolveRetryEntry` | `base.js:107`, `open-sse/config/runtimeConfig.js:78-93` |
| Bounded exponential backoff | `open-sse/services/accountFallback.js:9-13` + `errorConfig.js:32-36` |
| Error taxonomy text rules | `open-sse/config/errorConfig.js:59-77` |
| Clone-guarded marker probe | `open-sse/executors/opencode.js:131-142` |
| `evictStableSession` | `opencode.js:119-126` |
| SOCKS5 CONNECT dial (probe basis) | `open-sse/utils/proxyFetch.js:280-331` |
| Proxy URL resolution (never hardcode) | `src/lib/network/connectionProxy.js:66,92` |
| Pool table API | `src/lib/db/repos/proxyPoolsRepo.js:30-40,59` |
| Settings write path (no cache) | `src/lib/db/repos/settingsRepo.js:104-123` |
| Terminal body rewrite idiom | `open-sse/utils/proxyFetch.js:342-348` |

---

## 6. KPI / Definition of Done

Measured against disk 2026-10-22:

| KPI | Status | Evidence |
|---|---|---|
| `403 abusive traffic` → up to `MAX_EGRESS_ATTEMPTS` (3) attempts with growing delay, then actionable terminal error | ✅ | `open-sse/executors/opencode.js:32,458-470`; `tests/unit/opencode-egress-retry.test.js:75` |
| `403 can only be used from within OpenCode` → session evicted, retried **once**, second result returned (no backoff loop) | ✅ | `opencode.js:443-451`; `e2e` proven by `opencode-egress-retry.test.js:93` |
| Zero occurrences of the proxy port `20808` in `src/`, `open-sse/` | ✅ | only `#20808D` (a Perplexity brand colour) matches |
| Zero proxyless connections returned while a `proxyPoolId` is configured | ✅ | `src/sse/services/auth.js:130-150` throws `EGRESS_PROXY_UNAVAILABLE` |
| No infinite loop when exactly one pool exists | ✅ | `auth.js:110-121`; `tests/unit/noauth-pinned-pool-failover.test.js:130` |
| Provider/alias regression baselines unchanged | ✅ | `verify-providers.mjs` → 94 providers; `verify-alias.mjs` → 132 tokens |
| Focused suites for phases 01–08, 10, 11-A green | ✅ | 10 files / 63 tests pass, 2026-10-22 11:07 |

`"localhost"` was originally listed as forbidden too. It is not enforceable and was never enforced: 106 legitimate occurrences exist in dashboard/UI code (`cliEndpointMatch.js:8`, tool cards). The proxy URL literal rule targets the seed script only.

## 7. E2E scenarios

1. Pool healthy, upstream 200 → single attempt, unchanged behaviour.
2. Pool healthy, upstream 403 abuse ×3 → retries with backoff → actionable terminal error naming the pool.
3. Pool configured but tunnel dead → probe fails fast → `EGRESS_PROXY_UNAVAILABLE`, **never direct**.
4. No pool configured, direct 403 abuse → backoff → actionable terminal error.
5. Fingerprint 403 → one session eviction + one retry, no backoff loop.
6. `strictProxy:true` + pool down → terminal error, no egress outside proxy.
7. Pinned pool excluded after a fallbackable error, another active pool exists → that pool is used (proxy→proxy).
8. Proxied egress-abuse 403 → exactly one upstream call, never a direct replay.

## 8. Open risks

| Risk | Status |
|---|---|
| `response.clone()` multi-use | **RESOLVED** — body untouched until executor returns; `base.js:157` consumes nothing for opencode (no `computeRetryDelay`); handlers read once. Mirror `try/catch` from `opencode.js:135`. |
| Settings write path | **RESOLVED** — no in-memory cache (`settingsRepo.js:69-73` reads SQLite every call). Old script failed on **path mismatch** + **wrong `rotateStrategy`** (see Phase 07). |
| Probe implementation shape | **RESOLVED** — Phase 03 landed a standalone SOCKS5 CONNECT handshake in `open-sse/utils/proxyHealth.js` (198 LOC) rather than extracting `proxyFetch.js:280-331`; that block's TLS wrapping is too entangled to import cleanly. Verified green 6/6. |
| Upstream gate may never recover within a request | Accepted. Backoff only helps transient blocks; the actionable message is the real deliverable. |
| Terminal status code | **DECIDED, and shipped differently than drafted** — status stays **403** (unchanged client contract), but the body is replaced wholesale by `{ error: { type: "FreeTierError", kind: "egress_abuse", message: buildEgressUnavailableMessage(ctx) } }` (`freeTierEgress.js:93-98`). No `code` field is rewritten. 503 was rejected: it invites client-side retry storms against a block that retrying cannot clear. |
| Probe adds ≤3s on a dead pool, once per 30s TTL | Accepted; log it so operators see the TTL hit. |

### The flag is on the egress IP — proven, not inferred (2026-10-20)

Three distinct egress IPs were probed with the **same** request, credentials (`Authorization: Bearer public` — the free tier carries no credential), fingerprint, and model:

| Egress | Result |
|---|---|
| `103.169.130.166` (home ISP, direct) | `403 FreeTierError … abusive traffic from this IP address` |
| `3.6.89.188` (older VPSEase node) | `403 FreeTierError … abusive traffic from this IP address` |
| `43.201.55.132` (current VPSEase node) | **200 OK** — glm-5.3-flash-free streaming content |

Only the egress differed, so the block tracks the IP, not the account. Two consequences shape this blueprint:

1. **The flag is time-varying per egress.** A VPSEase-class pool rotates nodes automatically (10+ egress IPs observed in `node_egress_metrics`), so the same pool can be blocked and then clean within hours. Retry + backoff against a *clean* egress is therefore the primary remedy, not a fallback.
2. **Liveness ≠ clean.** The Phase 03 probe proves the tunnel is alive; it says nothing about the egress IP's reputation. The terminal error must name both remedies: run the probe, and if the 403 persists after the retries, change egress (rotating the pool node). Switching IPv4/IPv6 does not help — IP reputation is the signal.

**Confidence 97%.** The remaining 3% is the upstream's real transient behaviour — unknowable without a live block, and it changes no implementation decision.

---

## 9. 📦 Per-phase landing record

Reconciled against live disk and `git log` on **2026-10-22 14:14 (UTC+0700)**. Every commit SHA below was read from the repository's own history, not from a note.

| Phase | Status | Landing commit(s) | Files that actually landed |
|---|---|---|---|
| **01 — Classify the two FreeTierError variants** | ✅ Done | `6886f112` | `open-sse/utils/freeTierEgress.js` (NEW), `tests/unit/free-tier-egress-classify.test.js` (NEW) |
| **02 — Egress retry + backoff** | ✅ Done | `68d8b1bb` | `open-sse/executors/opencode.js` (EDIT), `tests/unit/opencode-egress-retry.test.js` (NEW) |
| **03 — Proxy health probe** | ✅ Done | `6886f112` | `open-sse/utils/proxyHealth.js` (NEW, ~198 LOC), `tests/unit/proxy-health-probe.test.js` (NEW) |
| **04 — No-auth, no direct leak** | ✅ Done | `68d8b1bb` | `src/sse/services/auth.js` (EDIT), `tests/unit/noauth-egress-resolution.test.js` (NEW) |
| **05 — Error taxonomy** | ✅ Done | `6886f112` | `open-sse/config/errorConfig.js` (EDIT), `tests/unit/error-config-freetier.test.js` (NEW) |
| **06 — Terminal error** | ✅ Done **with deviation** | `68d8b1bb` | `open-sse/executors/opencode.js` (EDIT) — co-touched `src/sse/services/auth.js`, `tests/unit/noauth-egress-resolution.test.js`, `tests/unit/noauth-proxy-fallback.test.js`, `tests/unit/opencode-egress-retry.test.js` |
| **07 — Seed script + runbook** | ✅ Done | `a14ff01b`, `79990894`, `ba64c975` | `scripts/seed-opencode-proxy-pool.mjs` (NEW), `tests/unit/seed-opencode-proxy-pool.test.js` (NEW), `tests/unit/opencode-freetier-direct-replay.test.js` (EDIT). **`docs/opencode-freetier-egress.md` is on disk but UNTRACKED** — `.gitignore:52` ignores `docs/*` and only `!docs/ARCHITECTURE.md` is un-ignored, so the runbook is not in any commit. |
| **08 — Pinned-pool failover** | ✅ Done | `8d2116ce`, `6ca7d389`, `af591a0d` | `src/sse/services/auth.js` (EDIT), `tests/unit/noauth-pinned-pool-failover.test.js` (NEW); `open-sse/providers/registry/opencode.js` + `open-sse/providers/registry/opencode-zen.js` (EDIT — declare the `deepseek-v4.1-*` ids on the curated lanes); `open-sse/providers/models/helpers.js` (EDIT — keep the `deepseek-v4.1-*` ids on chat completions only) with `tests/unit/noauth-proxy-fallback.test.js` (EDIT) |
| **09** | ✂️ **CUT** | — | No phase file was ever created and no commit exists. The scope was absorbed by Phase 04 (no-auth egress resolution). |
| **10 — strictProxy, no direct leak** | ✅ Done **with deviation** | `a14ff01b`, `79990894`, `ba64c975` | `open-sse/utils/proxyFetch.js` (EDIT), `scripts/seed-opencode-proxy-pool.mjs` (NEW), `tests/unit/opencode-freetier-direct-replay.test.js` (EDIT), `tests/unit/seed-opencode-proxy-pool.test.js` (NEW) |
| **11 — VPSEase egress rotation** | 🟡 **PARTIAL** | `60f6de30` (+ chunk B via `a14ff01b`) | **Landed:** the dashboard strategy-merge fix — `src/shared/providerStrategies.js` (NEW), `src/app/(dashboard)/dashboard/providers/[id]/page.js` (EDIT), `src/app/(dashboard)/dashboard/providers/components/ConnectionsCard.js` (EDIT), `tests/unit/provider-strategy-merge.test.js` (NEW); plus chunk B's `strictProxy` change in `open-sse/utils/proxyFetch.js` via `a14ff01b`. **Did NOT land:** chunk A's own test `tests/unit/seed-opencode-proxy-pool-binding.test.js` (never created) and chunk C in its entirety — `open-sse/utils/vpseaseRotation.js` and `open-sse/config/vpseaseConfig.js` (neither file exists on disk). |

### Recorded deviations

1. **Phase 06 — terminal error landed in a different file than planned.** The plan targeted `src/sse/handlers/chat.js`. The actionable terminal error instead landed in `open-sse/executors/opencode.js` via `rewriteEgressRejection` (from `open-sse/utils/freeTierEgress.js`), because that is the layer that owns the upstream response and therefore the only place the error body can be replaced before it reaches the client. `src/sse/handlers/chat.js` was not modified.

2. **Phase 10 — the strictProxy change landed in `proxyFetch.js` only.** The phase was scoped as "2 source + 2 test", but the seed-script half (`scripts/seed-opencode-proxy-pool.mjs`, which writes `strictProxy: true`) was folded into **Phase 07**'s script rather than landing as a separate Phase-10 deliverable. `open-sse/utils/proxyFetch.js` carries the env-origin guard and the egress-abuse marker guard in `replayFreeTierRejectionDirect`; the operator-visible `strictProxy` print landed in `ba64c975` and its rationale comment in `79990894`.

3. **Phase 11 — PARTIAL, with the landed and unlanded chunks named.** Chunk B (`strictProxy`) landed in `a14ff01b`. The dashboard strategy-merge fix landed in `60f6de30`. Chunk A's own test file was never created. Chunk C was not implemented at all: `open-sse/utils/vpseaseRotation.js` and `open-sse/config/vpseaseConfig.js` do not exist. The phase stays **🟡 Partial** — deferred, not failed — and the rotation capability it describes is **not** available in the shipped build.

4. **Phase 07 — the runbook is untracked.** `docs/opencode-freetier-egress.md` exists on disk (10,761 bytes) but no commit contains it, because `.gitignore:52` ignores `docs/*`. Landing it needs an explicit `git add -f` or a `.gitignore` exception; the blueprint does not assume either.
