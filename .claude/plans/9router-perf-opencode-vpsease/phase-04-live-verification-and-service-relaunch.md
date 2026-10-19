# Phase 04: Live E2E Multi-Model Verification & Service Relaunch

**Document ID:** `PHASE-04-LIVE-VERIFICATION-AND-SERVICE-RELAUNCH`  
**Parent Master Plan:** [`.claude/plans/9router-perf-opencode-vpsease/index.md`](index.md)  
**Assigned Sub-Agent / Role:** Verifier (model: opus) / Execution Supervisor  
**Status:** 🟡 APPROVED FOR EXECUTION  
**Target Files:**  
- `tests/unit/opencode-*.test.js`  
- Live HTTP endpoints on port `20128` (`/v1/chat/completions`)  

---

## 1. Problem Statement
Before declaring the system repaired, every modified model pathway and the server process health must be empirically tested. Note: `oc/muse-spark-1.2-contributor-free` and `1.3` are confirmed **deprecated** upstream (returning 410 Gone). As instructed by the user, verification will focus on active free models: `oc/deepseek-v4.1-flash-free`, `oc/glm-5.3-flash-free`, `oc/mimo-v2.6-flash-free`, and `oc/space-bunny-free`.

## 2. Verification Protocol & Execution Steps

### Step 1: Clean Service Restart & Footprint Check
1. Stop running 9Router processes cleanly.
2. Verify port `20128` is released.
3. Start 9Router service via `install.ps1` or background node launcher.
4. Verify HTTP `200 OK` from `http://127.0.0.1:20128/api/health`.
5. Check process memory footprint (`WorkingSet64` < 200 MB, drop from 472 MB).
6. Verify automated DB pruning triggers on startup.

### Step 2: Automated Unit & Regression Tests
Run the entire suite of OpenCode and proxy tests:
```bash
cd tests
npx vitest run unit/noauth-proxy-fallback.test.js
npx vitest run unit/opencode-free-glm-thinking-format.test.js
npx vitest run unit/opencode-free-deepseek-effort.test.js
npx vitest run unit/opencode-freetier-direct-replay.test.js
npx vitest run unit/socks-proxy-dns.test.js
node __baseline__/verify-no-regression.mjs
```

### Step 3: Live End-to-End Model Invocations (Active Free Tier Models)
Using API key `sk-ab26ee5aefcc1e59-arj1sf-a68959a6`:
1. **Test `oc/deepseek-v4.1-flash-free`**:
   - Send prompt: `"Say hello in 3 words"`
   - Assert `HTTP 200 OK`
   - Assert response body has valid `choices[0].message.content`.
2. **Test `oc/glm-5.3-flash-free`**:
   - Send prompt with reasoning/thinking enabled.
   - Assert `HTTP 200 OK` (no 400 unknown field "thinking").
3. **Test `oc/mimo-v2.6-flash-free`**:
   - Send prompt.
   - Assert `HTTP 200 OK` (clean thinking alias extraction).
4. **Test `oc/space-bunny-free`**:
   - Send prompt.
   - Assert `HTTP 200 OK`.
5. **Assert Zero 403 FreeTierError across all active free models**.
