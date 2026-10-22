# Phase 03 — Proxy liveness probe (hangs are the failure mode)

**Status**: ✅ Done (2026-10-22 11:42 (UTC+0700), Commit: 6886f112)
**Completed Date:** 2026-10-22 11:42 (UTC+0700)
**Duration:** ~2 days (Created records date only, no clock time — date-level precision)
**Completed in**: Commit `6886f112` — `open-sse/utils/proxyHealth.js` (NEW, ~198 LOC), `tests/unit/proxy-health-probe.test.js` (NEW)
**Reconciled 2026-10-22**: Reconciled against live disk at 11:42 (UTC+0700). Deviation: the SOCKS5 CONNECT dial was extracted into a standalone module (`probeProxyEgress` at `proxyHealth.js:179`) with its own greeting/CONNECT stages and fail-open contract, rather than reusing the TLS-entangled block at `proxyFetch.js:280-331` — the plan's "only extract if too entangled" condition was met (that block wraps TLS 6/6 through SOCKS).
**Author**: claude
**Confidence**: 97%
**Date**: 2026-10-20
**Target Files**: `open-sse/utils/proxyHealth.js`, `tests/unit/proxy-health-probe.test.js`

**Wave**: 1 | **Domain**: open-sse/utils | **Files**: 1 source + 1 test
**Depends on**: none | **Unblocks**: Phase 04

## Goal

Distinguish "sing-box up, VLESS upstream dead" (hangs forever) from "no proxy" (refuses fast), within a hard timeout.

## Files

- `open-sse/utils/proxyHealth.js` (NEW)
- `tests/unit/proxy-health-probe.test.js` (NEW)

## Background

VPSEase confirmed two distinct failure modes:
- process killed → port gone → **connection refused** (fast)
- process alive, upstream VLESS unreachable → SOCKS5 **accepts then hangs** (slow, burns the request slot)

Therefore the design must not rely on fast refusal. Probe is mandatory.

## Exports

```js
export async function probeProxyEgress(proxyUrl, { timeoutMs = 3000, targetHost } = {})
// → { ok: true } | { ok: false, reason: "timeout" | "refused" | "malformed" | "handshake" }
```

## TDD — tests written FIRST (must fail)

1. `proxyHealth: resolves ok on a successful SOCKS5 CONNECT handshake`
2. `proxyHealth: rejects with reason timeout without waiting for the upstream` (fake timer / injected socket)
3. `proxyHealth: returns reason refused on ECONNREFUSED`
4. `proxyHealth: returns reason malformed for a non-socks5 url without throwing synchronously`
5. `proxyHealth: caches a result for the TTL and collapses concurrent probes into one dial`
6. `proxyHealth: never throws — always resolves a result object` (fail-open contract)

## Implementation note

**First choice:** reuse the SOCKS5 CONNECT dial already at `open-sse/utils/proxyFetch.js:280-331`. Only extract a standalone handshake if that block is too entangled with TLS wrapping. Prefer extraction over duplication.

## Constraints

- 30s TTL single-flight cache keyed by `proxyUrl`.
- Hard timeout; the probe must never outlive `timeoutMs + small epsilon`.
- Must not perform an HTTP request — CONNECT handshake only (cheap, no upstream quota burn).
- Sockets always closed in `finally`.

## Acceptance

- Worst-case wall time ≤ `timeoutMs + 200ms`.
- One dial per TTL window under concurrency.
- Never throws.

## Verify

```bash
cd tests && npx vitest run unit/proxy-health-probe.test.js
```
