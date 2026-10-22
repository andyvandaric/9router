# Phase 10 — strictProxy: close the direct-egress leak (no replay for env proxy, no replay for egress-abuse)

**Status**: ✅ Done (2026-10-22 12:18 (UTC+0700), Commits: `a14ff01b`, `79990894`, `ba64c975`)
**Author**: claude
**Confidence**: 97%
**Date**: 2026-10-21
**Target Files**: `open-sse/utils/proxyFetch.js`, `scripts/seed-opencode-proxy-pool.mjs`, `tests/unit/opencode-freetier-direct-replay.test.js`, `tests/unit/seed-opencode-proxy-pool.test.js`

**Wave**: 5 | **Domain**: open-sse/utils + scripts | **Files**: 2 source (+ 2 test)
**Depends on**: Phase 01, Phase 02 | **Unblocks**: Phase 11
**Completed Date**: 2026-10-22 12:18 (UTC+0700)
**Duration**: 3 commits
**Completed in**: `a14ff01b` — `open-sse/utils/proxyFetch.js` (EDIT: env-origin guard + egress-abuse marker guard in `replayFreeTierRejectionDirect`), `scripts/seed-opencode-proxy-pool.mjs` (NEW, writes `strictProxy: true`), `tests/unit/opencode-freetier-direct-replay.test.js` (EDIT), `tests/unit/seed-opencode-proxy-pool.test.js` (NEW). The operator-visible `strictProxy` print landed in `ba64c975` and its rationale comment in `79990894`.
**Reconciled 2026-10-22**: file reconciled against live disk. **Deviation:** the phase was scoped as "2 source + 2 test", but the `strictProxy` change landed in `open-sse/utils/proxyFetch.js` only; the seed-script half (`scripts/seed-opencode-proxy-pool.mjs`, which writes `strictProxy: true`) was folded into **Phase 07**'s script rather than landing as a separate Phase-10 deliverable. Live disk confirms `scripts/seed-opencode-proxy-pool.mjs:174` writes `strictProxy: true` and `:206` prints the read-back value; `open-sse/utils/proxyFetch.js` refuses the direct replay for both the env-proxy origin and the egress-abuse body.

## Goal

Stop the router from re-sending a gate-rejected request from the machine's REAL IP.

`open-sse/utils/proxyFetch.js:437` unconditionally calls `replayFreeTierRejectionDirect(url, options, proxied)` after any proxied 403 whose body contains the marker `"FreeTierError"` (`:339`, `:364`). `replayFreeTierRejectionDirect` (`:356-376`) re-sends the SAME request with `fetchWithTlsFallback(url, options, null)` — **no proxy at all**.

Two independent defects fall out of that one call site:

1. **The proxy's ORIGIN is unknown.** `:404-406` folds the connection/pool proxy and the env proxy into one `proxyUrl` variable:
   ```js
   const connectionProxyUrl = resolveConnectionProxyUrl(targetUrl, proxyOptions);
   const envProxyUrl = connectionProxyUrl ? null : normalizeProxyUrl(getEnvProxyUrl(targetUrl));
   const proxyUrl = connectionProxyUrl || envProxyUrl;
   ```
   For a user with `HTTPS_PROXY`/`ALL_PROXY` (manual VPN / corporate proxy) and NO pool, the request goes out through their chosen proxy, is refused for IP abuse, and is then replayed from their real IP — bypassing the VPN they deliberately chose and getting that real IP flagged by the same upstream gate. The env proxy has no `strictProxy` flag to set (`src/lib/network/connectionProxy.js:102` reads the flag from the POOL ROW only), so this user is strictly worse off than a pool user.

2. **The egress-abuse variant must not be replayed at all.** The gate refuses the *egress IP* for the abuse variant. Replaying the identical request from a SECOND IP is how a second IP gets flagged — that is exactly the mechanism behind the three-egress discriminator (2 of 3 egress IPs ended up flagged, using the same request, credential, fingerprint and model seconds apart).

