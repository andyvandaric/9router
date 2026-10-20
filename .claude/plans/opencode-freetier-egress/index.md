# Master PRD Blueprint: OpenCode Free Tier Egress Retry & Backoff

**Document ID**: `PRD-20261020-OPENCODE-EGRESS-RETRY`
**Status**: APPROVED — Hard Gate 2 granted by the Founder on 2026-10-20 ("mulai wave 1, test, debug, evaluasi, setelah lolos semua lanjut next")
**Confidence**: 97% (see §8 for what is resolved and what remains empirically unknowable)
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
| `"OpenCode's free tier can only be used from within OpenCode."` | client fingerprint | fix fingerprint — **never blind-retry** |
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

| Path | Change |
|---|---|
| `open-sse/utils/freeTierEgress.js` | **NEW** — `classifyFreeTierRejection()`, `EGRESS_UNAVAILABLE` builder, `rewriteEgressRejection()` |
| `open-sse/utils/proxyHealth.js` | **NEW** — `probeProxyEgress()`, SOCKS5 CONNECT liveness, hard timeout, 30s TTL single-flight |
| `open-sse/config/errorConfig.js` | **EDIT** — two rules above the status-403 rule |
| `open-sse/executors/opencode.js` | **EDIT** — bounded egress retry loop replacing single evict+retry |
| `src/sse/services/auth.js` | **EDIT** — noauth: configured-but-unusable pool → terminal, never proxyless |
| `src/sse/handlers/chat.js` | **EDIT** — exhaustion path emits actionable error |
| `scripts/seed-opencode-proxy-pool.mjs` | **NEW** — idempotent; uses `updateSettings` + `createProxyPool`, NOT raw SQL |
| `docs/opencode-freetier-egress.md` | **NEW** — operator runbook |

Not changed: `proxyFetch.js` (direct→proxy replay explicitly out of scope), `src/lib/db/*`, `package.json`.

---

## 4. Wave map

```
Wave 1 (parallel, no deps)
  ├─ 01 freeTierEgress.js + test
  ├─ 03 proxyHealth.js + test
  └─ 05 errorConfig.js + test
        │
Wave 2 (after W1; 02 and 04 parallel with each other)
  ├─ 02 opencode.js retry loop + test   (dep: 01)
  └─ 04 auth.js noauth                  (dep: 03)
        │
Wave 3 (after W2)
  ├─ 06 chat.js terminal error + test   (dep: 02, 05)
  └─ 07 seed script + docs              (dep: 04)
        │
Wave 4 (last, sequential)
  └─ 08 port PR #5046 pinned-pool failover
```

**Recommended split (user decision):** ship **Wave 1–2** first — that alone delivers "don't stop, auto-retry with backoff". Wave 3–4 become a separate follow-up PRD. Total is ~620–700 LOC, above the 600 split threshold.

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

- `403 abusive traffic` → ≥2 upstream attempts with growing delay before terminal error.
- `403 can only be used from within OpenCode` → exactly 1 attempt (no retry).
- Zero occurrences of `20808` / `localhost` in `src/`, `open-sse/`.
- Zero proxyless connections returned while a `proxyPoolId` is configured.
- No infinite loop when exactly one pool exists.
- `nc/llm` regression baselines unchanged.

## 7. E2E scenarios

1. Pool healthy, upstream 200 → single attempt, unchanged behaviour.
2. Pool healthy, upstream 403 abuse ×N → retries with backoff → actionable terminal error.
3. Pool configured but tunnel dead → probe fails fast → terminal error, **never direct**.
4. No pool configured, direct 403 abuse → backoff → actionable terminal error.
5. Fingerprint 403 → single attempt, no retry, clear message.
6. `strictProxy:true` + pool down → terminal error, no egress outside proxy.

## 8. Open risks

| Risk | Status |
|---|---|
| `response.clone()` multi-use | **RESOLVED** — body untouched until executor returns; `base.js:157` consumes nothing for opencode (no `computeRetryDelay`); handlers read once. Mirror `try/catch` from `opencode.js:135`. |
| Settings write path | **RESOLVED** — no in-memory cache (`settingsRepo.js:69-73` reads SQLite every call). Old script failed on **path mismatch** + **wrong `rotateStrategy`** (see phase-03). |
| Probe implementation shape | **RESOLVED** — Phase 03 landed a standalone SOCKS5 CONNECT handshake in `open-sse/utils/proxyHealth.js` (198 LOC) rather than extracting `proxyFetch.js:280-331`; that block's TLS wrapping is too entangled to import cleanly. Verified green 6/6. |
| Upstream gate may never recover within a request | Accepted. Backoff only helps transient blocks; the actionable message is the real deliverable. |
| Terminal status code | **DECIDED** — 403 with a rewritten `code` field. The Founder's directive is to keep the client-visible contract stable while making the body actionable. 503 was rejected: it invites client-side retry storms against a block that retrying cannot clear. |
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
