# Phase 11 — D3: real egress rotation via VPSEase failover (with a rotation-call budget guard)

**Status**: 🟡 Partial (2026-10-22 14:14 (UTC+0700), Commits: `60f6de30`, `a14ff01b`) — chunk C deferred, not failed
**Author**: claude
**Confidence**: 97%
**Date**: 2026-10-21
**Target Files**: `open-sse/utils/vpseaseRotation.js` (NEW), `open-sse/config/vpseaseConfig.js` (NEW), `open-sse/executors/opencode.js` (EDIT), `tests/unit/vpsease-egress-rotation.test.js` (NEW), `tests/unit/seed-opencode-proxy-pool-binding.test.js` (NEW)

**Wave**: 6 | **Domain**: open-sse/utils + open-sse/config | **Files**: 2 new source + 1 edit (+ 2 test)
**Depends on**: Phase 10, Phase 11-chunk-A | **Unblocks**: none
**Completed Date**: 2026-10-22 14:14 (UTC+0700)
**Duration**: 2 commits (chunk B via `a14ff01b`, dashboard strategy-merge via `60f6de30`)
**Completed in**: **Landed** — chunk B's `strictProxy` change in `open-sse/utils/proxyFetch.js` (`a14ff01b`); the dashboard strategy-merge fix in `src/shared/providerStrategies.js` (NEW), `src/app/(dashboard)/dashboard/providers/[id]/page.js` (EDIT), `src/app/(dashboard)/dashboard/providers/components/ConnectionsCard.js` (EDIT), `tests/unit/provider-strategy-merge.test.js` (NEW) — commit `60f6de30`. **Did NOT land** — chunk A's own test `tests/unit/seed-opencode-proxy-pool-binding.test.js` (never created) and chunk C in full: `open-sse/utils/vpseaseRotation.js` and `open-sse/config/vpseaseConfig.js` (neither file exists on disk).
**Reconciled 2026-10-22**: reconciled against live disk at 14:14 (UTC+0700). The rotation capability this phase describes is **not** available in the shipped build — the phase stays 🟡 Partial, deferred rather than failed.

## Goal

Turn the egress block from "retry the same flagged IP" into "switch to a clean egress and retry". When OpenCode Free answers 403 egress-abuse on a request that rode the VPSEase pool, ask VPSEase to hot-switch its relay to the standby node (a different egress IP) and retry — while spending nothing, provisioning nothing, and never breaking a deployment that has no VPSEase.

**VPSEase is OPTIONAL.** A user with only a manual VPN (env proxy or OS-level TUN) and no VPSEase must keep working exactly as today: bounded backoff → actionable terminal error. The rotation is a no-op when the control endpoint is not configured.

## Chunk order (MANDATORY)

```
chunk A: bind opencode to the pool      (own chunk, own owner, own test — FIRST)
chunk B: strictProxy direct-egress fix  (Phase 10, own chunk, own test)
chunk C: D3 rotation + budget guard + status guard
```

Rationale: A and B make the egress path correct; C depends on A+B; D (Phase 12) is independent and can run any time.

### Chunk A — bind `opencode` to the pool (PREREQUISITE)

**Without this, D3 changes nothing.** Live DB (verified 2026-10-21): `settings.providerStrategies = {"antigravity": null}` — there is **no `opencode` key**. With `rotateStrategy` defaulting to `"none"` (`src/sse/services/auth.js:80`) and no `proxyPoolId`, `pickedId` stays `null` (`auth.js:81`), so `connectionId = "noauth"` (`auth.js:116`) and the request egresses from the **DIRECT IP** — it never touches VPSEase. A rotation would then move an egress that is not in use.

**Owner: this phase (chunk A).** It owns the `providerStrategies` write in `scripts/seed-opencode-proxy-pool.mjs` and its own test.

**Seed-script region ownership** (Phase 10 touches the same file):