The replay stays legal ONLY for the OTHER FreeTierError shape — the fingerprint body (`"OpenCode's free tier can only be used from within OpenCode."`) — where the IP was never the problem and a retry from a different address is a legitimate recovery.

Third change: `scripts/seed-opencode-proxy-pool.mjs:156` writes `strictProxy: false` for the pool it seeds. That pool exists for exactly one purpose — keeping free-tier traffic off the direct IP — so it must be `strictProxy: true`.

## Chunk ownership (MANDATORY — two chunks touch the seed script)

| Chunk | Owns | Seed-script region | Test |
|---|---|---|---|
| **10-A** | `proxyFetch.js` origin + variant guards | none | `tests/unit/opencode-freetier-direct-replay.test.js` (EDIT) |
| **10-B** | seed script writes `strictProxy: true` | the `poolPayload` literal only (`:150-157`) | `tests/unit/seed-opencode-proxy-pool.test.js` (NEW) |

**10-B touches ONLY the `poolPayload` object literal.** It does NOT touch `providerStrategies` (`:169-174`) — that region belongs to the Phase 11 chunk-A pool binding, which is a separate chunk with a separate owner. If the two are ever executed in the same worker turn, 10-B must not reformat lines outside `poolPayload`.

**10-B also does NOT own the `providerStrategies` write.** The seed script already writes `providerStrategies.opencode = { proxyPoolId, rotateStrategy: "none" }` at `:169-174`, and the binding is currently ABSENT from the live DB (`settings.providerStrategies = {"antigravity": null}` — no `opencode` key). Phase 11 chunk A owns making that binding real and assertable; Phase 10 only flips the pool's `strictProxy` flag.

## Design / Change

### Chunk 10-A — `open-sse/utils/proxyFetch.js`

**A.1 — carry the proxy's ORIGIN.** Replace the folded `proxyUrl` with an explicit origin.

```js
// before (proxyFetch.js:404-406)
const connectionProxyUrl = resolveConnectionProxyUrl(targetUrl, proxyOptions);
const envProxyUrl = connectionProxyUrl ? null : normalizeProxyUrl(getEnvProxyUrl(targetUrl));
const proxyUrl = connectionProxyUrl || envProxyUrl;

// after
const connectionProxyUrl = resolveConnectionProxyUrl(targetUrl, proxyOptions);
const envProxyUrl = connectionProxyUrl ? null : normalizeProxyUrl(getEnvProxyUrl(targetUrl));
const proxyUrl = connectionProxyUrl || envProxyUrl;
// Origin matters: the env proxy is the operator's deliberate egress choice and the
// direct replay must never bypass it. A pool/legacy proxy may still be replayed
// once, and only for the fingerprint body (see replayFreeTierRejectionDirect).
const proxyOrigin = connectionProxyUrl ? "configured" : (envProxyUrl ? "env" : "none");
```

Named constant, no magic strings inline at the call site:

```js
const PROXY_ORIGIN = { configured: "configured", env: "env", none: "none" };
```

**A.2 — forbid the replay for the env origin.** The call site becomes:

```js
if (proxyUrl) {
  try {
    const proxied = await fetchWithTlsFallback(url, options, proxyUrl);
    // strictProxy never leaves the configured path — pass the rejection through.
    if (proxyOptions?.strictProxy === true) return proxied;
    if (proxyOrigin === PROXY_ORIGIN.env) return proxied;   // ← NEW: env proxy is never bypassed
    return await replayFreeTierRejectionDirect(url, options, proxied);
  } catch (proxyError) { /* unchanged */ }
}
```

**A.3 — forbid the replay for the egress-abuse variant.** `replayFreeTierRejectionDirect` must distinguish the two FreeTierError bodies. The classification is already implemented and PROVEN in `open-sse/utils/freeTierEgress.js`:
- `EGRESS_PHRASE = "detected abusive traffic from this IP address"` (`:21`)
- `FINGERPRINT_PHRASE = "can only be used from within OpenCode"` (`:22`)

`proxyFetch.js` must not import the whole `freeTierEgress.js` module (that module is OpenCode-specific and `proxyFetch.js` is provider-agnostic — importing it would couple the transport to one provider). Instead add a local, provider-agnostic marker:

