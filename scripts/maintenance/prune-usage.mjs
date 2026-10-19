import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import os from "os";

const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const dbPath = path.join(appData, "9router", "db", "data.sqlite");
const backupsDir = path.join(appData, "9router", "db", "backups");

console.log("=== 9Router SQLite Database Maintenance ===");
console.log("Target Database:", dbPath);

if (!fs.existsSync(dbPath)) {
  console.error("Database not found at:", dbPath);
  process.exit(1);
}

// 1. Initial metrics
const initialStats = fs.statSync(dbPath);
const initialSizeMb = (initialStats.size / 1024 / 1024).toFixed(2);
console.log(`Initial Size: ${initialSizeMb} MB`);

const db = new Database(dbPath);

const beforeUsage = db.prepare("SELECT count(*) as count FROM usageHistory").get().count;
const beforeDetails = db.prepare("SELECT count(*) as count FROM requestDetails").get().count;
console.log(`Initial Rows -> usageHistory: ${beforeUsage}, requestDetails: ${beforeDetails}`);

// 2. Retention Cutoff (30 days)
const RETENTION_DAYS = 30;
const cutoffIso = new Date(Date.now() - RETENTION_DAYS * 24 * 3600 * 1000).toISOString();
console.log(`Pruning records older than: ${cutoffIso} (Retention: ${RETENTION_DAYS} days)...`);

// 3. Delete old records
const pruneUsageStmt = db.prepare("DELETE FROM usageHistory WHERE timestamp < ?");
const usageResult = pruneUsageStmt.run(cutoffIso);
console.log(`Deleted ${usageResult.changes} rows from usageHistory.`);

const pruneDetailsStmt = db.prepare("DELETE FROM requestDetails WHERE timestamp < ?");
const detailsResult = pruneDetailsStmt.run(cutoffIso);
console.log(`Deleted ${detailsResult.changes} rows from requestDetails.`);

// 4. Vacuum and optimize
console.log("Running VACUUM to reclaim physical disk space and rebuild indexes...");
db.exec("VACUUM;");
db.exec("PRAGMA optimize;");

// 5. Verification check
const integrity = db.prepare("PRAGMA integrity_check").get();
console.log("Integrity Check:", integrity.integrity_check);

const afterUsage = db.prepare("SELECT count(*) as count FROM usageHistory").get().count;
const afterDetails = db.prepare("SELECT count(*) as count FROM requestDetails").get().count;
db.close();

const finalStats = fs.statSync(dbPath);
const finalSizeMb = (finalStats.size / 1024 / 1024).toFixed(2);

console.log("=== Maintenance Complete ===");
console.log(`Remaining Rows -> usageHistory: ${afterUsage}, requestDetails: ${afterDetails}`);
console.log(`Final File Size: ${finalSizeMb} MB (Shrunk from ${initialSizeMb} MB)`);