| Region | Owner | Change |
|---|---|---|
| `poolPayload` literal (`:150-157`) | **Phase 10 chunk 10-B** | `strictProxy: false` → `true` |
| `providerStrategies` write (`:167-174`) | **Phase 11 chunk A** | write + assert the opencode binding |
| everything else | neither | unchanged |

**What chunk A writes:** `providerStrategies.opencode = { proxyPoolId: "vpsease-main", rotateStrategy: "none" }`.

**Why `rotateStrategy: "none"`:** with `"none"`, `auth.js:81` keeps `pickedId = override.proxyPoolId` — the pin is honoured and the pool is used. The bug the old `scripts/setup-vpsease-proxy.mjs` had was writing `"round-robin"`, which makes `auth.js:82-92` rotate across ALL active pools and ignore the pin. `"none"` + a non-null `proxyPoolId` is the correct binding. (`"none"` with a null `proxyPoolId` is the direct-egress state, which is what live DB has today.)

**Chunk A's own test file:** `tests/unit/seed-opencode-proxy-pool-binding.test.js` (NEW). Titles (verbatim):

1. `"seed-opencode-proxy-pool: binds provider opencode to the pool with rotateStrategy none"`
2. `"seed-opencode-proxy-pool: the opencode binding resolves a non-null pool id — never the noauth connection"`
3. `"seed-opencode-proxy-pool: is idempotent — a second run does not duplicate the pool row or the binding"`
4. `"seed-opencode-proxy-pool: does not overwrite a different already-bound pool without --force"`

Title 2 is the load-bearing one. It must assert, against the seeded settings, that the provider strategy resolves to a non-null `proxyPoolId` and that the resulting connection id would be `proxy:vpsease-main` — never `noauth`. Model the assertion on the resolution path in `src/sse/services/auth.js:79-116`: `override.rotateStrategy === "none"` → `pickedId = override.proxyPoolId` → `connectionId = pickedId ? "proxy:" + pickedId : "noauth"`.

Seam: same as Phase 10's seed test — child process against a scratch `DATA_DIR`, read back through `src/lib/db/repos/proxyPoolsRepo.js` / `settingsRepo.js`.

### Chunk C — the rotation module (this phase's main work)

## Design / Change

### C.1 — the seam (VERIFIED live, 2026-10-21)

**Seam A — MCP over HTTP, unauthenticated, PROVEN working. USE THIS ONE.**

```
POST <VPSEASE_MCP_URL>
Content-Type: application/json
Accept: application/json, text/event-stream

{"jsonrpc":"2.0","id":1,"method":"tools/call",
 "params":{"name":"vpsease_vless_pool_failover","arguments":{"reason":"<text>"}}}
```

Proven working with no credentials: `initialize` returns `{"serverInfo":{"name":"vpsease","version":"1.0.0"}}`; `tools/list` returns the tool with input schema `{"type":"object","properties":{"reason":{"type":"string","description":"Failover reason (default: mcp_manual_trigger)."}}}` — `reason` optional, no required fields. Tool description: "Trigger autonomous hot-switch relay (<200ms) to the standby node."

**Seam B — REST. DO NOT USE.** `POST /api/v1/vless/pool/failover` with body `{"reason":"...","force":false}` (shape proven from the embedded GUI bundle and the Go type `api.failoverRequestBody`), but the auth requirement on POST is only INFERRED and a 401 remains possible. Seam A is chosen because it has a DOCUMENTED input schema and is proven unauthenticated.

**Why the rotation reaches 9router without a restart:** failover rewrites `~/.vpsease/vless-client.json` and reloads sing-box; the `mixed` inbound stays on `127.0.0.1:20808` and the `vless-active` outbound re-points to the new node. 9router's pool row `vpsease-main` has `proxyUrl = socks5://127.0.0.1:20808?dns=local`. The NEXT request through that pool egresses from the new IP. No 9router restart, no 9router DB write, no credential change.

### C.2 — the endpoint is CONFIGURATION, never a literal