```js
// The abuse variant names the egress IP ("detected abusive traffic from this IP
// address"). Replaying THAT body from a second address is how a second IP gets
// flagged by the same gate, so it never replays. The fingerprint variant names
// the client, not the network, so it keeps the one-shot direct replay.
const EGRESS_ABUSE_BODY_MARKER = "detected abusive traffic from this ip address";
```

and inside `replayFreeTierRejectionDirect`, after the existing `FREE_TIER_ERROR_MARKER` check (`:364`):

```js
if (text.toLowerCase().includes(EGRESS_ABUSE_BODY_MARKER)) return bufferedResponse(text, proxied);
```

Precedence inside `replayFreeTierRejectionDirect` (order is load-bearing):

1. `proxied.status !== 403` → return as-is (existing, `:361`).
2. body unreadable → return as-is (existing, `:362-365`).
3. body does NOT contain `"FreeTierError"` → return buffered (existing, `:364`).
4. **NEW** body contains the egress-abuse marker → return buffered. **No replay.**
5. body is a stream already locked → return buffered (existing, `:365-367`).
6. otherwise → replay once on the direct egress (existing, `:368-375`).

Note on ordering: the egress-abuse check MUST sit AFTER the `FREE_TIER_ERROR_MARKER` check (step 3) so a non-gate 403 keeps its existing short-circuit, and MUST sit BEFORE the locked-stream check (step 5) so the abuse case never touches the reader.

**A.4 — correct the file's header comment.** The header of `tests/unit/opencode-freetier-direct-replay.test.js` currently claims the replay exists for the egress case:

> "proxyAwareFetch now inspects a proxied 403 and replays once on the direct egress when the body carries the FreeTierError marker."

That is now wrong: the replay exists for the FINGERPRINT variant only. The comment MUST be rewritten to state the new contract:

> The direct replay exists for the CLIENT-FINGERPRINT FreeTierError only ("can only be used from within OpenCode"), where the refusal names the client and not the network. It never fires for the egress-abuse variant ("detected abusive traffic from this IP address") — replaying a request the gate just refused for IP abuse from a second address is how a second address gets flagged — and it never fires when the proxy came from the environment (HTTP_PROXY / HTTPS_PROXY / ALL_PROXY), because the operator chose that egress deliberately.

**A.5 — no behaviour change elsewhere.** `replayFreeTierRejectionDirect` is only reachable from `:437`. The `strictProxy === true` short-circuit at `:436` is untouched. The MITM-bypass branch at `:409-427` and the `proxyIntended` guard at `:459-464` are untouched.

### Chunk 10-B — `scripts/seed-opencode-proxy-pool.mjs`

One-token change in the `poolPayload` literal:

```js
const poolPayload = {
  id: POOL_ID,
  name: POOL_NAME,
  proxyUrl: PROXY_URL,
  description: POOL_DESCRIPTION,
  type: "http",
  isActive: true,
  strictProxy: true,     // ← was `false` (:156)
};
```

Rationale to write in the code comment: this pool exists so free-tier traffic leaves through a VPSEase egress instead of the machine's real IP. `strictProxy: true` is what guarantees it — with `strictProxy: false`, `open-sse/utils/proxyFetch.js:436` lets a proxied failure fall back to the direct path, which is the exact leak this workstream exists to close. The pool's `proxyUrl` points at a local SOCKS5 inbound, so a strict failure surfaces as a terminal error rather than a silent direct egress.

The seed script's `findConflicts` (`:110-125`) compares `proxyUrl` only; it does NOT compare `strictProxy`, so flipping the flag does not trip the conflict check. That is intentional: the flag is the script's own output, and an existing pool row with `strictProxy: false` must be corrected on the next seed run, not refused. The script's read-back block (`:176-188`) prints the pool row — extend that print to include `strictProxy` so the operator can see the effective value:

```js
console.log(`pool strictProxy: ${seededPool?.strictProxy}`);
```

## TDD — tests written FIRST (must fail)

