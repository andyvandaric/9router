import { parseJson } from "./helpers/jsonCol.js";

const DEFAULT_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Prune historical request usage and request details older than retentionDays.
 * Daily aggregates in usageDaily are preserved so historical analytics remain intact.
 *
 * @param {object} adapter - SQLite adapter instance
 * @param {object} options
 * @param {number} [options.retentionDays=30]
 * @param {boolean} [options.vacuum=true]
 * @returns {Promise<{prunedUsage: number, prunedDetails: number, vacuumed: boolean}>}
 */
export async function pruneOldUsage(adapter, options = {}) {
  const retentionDays = options.retentionDays || DEFAULT_RETENTION_DAYS;
  const cutoffIso = new Date(Date.now() - retentionDays * DAY_MS).toISOString();

  let prunedUsage = 0;
  let prunedDetails = 0;
  let vacuumed = false;

  try {
    const beforeUsage = adapter.get(
      "SELECT count(*) as count FROM usageHistory WHERE timestamp < ?",
      [cutoffIso]
    );
    const beforeDetails = adapter.get(
      "SELECT count(*) as count FROM requestDetails WHERE timestamp < ?",
      [cutoffIso]
    );

    if (beforeUsage?.count > 0) {
      adapter.run("DELETE FROM usageHistory WHERE timestamp < ?", [cutoffIso]);
      prunedUsage = beforeUsage.count;
    }

    if (beforeDetails?.count > 0) {
      adapter.run("DELETE FROM requestDetails WHERE timestamp < ?", [cutoffIso]);
      prunedDetails = beforeDetails.count;
    }

    if (options.vacuum !== false && (prunedUsage > 5000 || prunedDetails > 500)) {
      try {
        adapter.run("VACUUM");
        vacuumed = true;
      } catch (err) {
        console.warn("[DB Prune] VACUUM skipped or failed:", err.message);
      }
    }

    if (prunedUsage > 0 || prunedDetails > 0) {
      console.log(
        `[DB Prune] Removed ${prunedUsage} usage records and ${prunedDetails} request details older than ${retentionDays}d (vacuum: ${vacuumed})`
      );
    }
  } catch (err) {
    console.error("[DB Prune] Error during usage pruning:", err);
  }

  return { prunedUsage, prunedDetails, vacuumed };
}

/**
 * Schedule recurring automatic retention pruning in the background.
 * Runs once after a short initial delay upon server startup, then repeats daily.
 *
 * @param {object} adapter - SQLite adapter instance
 * @param {number} [intervalMs=86400000] - 24 hours
 */
export function scheduleAutoPrune(adapter, intervalMs = 24 * 60 * 60 * 1000) {
  // Run initial background prune 5 seconds after startup so it doesn't block boot
  const initialTimer = setTimeout(() => {
    pruneOldUsage(adapter).catch((err) => {
      console.warn("[DB Prune] Initial background prune failed:", err.message);
    });
  }, 5000);
  initialTimer.unref?.();

  // Recurring 24-hour interval
  const recurringTimer = setInterval(() => {
    pruneOldUsage(adapter).catch((err) => {
      console.warn("[DB Prune] Periodic background prune failed:", err.message);
    });
  }, intervalMs);
  recurringTimer.unref?.();

  console.log(`[DB Prune] Auto-prune active: ${DEFAULT_RETENTION_DAYS}-day retention, interval: ${Math.round(intervalMs / 3600000)}h`);
}