The VPSEase control endpoint lives in the **`settings` table** (next to `providerStrategies` / `outboundProxyUrl`), resolved at call time. **No `127.0.0.1:20230` literal in `src/` or `open-sse/`.** The same rule the repo already follows for the proxy URL (seed script only).

New file `open-sse/config/vpseaseConfig.js` — the ONE place the default literal and the env override live:

```js
// The VPSEase control plane. Loopback-only in the shipped binary; the default
// is a local deployment convention, not a product contract, so it lives here
// and ONLY here. Operators override it with VPSEASE_MCP_URL.
export const VPSEASE_DEFAULT_MCP_URL = "http://127.0.0.1:20230/mcp";
export const VPSEASE_MCP_URL_ENV = "VPSEASE_MCP_URL";

export function resolveVpseaseMcpUrl(env = process.env) {
  const raw = env?.[VPSEASE_MCP_URL_ENV];
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return VPSEASE_DEFAULT_MCP_URL;
}
```

**Why env AND settings, with settings winning:** the settings table is the operator-facing surface (the Dashboard already stores `outboundProxyUrl` there — live DB confirms `outboundProxyEnabled: true`, `outboundProxyUrl: "socks5://127.0.0.1:20808"`). The env var is the deployment-level override. Resolution order at call time:

1. `settings.vpseaseMcpUrl` (if a non-empty string) — the operator's explicit setting;
2. `process.env.VPSEASE_MCP_URL` (if a non-empty string);
3. `VPSEASE_DEFAULT_MCP_URL` (the config module's constant).

The settings key is new (`vpseaseMcpUrl`); the phase must add it to the settings write path used by the seed script (chunk A's region) **only if** the operator is expected to configure it there. If the phase does not add a settings writer for it, the env var alone is sufficient and the settings lookup simply returns undefined — that is a valid, simpler configuration surface. **DECISION: env var `VPSEASE_MCP_URL` is the primary surface; the settings key is read if present but is not written by the seed script.** The phase must state which, so no two chunks write the same settings key.

### C.3 — the rotation module (`open-sse/utils/vpseaseRotation.js`, NEW)

Pure-ish, fail-open, provider-agnostic in shape (it knows nothing about OpenCode; the caller supplies the reason string and the pool id).

```js
// Exports
export const ROTATION_BUDGET = {
  maxRotationsPerHour: 3,        // must not exceed VPSEase's own vless_hourly_limit
  minIntervalMs: 300_000,        // VPSEase's own 300 s single-flight dedupe window
  maxConcurrentProvisions: 0,    // 9router never provisions
  perEgressCooldownMs: 900_000, // 15 min between rotations for the same pool id
};

export async function rotateVpseaseEgress({ poolId, reason, controlUrl, budget, now, fetchImpl })
  // → { ok: boolean, skipped?: "not_configured"|"no_standby"|"circuit_breaker_open"|"budget_exhausted"|"rate_limited"|"cooldown"|"in_flight", triggered?: boolean, reason?: string }
```

**NEVER throws.** Every failure mode resolves `{ ok: false, skipped: "<reason>" }`.

**Budget constants — the numbers and why:**

| Constant | Value | Source / rationale |
|---|---|---|
| `maxRotationsPerHour` | 3 | VPSEase's own `vless_hourly_limit = 3`. The local guard MUST NOT exceed the upstream's own limit — a rotation past it is noise at best and harmful at worst. |
| `minIntervalMs` | 300_000 | VPSEase's own 300 s single-flight dedupe window (`rejected-dup: %.0f trigger digabung dalam window 300s`). The local guard mirrors it so 9router does not spend a call on a call VPSEase will reject. |
| `perEgressCooldownMs` | 900_000 | 9router-side per-pool cooldown. A flagged node stayed in one stint for 115 minutes in the measured ledger, so a 15-minute per-egress cooldown is conservative without stalling recovery. |
| `maxConcurrentProvisions` | 0 | **9router NEVER provisions.** Failover hot-switches to an already-provisioned `WARM_STANDBY` node ($0); provisioning is the separate `replenish` action ($5/node/month). The constant is 0 and the module exposes no replenish path at all. |

**The budget is a ROTATION-CALL-RATE guard, not a spend guard** — because failover costs $0 and provisions nothing. But the guard still must be hard: when the local budget is exhausted, 9router makes **NO rotation call at all** and falls back to bounded backoff → terminal error. Fail-closed.

**Budget state is in-process, in-memory** (a `Map<poolId, number[]>` of rotation timestamps + a `Map<poolId, number>` last-rotation timestamp). The 403 is NEVER persisted on the no-auth path (see C.5), so a post-hoc DB detector is impossible; in-process state is the only option and matches the request lifetime.

### C.4 — the call sequence (exactly two MCP calls, both optional-first)

```
1. controlUrl = resolveControlUrl(settings, env)      // undefined → skip("not_configured")
2. if (!controlUrl) → return { ok:false, skipped:"not_configured" }     // no request at all
3. budget check (per-hour count, min-interval, per-egress cooldown) → skip("budget_exhausted"|"rate_limited"|"cooldown")
4. in-flight guard (one concurrent rotation per pool id) → skip("in_flight")
5. status = await mcpCall("vpsease_vless_pool_status", {})   // READ-ONLY guard
     - any failure → return { ok:false, skipped:"status_unavailable" }   // fail open, no failover call
     - if (!status.state?.standby_node) → skip("no_standby")
     - if (status.circuit_breaker_open === true) → skip("circuit_breaker_open")
6. result = await mcpCall("vpsease_vless_pool_failover", { reason })
     - any failure → return { ok:false, skipped:"failover_unavailable" }
     - if the tool reports triggered !== true → return { ok:false, skipped:"not_triggered" }
7. record the rotation timestamp in the budget state
8. return { ok:true, triggered:true }
```

**Step 5 is mandatory.** VPSEase's binary guards on `standby node ID cannot be empty`, `standby node public IP cannot be empty`, `standby node has invalid role: %s` (required role `WARM_STANDBY`), and `standby node and active node cannot have identical public IP: %s`. A failover with no standby is a REJECTION, so 9router must not spend the call. The read-only status call also tells 9router whether the circuit breaker is open.

**Live state at investigation time (2026-10-21)**: active = `node-vpsease-pool-1792539252447628800` / 52.78.178.11 / ap-northeast-2 / HEALTHY; standby = `node-vpsease-pool-1792539515576700000` / 65.0.80.165 / ap-south-1 / `WARM_STANDBY` / HEALTHY; `circuit_breaker_open = false`; `retired_nodes = []`. A standby exists, so the guard passes.

**The MCP transport.** JSON-RPC 2.0 over HTTP POST with `Accept: application/json, text/event-stream`. The response body may be JSON or an SSE frame — the parser must handle BOTH (strip a leading `data: ` line if present, then `JSON.parse`). A malformed body → fail open (`skipped:"malformed_response"`), never throw.

**A hard timeout on every call** (e.g. 3 s per call, 6 s total for status + failover). The rotation must not hold the request slot: the executor's bounded backoff is the client's latency budget, and a hung control plane must not extend it beyond the timeout. `AbortSignal.timeout` or an `AbortController` + `setTimeout` — the codebase already uses `AbortSignal.any` in `open-sse/executors/base.js`.

**9router does NOT know the egress IP, and must not guess it.** 9router knows only the POOL ID (from `args?.proxyOptions?.proxyPoolId`, `open-sse/executors/opencode.js:464`). VPSEase maps pool → egress IP and retires the old node. 9router NEVER sends, infers, or derives an IP. The `reason` string carries the pool id, e.g. `"9router egress_abuse pool=vpsease-main"`.

### C.5 — the rotation must be IN-PROCESS, IN-REQUEST (hard acceptance criterion)

The 403 is **never persisted** for the no-auth path:
- `src/sse/services/auth.js:309` returns `{shouldFallback:false}` for `connectionId === "noauth"`;
- the `proxy:` branch (`:310-313`) returns without persisting either;
- `open-sse/executors/opencode.js:419-473` only calls the in-memory `evictStableSession`.

Live DB proof: `providerConnections` has **0** rows for provider `opencode`; `usageHistory` (471,154 rows) has status values ONLY `ok`/`success` and 0 rows matching 403; a raw-byte scan of `data.sqlite` finds **0** occurrences of `FreeTierError`, `egress_abuse`, `client_fingerprint`.

**Therefore no passive/post-hoc detector is possible.** The rotation MUST be an in-process, in-request call made at the moment the executor sees the egress-abuse 403. This is an acceptance criterion, not an implementation detail.

### C.6 — the executor integration (`open-sse/executors/opencode.js`)

Inside the existing bounded egress loop (`:453-473`), after the `kind !== FREETIER_KIND.egress` bail and BEFORE the `egressAttempt >= MAX_EGRESS_ATTEMPTS` terminal branch:

```js
if (kind !== FREETIER_KIND.egress) return result;

// NEW: a flagged egress can be REPLACED, not only retried. Rotate the VPSEase
// relay to its standby node (a different egress IP) and retry on the new
// egress. Fail-open: any failure leaves the existing bounded-backoff path
// untouched.
const poolId = args?.proxyOptions?.proxyPoolId || null;
if (poolId && !rotatedForEgress) {
  rotatedForEgress = true;
  const rotation = await rotateVpseaseEgress({
    poolId,
    reason: `9router egress_abuse pool=${poolId}`,
    // controlUrl + budget resolved by the module; no literal in this file
  });
  if (rotation?.ok) {
    // the relay now egresses from a different IP — retry immediately,
    // no backoff wait, and reset the attempt counter for the new egress
    evictStableSession(prepared);
    prepared = this.prepareRequestCredentials(args);
    egressAttempt = 1;
    continue;
  }
  // rotation skipped or failed → fall through to the existing backoff path
}
```

**Rules:**
- Rotate ONLY when the request rode the pool VPSEase owns (`args?.proxyOptions?.proxyPoolId`). A different pool's 403 must NOT trigger a rotation.
- **At most ONE rotation per request** (`rotatedForEgress` guard). The existing `MAX_EGRESS_ATTEMPTS = 3` bound still applies; the rotation does not extend the attempt budget — it changes the egress the remaining attempts use.
- **On rotation success, the retry is immediate** (no backoff sleep) because the egress changed, not the request. The old egress was flagged; waiting for it to un-flag is pointless.
- **On rotation failure/skipped, the existing path is byte-for-byte identical to today** (evict → sleep `getQuotaCooldown(egressAttempt)` → retry → terminal `rewriteEgressRejection`).
- The terminal error message is NOT changed. `buildEgressUnavailableMessage` (`open-sse/utils/freeTierEgress.js:67-77`) already names the correct remedy for a no-VPSEase user ("change the network to a different egress IP", "enable another proxy pool in the Dashboard"). **Phase 11 must NOT regress that text.**
- `rotatedForEgress` must be declared alongside `rotatedForRateLimit` / `rotatedForFingerprint` (`:421-423`).

### C.7 — why this is worth doing, when VPSEase already auto-rotates on 403

VPSEase already classifies 403 bodies and auto-rotates: its own probe (`probeEndpoint = http://127.0.0.1:20128/v1`, `probeModel = oc/minimax-m3.1-flash-free`, `probeIntervalSec = 180`) emits `quota_exhausted_403` (189 occurrences in the ledger) → `failover {new_active_ip:...}` → `replenished-standby {stage:post_failover}` → a `node_lifecycle_history` retire_reason of `upstream free tier quota exhausted (HTTP 403 FreeTierError)` (20 rows).

**But VPSEase cannot tell 9router's two variants apart.** The binary contains **0** occurrences of `abusive` / `from this ip address` and only **1** of `free tier can only be used from within opencode`. So VPSEase treats the egress-abuse 403 and the fingerprint 403 identically.

A 9router-driven call buys exactly two things:
1. **LATENCY** — immediate (<200 ms) versus up to ~12 minutes at the 180 s probe cadence.
2. **PRECISION** — 9router classifies both variants exactly (Phase 01's classifier, PROVEN against verbatim upstream bodies), so it can rotate on the egress-abuse variant and NOT rotate on the fingerprint variant (where rotating the egress would be pointless — the client is what was refused).

### C.8 — measured VPSEase rotation reality (context for the budget, not a blocker)

`~/.vpsease/vpsease.db` ledger: 725 rotations; lifetime min 7 s, **avg 2,223 s (37 min)**, max 54,338 s (15 h); retire reasons `failover_exhausted` n=652 (avg 2,255 s), `upstream free tier quota exhausted (HTTP 403 FreeTierError)` n=20 (avg 2,369 s), `auto_destroy` n=23, `mcp_manual_trigger`. Probe cadence from `vless_probe_history`: 300 probes, p50 39.2 s, p90 55.8 s, max 116.4 s. VPSEase's own caps: `vless_hourly_limit = 3`, `vless_monthly_cap = 10`, `vless_max_nodes = 5`, `vless_auto_provision = false`. Node cost = $5/month each; account balance 169.79 USD.

**Because failover provisions nothing, the 9router budget bounds CALL RATE, not spend.** The cost risk is the one Anke flagged (a rotation with `standby_node: null` could provision a billable node) — and the module's design PREVENTS that: 9router never calls `vpsease_vless_pool_replenish`, and it refuses to call failover when there is no standby (step 5).

## TDD — tests written FIRST (must fail)

### `tests/unit/vpsease-egress-rotation.test.js` (NEW)

The module is imported with an injected `fetchImpl` (no real network in tests) and a controllable `now` (so the budget window is testable without fake timers).

**Titles (verbatim):**

1. `"vpsease rotation: is a no-op when no control endpoint is configured — zero requests are made"`
2. `"vpsease rotation: calls the status tool first and skips the failover when there is no standby node"`
3. `"vpsease rotation: skips the failover when the circuit breaker is open"`
4. `"vpsease rotation: triggers the failover with the pool id in the reason when a standby is available"`
5. `"vpsease rotation: makes NO failover call when the hourly budget is exhausted"`
6. `"vpsease rotation: makes NO failover call inside the 300 s single-flight window"`
7. `"vpsease rotation: makes NO failover call inside the per-egress cooldown"`
8. `"vpsease rotation: fails open on a connection-refused control plane and never throws"`
9. `"vpsease rotation: fails open on a timeout and never throws"`
10. `"vpsease rotation: fails open on a non-2xx response and never throws"`
11. `"vpsease rotation: fails open on a JSON-RPC error object and never throws"`
12. `"vpsease rotation: fails open on a malformed body and never throws"`
13. `"vpsease rotation: fails open when the tool reports triggered false"`
14. `"vpsease rotation: fails open when the tool name is unknown"`
15. `"vpsease rotation: never calls a provisioning tool — the module exposes no replenish path"`

**Assertions that make these prove the claim, not the flag:**
- Titles 1, 2, 3, 5, 6, 7: `expect(fetchMock).toHaveBeenCalledTimes(0)` for the FAILOVER call specifically (title 2 DOES make one call — the status call — so it asserts the failover call count is 0 by inspecting the JSON-RPC `params.name` of every captured call).
- Title 5: seed the budget with 3 rotations in the last hour, call again → assert the failover call count is exactly 0 AND the returned `skipped` is `"budget_exhausted"`.
- Title 4: assert the failover call's JSON body has `params.name === "vpsease_vless_pool_failover"`, `params.arguments.reason` contains the pool id, and that the status call happened FIRST (call order).
- Title 15: assert that no captured call's `params.name` matches `/replenish|provision|create/i`.
- Titles 8-14: `await expect(rotateVpseaseEgress(...)).resolves.toMatchObject({ ok: false })` and `expect(...).not.toThrow()`.

**Executor-level tests (same file, second `describe`):**

16. `"opencode executor: rotates the VPSEase egress once on egress_abuse and retries on the new egress"`
17. `"opencode executor: does not rotate when the request did not ride a proxy pool"`
18. `"opencode executor: a failed rotation leaves the request path identical to today — bounded backoff then the actionable terminal error"`
19. `"opencode executor: rotates at most once per request"`

Title 16: mock the rotation module, assert the failover was requested with the pool id from `proxyOptions.proxyPoolId`, and that the retry after a successful rotation happens with NO backoff wait (fake timers: the retry must occur before the first cooldown elapses). Title 18: mock the rotation module to fail, assert the same attempt count and the same terminal body (`egress_abuse`, pool id) that today's code produces — i.e. the failure path is unchanged.

### `tests/unit/seed-opencode-proxy-pool-binding.test.js` (NEW) — chunk A

Titles 1-4 as listed in chunk A above.

## Constraints

- **VPSEase is OPTIONAL.** No control endpoint configured → the module makes **zero requests** and the request path is byte-for-byte today's path.
- **Fail open on EVERY failure mode:** absent, connection refused, timeout, non-2xx, malformed body, JSON-RPC error object, `triggered:false`, unknown tool, status call failure. A rotation failure must **never** surface to the client.
- **9router NEVER provisions.** No `vpsease_vless_pool_replenish` call, no `vpsease_deploy_vps` call, no equivalent. `maxConcurrentProvisions` is 0 and no code path can raise it.
- **9router NEVER guesses the egress IP.** It reports the POOL ID; VPSEase maps pool → IP.
- **No `127.0.0.1:20230` literal in `src/` or `open-sse/`.** The one default lives in `open-sse/config/vpseaseConfig.js` as `VPSEASE_DEFAULT_MCP_URL` and is overridable by `VPSEASE_MCP_URL`.
- **The terminal error message is unchanged.** `buildEgressUnavailableMessage` keeps naming "change the network to a different egress IP" and the Dashboard remedy.
- **Do NOT change `open-sse/utils/freeTierEgress.js`.**
- **Do NOT change `open-sse/utils/proxyFetch.js`** (Phase 10 owns it).
- **Do NOT change `src/lib/db/*`** — no DDL. The settings key `vpseaseMcpUrl`, if read, is read via the existing `getSettings()`.
- The executor's `MAX_EGRESS_ATTEMPTS = 3` bound and the `getQuotaCooldown` backoff curve are unchanged.
- Every new async path must respect the request `signal` (`args?.signal`) so an aborted request never waits on the control plane.

## Acceptance

- No control endpoint configured → **zero** requests to the control plane; the request behaves exactly as today.
- Budget exhausted → **zero** failover calls; the request falls back to bounded backoff → the existing actionable terminal error.
- No standby → **zero** failover calls (the status call may happen; it is read-only and free).
- Circuit breaker open → **zero** failover calls.
- Every failure mode resolves `{ ok: false, skipped: "<reason>" }` and never throws.
- The failover call is made at most once per request, and only when `proxyOptions.proxyPoolId` is non-null.
- The module never calls a provisioning tool.
- `127.0.0.1:20230` appears ZERO times in `src/` and `open-sse/` outside `open-sse/config/vpseaseConfig.js`.
- After chunk A is applied, `auth.js` resolves a non-null `pickedId` for provider `opencode` — the connection id is `proxy:vpsease-main`, never `noauth`.
- The 403 is still not persisted (no new DB writes for the no-auth path).

## Verify

```bash
cd tests && npx vitest run unit/vpsease-egress-rotation.test.js unit/seed-opencode-proxy-pool-binding.test.js
cd tests && npx vitest run unit/opencode-egress-retry.test.js unit/free-tier-egress-classify.test.js unit/opencode-session-rotation.test.js unit/opencode-freetier-direct-replay.test.js
node __baseline__/verify-providers.mjs && node __baseline__/verify-alias.mjs
```