### `tests/unit/opencode-freetier-direct-replay.test.js` (EDIT — ADDITIVE ONLY)

**Every existing title in this file must keep passing, unchanged.** Concretely, these five titles stay exactly as they are and must not be weakened, renamed, or deleted:

1. `"replays once on the direct egress and returns its 200"`
2. `"keeps strictProxy on the configured path — returns the 403, no replay"`
3. `"returns a non-gate 403 untouched, without a direct replay"`
4. `"leaves a proxied 200 stream untouched — one call, body not consumed"`
5. `"surfaces the original 403 when the direct replay itself fails"`

Title 1's fixture is the FINGERPRINT body (`"OpenCode's free tier can only be used from within OpenCode."`), and the replay remains legal for that shape, so **title 1 keeps passing with no edit to its assertions**. Only the file's header comment changes (A.4).

**New titles to add (verbatim):**

6. `"never replays a proxied egress-abuse 403 on the direct egress — one upstream call, no direct dispatcher"`
7. `"never replays a proxied 403 when the proxy came from the environment — one upstream call, no direct dispatcher"`
8. `"replays the fingerprint 403 once on the direct egress — the client was refused, not the network"`

**How title 6 must be proven (the claim, not the flag):** the egress-abuse fixture is the verbatim upstream body

```js
const EGRESS_ABUSE_BODY = JSON.stringify({
  type: "error",
  error: {
    type: "FreeTierError",
    message: "OpenCode's free models aren't available from your current network because we've detected abusive traffic from this IP address.",
  },
});
```

The test must assert, for the egress-abuse body over a CONFIGURED (pool/legacy) proxy:

- `fetchMock` was called **exactly once** (no replay);
- **no** call carries a falsy `dispatcher` — i.e. nothing left over the direct egress. This is the load-bearing assertion: `expect(fetchMock.mock.calls.every(call => call[1]?.dispatcher)).toBe(true)` and `expect(fetchMock.mock.calls[0][1]?.dispatcher).toBeTruthy()`;
- the returned response is the original 403 with the original body (the body is buffered, not consumed twice).

**How title 7 must be proven:** set `process.env.HTTPS_PROXY` (and `ALL_PROXY`) to a fake proxy URL, call `proxyAwareFetch` with `proxyOptions = null` (no pool), and assert the SAME two things — exactly one upstream call, and every call carries a truthy `dispatcher`. Run the case for BOTH body shapes (fingerprint and egress-abuse) inside the same `it`, so the "regardless of body shape" claim is proven. The env vars must be restored in `afterEach` (save/restore `process.env.HTTPS_PROXY`, `process.env.ALL_PROXY`, `process.env.HTTP_PROXY`) so the file does not leak env state into sibling suites.

**How title 8 must be proven:** the fingerprint body over a configured proxy → exactly two calls; call 0 has a truthy `dispatcher` (proxied), call 1 has a falsy `dispatcher` (direct replay); the final response is the direct 200. This is the positive control that proves the guards did not disable the replay wholesale.

**Ordering hazard to avoid:** titles 6-8 depend on env-proxy resolution, so the module-level `vi.mock("undici", ...)` in the file stays as-is (it is already there for the dispatcher path).

### `tests/unit/seed-opencode-proxy-pool.test.js` (NEW)

The seed script has no test today. This is a NEW file and a justified exception to the "no new file without a reason" rule: the script is the thing that writes the pool row, and the pool row's `strictProxy` flag is a security-relevant contract.

**Test seam:** the script is a top-level `main()` that calls `process.exit` — it is not importable. Two acceptable seams, in order of preference:

- **(preferred)** Run the script as a CHILD PROCESS against a scratch `DATA_DIR`, then read back the pool row through the repo API and assert `strictProxy === true`. This proves the actual observable state, not a mock.
- **(fallback, only if the child-process seam proves flaky)** Extract the pool payload into a small exported pure helper in the script (e.g. `export function buildPoolPayload()`) and assert on the returned object. If this fallback is used, the helper must be exported WITHOUT changing the script's CLI behaviour, and the test must ALSO assert the script still runs (`node --check`).

