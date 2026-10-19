# Phase 02: Selective Merge of anojndr/9router Critical Patches

**Document ID:** `PHASE-02-ANOJNDR-PATCHES-SELECTIVE-MERGE`  
**Parent Master Plan:** [`.claude/plans/9router-perf-opencode-vpsease/index.md`](index.md)  
**Assigned Sub-Agent / Role:** Executor / Core Systems Engineer  
**Status:** ✅ COMPLETED  
**Target Files:**  
- `src/sse/services/auth.js`  
- `open-sse/providers/models/helpers.js`  
- `open-sse/providers/capabilities.js`  
- `open-sse/providers/thinkingLevels.js`  
- `open-sse/translator/concerns/thinkingUnified.js`  
- `open-sse/executors/opencode.js`  
- `open-sse/transformer/streamToJsonConverter.js`  
- `tests/unit/noauth-proxy-fallback.test.js`  
- `tests/unit/opencode-free-glm-thinking-format.test.js`  
- `tests/unit/opencode-free-deepseek-effort.test.js`  

---

## 1. Problem Statement
The local fork has already adopted upstream v0.5.108 fingerprint contracts and PR #4988 direct replay, but lacks 4 vital patches authored by `anojndr` that prevent OpenCode free tier failures:
1. `FREE_PROVIDERS` (noauth) cannot rotate proxies or fail over when a proxy errors (PR #4998).
2. `oc/glm-5.3-flash-free` breaks with 400 unknown field "thinking" (PR #5003).
3. `oc/deepseek-v4.1-flash-free` reasoning effort `low` collapses to `high` (PR #4984).
4. Claude Code adaptive thinking (`effort: "auto"`) causes 400 unknown variant auto, and `response.incomplete` hangs (PR #4922).

## 2. Implementation Specifications

### Patch A: PR #4998 (No-Auth Proxy Pool Failover)
- In `src/sse/services/auth.js`:
  - When assigning proxy pool to `noauth` provider, generate connection ID as `proxy:${pickedId}` instead of plain `"noauth"`.
  - In `markAccountUnavailable()`, if `connectionId.startsWith("proxy:")`, invoke `checkFallbackError()` to set cooldown and permit rotation to the next pool proxy.
- In `open-sse/providers/models/helpers.js`:
  - Ensure regex matches `deepseek-v4.1-flash-free` in `OPENCODE_FAMILIES`.

### Patch B: PR #5003 (GLM-5.3-Flash-Free OpenAI Wire Override)
- In `open-sse/providers/capabilities.js`:
  - Add explicit entry for `"glm-5.3-flash-free"` with `thinkingFormat: "openai"`, preventing the default wildcard from applying `"zai"` format.

### Patch C: PR #4984 (DeepSeek-v4.1-Flash-Free Verbatim Effort Levels)
- In `open-sse/providers/thinkingLevels.js`:
  - Set levels for `deepseek-v4.1-flash` to `["low", "high", "max"]`.
- In `open-sse/translator/concerns/thinkingUnified.js`:
  - Preserve `low` effort verbatim without mapping it to `high`.

### Patch D: PR #4922 (Drop Adaptive "auto" Effort & Handle Incomplete)
- In `open-sse/executors/opencode.js`:
  - If `body.reasoning.effort === "auto"`, delete `body.reasoning.effort` so upstream uses default instead of throwing 400.
- In `open-sse/transformer/streamToJsonConverter.js`:
  - Intercept `response.incomplete` and finalize the response stream with proper token usage.

## 3. Verification Guardrails
- Run `npx vitest run unit/noauth-proxy-fallback.test.js`
- Run `npx vitest run unit/opencode-free-glm-thinking-format.test.js`
- Run `npx vitest run unit/opencode-free-deepseek-effort.test.js`
- Run full suite regression baseline check: `node tests/__baseline__/verify-no-regression.mjs`.
