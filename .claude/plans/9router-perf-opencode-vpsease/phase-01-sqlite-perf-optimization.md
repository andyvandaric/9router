# Phase 01: SQLite DB Automated Pruning & Performance Recovery

**Document ID:** `PHASE-01-SQLITE-PERF-OPTIMIZATION`  
**Parent Master Plan:** [`.claude/plans/9router-perf-opencode-vpsease/index.md`](index.md)  
**Assigned Sub-Agent / Role:** Executor / Database Engineer  
**Status:** 🟡 APPROVED FOR EXECUTION  
**Target Files:**  
- `src/lib/db/prune.js` (Core automated retention & pruning engine)  
- `src/lib/db/driver.js` (Wire startup auto-prune hook)  
- `scripts/maintenance/prune-usage.mjs` (CLI maintenance script)  
- `%APPDATA%/9router/db/data.sqlite` (Target database)  

---

## 1. Problem Statement
The local SQLite database has grown to **319.04 MB** with **662,820 rows** in `usageHistory`. `usageDaily` already pre-aggregates historical metrics per day, so retaining hundreds of thousands of raw request records beyond 30 days provides zero value while severely degrading query speed and bloating memory (472 MB RAM).

User Requirement: **"Auto prune db history ini gw mau diterapkan dengan proper, bukan cuma manual cleaning"** (Must be automated with scheduled/startup execution, not just a one-off script).

## 2. Implementation Specifications

### Step 1: Core Pruning Engine (`src/lib/db/prune.js`)
Implement `pruneOldUsage(adapter, options)`:
1. **Configurable Retention**: Defaults to `30` days (overrideable via `RETENTION_DAYS` env var or settings).
2. **Safe Batch Deletion**:
   - Calculates cutoff timestamp: `cutoffIso = new Date(Date.now() - retentionDays * 86400000).toISOString()`.
   - Batch deletes from `usageHistory` and `requestDetails` where `timestamp < cutoffIso`.
3. **Vacuum Policy**:
   - Checks if deleted rows > 5,000 or database file size exceeds 50 MB; if so, executes `VACUUM;` to reclaim physical disk space.
4. **Non-blocking / Background Execution**:
   - Wrapped in async helper, logs clear stats (`[DB Prune] Removed X rows older than 30 days`).

### Step 2: Lifecycle Integration in `driver.js`
In `src/lib/db/driver.js` inside `initAdapter()`:
- After migrations complete, trigger `pruneOldUsage(adapter)` in the background without blocking server startup.
- Schedule a recurring daily interval (`setInterval` unref'd, 24 hours) to automatically prune stale records without needing human intervention.

### Step 3: Standalone CLI Tool (`scripts/maintenance/prune-usage.mjs`)
Create CLI script for manual/on-demand execution:
- Supports `--dry-run`, `--days <N>`, and `--vacuum`.
- Creates safety backup in `%APPDATA%/9router/db/backups/` before running.

## 3. Verification Guardrails
- Initial prune test reduces `usageHistory` from 662k to <25k rows.
- Database physical size shrinks from 319 MB to <25 MB.
- Server restart logs `[DB Prune] Auto-prune active: 30-day retention`.
- Integrity check `PRAGMA integrity_check` returns `"ok"`.