**Titles (verbatim):**

1. `"seed-opencode-proxy-pool: writes strictProxy true on the pool it creates"`
2. `"seed-opencode-proxy-pool: flips strictProxy to true on an existing pool row that has it false"`
3. `"seed-opencode-proxy-pool: is idempotent — a second run still leaves exactly one pool row"`
4. `"seed-opencode-proxy-pool: does not hardcode a proxy host or port outside the seed values"`

Title 4 is a guard on the blueprint invariant: the literal `socks5://127.0.0.1:20808?dns=local` may appear in the SEED SCRIPT and nowhere in `src/` or `open-sse/`. Assert with a repo scan over `src/` and `open-sse/` for `20808` and `127.0.0.1` (excluding `src/lib/db/paths.js`-style legitimate references — none exist today) — keep the scan narrow: `20808` and `:20130`/`20230` are the forbidden literals.

## Constraints

- **The change is ADDITIVE.** No existing test title in `tests/unit/opencode-freetier-direct-replay.test.js` is weakened, renamed, or deleted. The #4983 contract is NARROWED, not broken: the replay remains for the fingerprint body; it is removed for the egress-abuse body and for the env-proxy origin.
- **Do NOT touch `open-sse/utils/freeTierEgress.js` in this phase.** The phrase constants live there, but `proxyFetch.js` is provider-agnostic and must not import an OpenCode-specific module. The duplicate literal in `proxyFetch.js` is deliberate; a one-line comment in `freeTierEgress.js` pointing at the twin is the maximum cross-file coupling allowed (optional, and only if the phase-10 reviewer accepts it).
- **Do NOT touch `src/lib/network/connectionProxy.js`.** The `strictProxy` flag already flows from the pool row (`:102`, `:120`, `:139`, `:159`, `:176`). Only the VALUE the seed script writes changes.
- **No hardcoded host/port in runtime code.** The seed script is the one place the proxy URL literal may live.
- **No DDL, no `src/lib/db/*` edits, no `package.json` edits.**
- **Do not change the `providerStrategies` write in the seed script** (`:169-174`) — that region belongs to Phase 11 chunk A.
- `proxyFetch.js` must keep its fail-open contract: no new throw, no new unhandled rejection. Every new branch returns the ORIGINAL response.

## Acceptance

- A proxied egress-abuse 403 produces **exactly one** upstream call, and **no** call carries a falsy `dispatcher`.
- A proxied 403 over an env-origin proxy produces **exactly one** upstream call, for **either** body shape, and no call carries a falsy `dispatcher`.
- A proxied fingerprint 403 still replays once on the direct egress (two calls: proxied then direct) and returns the direct response.
- `strictProxy: true` pools still return the 403 with no replay (existing title 2 keeps passing).
- Non-gate 403s and proxied 200 streams are untouched (existing titles 3 and 4 keep passing).
- A failed direct replay still surfaces the original 403 (existing title 5 keeps passing).
- The seeded pool row carries `strictProxy: true`; a re-seed over a `strictProxy: false` row flips it to `true` and does not duplicate the row.
- Zero occurrences of `20808` / `20230` / `20130` in `src/` and `open-sse/`.

## Verify

```bash
cd tests && npx vitest run unit/opencode-freetier-direct-replay.test.js unit/seed-opencode-proxy-pool.test.js
cd tests && npx vitest run unit/opencode-egress-retry.test.js unit/free-tier-egress-classify.test.js unit/strict-proxy-enforcement.test.js unit/socks-proxy-dns.test.js
cd tests && npx vitest run unit/opencode-freetier-direct-replay.test.js unit/seed-opencode-proxy-pool.test.js
node __baseline__/verify-providers.mjs && node __baseline__/verify-alias.mjs
```

The second command is the regression sweep: the egress-retry and strict-proxy suites must stay green, because chunk 10-A changes the transport path that `opencode-egress-retry.test.js` exercises indirectly (it mocks `proxyFetch.js` wholesale, so it should be unaffected — that is exactly what the sweep proves).
