# OpenCode Free tier: egress IP reputation and proxy pool seeding

Operational runbook for the OpenCode Free (`oc/*`) `403 FreeTierError` failures and the proxy pool that resolves them.

---

## 1. Why egress is the problem, not the account

The OpenCode Free tier carries **no credential**. Every request is sent as `Authorization: Bearer public`. There is no account, key, or session that the upstream could reject for entitlement reasons — so a `403` on this tier can only be the **egress IP's reputation**.

That was confirmed empirically, not inferred. Three distinct egress IPs were probed with the **same** request, the same client fingerprint, and the same model:

| Egress IP | Result |
|---|---|
| `103.169.130.166` (home ISP, direct) | `403 FreeTierError` — abusive traffic |
| `3.6.89.188` (older VPSEase node) | `403 FreeTierError` — abusive traffic |
| `43.201.55.132` (current VPSEase node) | **200 OK** — streaming content |

Only the egress differed. The block tracks the IP.

**Consequence:** the flag is **time-varying per egress**. A pool that rotates nodes clears it within hours. The same pool that returned 403 at 09:00 can return 200 at 14:00 without any configuration change. A blocked egress is not a permanently broken account, and retrying against a *clean* egress is the primary remedy — not a fallback.

**Switching IPv4/IPv6 does not help.** IP reputation is the signal; the address family is irrelevant to it. The remedy is a different IP, not a different protocol version.

---

## 2. The two `FreeTierError` variants

Both are `HTTP 403` with `error.type = "FreeTierError"`. Only the **message text** distinguishes them, so 9router classifies on the message.

### 2a. Egress block — `"egress_abuse"`

Verbatim upstream body:

```json
{
  "type": "error",
  "error": {
    "type": "FreeTierError",
    "message": "OpenCode's free models aren't available from your current network because we've detected abusive traffic from this IP address. This isn't related to your account. If you're on a VPN or proxy, turn it off and try again, or subscribe to OpenCode Go at https://opencode.ai/go to keep building."
  }
}
```

Meaning: the **egress IP** is flagged for abusive traffic. Note the upstream's own wording — *"This isn't related to your account."*

Action: retry the same egress with bounded backoff, and if it persists, change the egress IP. 9router does both automatically: up to 3 attempts with exponential backoff, then an actionable terminal error naming the pool and both remedies.

### 2b. Client fingerprint — `"client_fingerprint"`

Verbatim upstream body:

```json
{
  "type": "error",
  "error": {
    "type": "FreeTierError",
    "message": "OpenCode's free tier can only be used from within OpenCode."
  }
}
```

Meaning: the **client fingerprint** was rejected. The upstream wants a request that looks like the official OpenCode client. Retrying cannot fix identity — the same request will be rejected again.

Action: **never blind-retry**. 9router rotates the session once and then fails fast with a long cooldown. If you hit this, the request is not coming through a real OpenCode client path — check the client headers, not the proxy.

### Discriminator

The classifier (`open-sse/utils/freeTierEgress.js`) matches these phrases, case-insensitively:

- egress: `"detected abusive traffic from this IP address"`
- fingerprint: `"can only be used from within OpenCode"`

The fingerprint phrase **outranks** the egress phrase: if a body contains both, it is fingerprint — it is the terminal variant.

---

## 3. Seeding the pool

```bash
node scripts/seed-opencode-proxy-pool.mjs
```

This writes the pool row and pins it to the `opencode` provider:

- pool `vpsease-main`, `proxyUrl: socks5://127.0.0.1:20808?dns=local`, active
- `settings.providerStrategies.opencode = { proxyPoolId: "vpsease-main", rotateStrategy: "none" }`

The script is **idempotent** — running it twice leaves exactly one pool row and one settings entry. It uses the repo APIs (`createProxyPool` / `updateProxyPool`, `updateSettings`), not raw SQL, and it resolves the database through the runtime's own `DATA_DIR` resolution, so it can never write to a different file than the running server reads.

It **refuses** to overwrite a different already-configured pool (exit code 1). Use `--force` to override:

```bash
node scripts/seed-opencode-proxy-pool.mjs --force
```

### Why `rotateStrategy: "none"` matters

`src/sse/services/auth.js` rotates the pinned `proxyPoolId` away across **all active pools** whenever the strategy is not `"none"`. With `"round-robin"` or `"random"` the pin is silently discarded and the request may egress from a different pool than the one you configured. A pin requires `"none"`.

### Why `?dns=local` is not a VPSEase requirement

`?dns=local` is a **9router transport opt-in**, not something VPSEase demands. It makes the local system resolver resolve the target hostname before handing the address to the SOCKS5 tunnel. VPSEase's proxy does not care either way. Use it because some SOCKS gateways mishandle domain targets — see `docs/socks-dns.md`. Omit it (`socks5://127.0.0.1:20808`) if the default remote-DNS behaviour works for your gateway.

### About the port

The port is a **property of the VPSEase deployment**, not of 9router. Production VPSEase listens on `20808`; dev and staging deployments use other ports. Substitute the port your deployment actually serves. 9router never hardcodes a host or port in runtime code — the address lives only in the pool row and in this seed script.

### The superseded script

