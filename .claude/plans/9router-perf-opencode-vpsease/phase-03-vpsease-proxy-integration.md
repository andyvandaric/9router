# Phase 03: VPSEase Proxy Pool Integration & SOCKS Local-DNS Binding

**Document ID:** `PHASE-03-VPSEASE-PROXY-INTEGRATION`  
**Parent Master Plan:** [`.claude/plans/9router-perf-opencode-vpsease/index.md`](index.md)  
**Assigned Sub-Agent / Role:** Executor / Network & Security Engineer  
**Status:** 🟡 PROPOSED  
**Target Files:**  
- `scripts/setup-vpsease-proxy.mjs` (Automated helper to configure pool)  
- `%APPDATA%/9router/db/data.sqlite` (`proxyPools` and `settings` tables)  

---

## 1. Problem Statement
The local ISP/residential IP is flagged by OpenCode's Cloudflare WAF, resulting in hard `403 FreeTierError` for all free models (`oc/*`). 9Router currently has zero active proxy pools (`proxyPools: []`). By registering your VPSEase proxy (either SOCKS5 or HTTP) into 9Router and binding it to `opencode`, all free-tier requests will egress through the clean VPSEase IP.

Furthermore, following the empirical findings of PR #4987 (MarcusHO929), SOCKS5 proxies must utilize the `?dns=local` parameter to prevent Cloudflare WAF from blocking remote SOCKS domain target resolution.

## 2. Implementation Specifications

### Step 1: Proxy Pool Schema & Record Insertion
Create `scripts/setup-vpsease-proxy.mjs` to register the VPSEase proxy pool in `data.sqlite`:
- **Pool ID**: `vpsease-main`
- **Data payload**:
  ```json
  {
    "name": "VPSEase Proxy",
    "proxyUrl": "socks5://<user>:<pass>@<vpsease-host>:<port>?dns=local",
    "description": "Dedicated clean egress for OpenCode free tier and sensitive lanes",
    "strictProxy": false
  }
  ```
- **Active status**: `isActive = 1`.

### Step 2: Route OpenCode Provider Strategy to VPSEase Pool
Update `settings` table in `data.sqlite`:
- Merge `providerStrategies.opencode`:
  ```json
  {
    "proxyPoolId": "vpsease-main",
    "rotateStrategy": "round-robin"
  }
  ```

### Step 3: Verification Guardrails
- Validate proxy connection using `src/lib/network/proxyTest.js`.
- Confirm `auth.js` selects `proxy:vpsease-main` for all OpenCode calls.