`scripts/setup-vpsease-proxy.mjs` is **superseded** by the script above and should not be used. It has two defects: it hardcodes `%APPDATA%/9router/db/data.sqlite` instead of resolving `DATA_DIR` (so with `DATA_DIR` set it writes to a file the server never reads), and it writes `rotateStrategy: "round-robin"`, which discards the pin.

---

## 4. Verifying it took effect

### Database

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database(process.env.APPDATA + '/9router/db/data.sqlite', { readonly: true });
console.log(db.prepare('SELECT id, isActive, testStatus, data FROM proxyPools').all());
const s = db.prepare('SELECT data FROM settings WHERE id = 1').get();
console.log(JSON.parse(s.data).providerStrategies);
"
```

Expected:

```
[{ id: 'vpsease-main', isActive: 1, testStatus: 'active',
   data: { name: 'VPSEase Proxy Pool',
           proxyUrl: 'socks5://127.0.0.1:20808?dns=local', ... } }]
{ opencode: { proxyPoolId: 'vpsease-main', rotateStrategy: 'none' } }
```

If `DATA_DIR` is set, use `$DATA_DIR/db/data.sqlite` instead of the `%APPDATA%` path above.

### Dashboard

- **Dashboard → Proxy Pools** — the `VPSEase Proxy Pool` row is present, Active, and its **Test** button reports `active`. A failed test means the tunnel is not answering, not that the configuration is wrong.
- **Dashboard → Providers → OpenCode** — the "No authentication required" card shows **Proxy Pool: VPSEase Proxy Pool** and **Rotation Strategy: none**. If the pool selector reads "None (direct)", the pin did not take.

### Runtime

The 9router server log shows the request leaving as `proxy:vpsease-main`, not `noauth`. A `noauth` connection means no pool was resolved — check the settings row first.

---

## 5. Unpinning

To let the provider egress directly again (for example while diagnosing a tunnel):

- **Dashboard:** Providers → OpenCode → Proxy Pool → **None (direct)**. The card deletes `proxyPoolId` from `providerStrategies.opencode`.
- **API:**

  ```bash
  curl -X PATCH http://localhost:20128/api/settings \
    -H 'Content-Type: application/json' \
    -d '{"providerStrategies":{"opencode":{}}}'
  ```

- **Database:** set `settings.providerStrategies.opencode` to `{}` (id = 1).

Direct egress is legal only when no pool is configured. When a pool **is** configured but unusable, 9router fails terminally rather than silently leaking the request out over the direct IP.

---

## 6. Terminal errors and their remedies

| Error | Meaning | Remedy |
|---|---|---|
| `403` + `"...abusive traffic from this IP address..."` (rewritten body names the pool) | The egress IP is flagged. Upstream reputation block, not an account problem. | Retry with backoff (9router does this automatically, up to 3 attempts). If it persists, **rotate the proxy pool node** to a different egress IP, enable another pool in the Dashboard, or change network egress. Do not switch IPv4/IPv6 — reputation is per-IP, not per-address-family. |
| `403` + `"OpenCode's free tier can only be used from within OpenCode."` | Client fingerprint rejected. | **Do not retry.** Fix the client fingerprint (headers, `User-Agent`, `x-opencode-session`/`x-opencode-request` shape). A proxy change will not help. |
| `EGRESS_PROXY_UNAVAILABLE` — *"configured egress proxy pool "<id>" cannot carry this request"* | The pinned pool is present but unusable: no proxy URL, or the SOCKS5 liveness probe failed (`timeout` / `refused` / `malformed` / `handshake`). | The request was **not** sent over the direct IP. Repair the tunnel (is the VPSEase client running? is the upstream VLESS reachable?) or unpin the pool (§5) to allow direct egress. Run the pool's **Test** button in Dashboard → Proxy Pools to distinguish a dead tunnel from a rejected egress. |
| `403` with neither phrase (unclassified) | Some other upstream 403. | Not an egress or fingerprint block. Treat as a normal provider 403 — check quota/permissions, and consult the 9router request log for the raw upstream body. |

**Liveness ≠ clean.** The probe (`open-sse/utils/proxyHealth.js`) proves the tunnel dials; it says nothing about the egress IP's reputation. A pool can pass the probe and still be flagged upstream. That is why the egress remedy above is a *different IP*, not a *health check*.

---

## 7. Reference

| Path | Role |
|---|---|
| `scripts/seed-opencode-proxy-pool.mjs` | Idempotent seed + pin |
| `open-sse/utils/freeTierEgress.js` | Variant classifier and actionable-body rewriter |
| `open-sse/utils/proxyHealth.js` | SOCKS5 CONNECT liveness probe (30s TTL cache) |
| `open-sse/config/errorConfig.js` | Retry taxonomy — `"abusive traffic"` → backoff; fingerprint phrase → fail fast |
| `open-sse/executors/opencode.js` | Bounded egress retry (max 3 attempts, exponential backoff) |
| `src/sse/services/auth.js` | Pool selection, pinning, probe gate; rejects the direct leak |
| `src/lib/db/repos/proxyPoolsRepo.js` | Pool table API used by the seed script |
| `src/lib/db/repos/settingsRepo.js` | Transactional settings read-merge-write used by the seed script |
| `docs/socks-dns.md` | `?dns=local` transport semantics |
