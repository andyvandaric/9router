// DEPRECATED (2026-10-22): Superseded by scripts/seed-opencode-proxy-pool.mjs.
// Retired for two defects (verified against scripts/seed-opencode-proxy-pool.mjs):
//   1. This script wrote `strictProxy: false`, which re-opens the direct-egress
//      leak that commit a14ff01b closed — a 403 free-tier rejection would be
//      replayed on the host's direct IP.
//   2. This script wrote `rotateStrategy: "round-robin"`, discarding the pool pin
//      and rotating across ALL active pools.
// It also hardcoded %APPDATA%/9router/db/data.sqlite instead of resolving DATA_DIR.
// See docs/opencode-freetier-egress.md. The old body below is preserved for the
// historical record (CHANGELOG.md references this file) but is unreachable.
process.stderr.write(
  [
    "ERROR: scripts/setup-vpsease-proxy.mjs is DEPRECATED and refuses to run.",
    "",
    "Reasons this script is retired:",
    "  1. It would write `strictProxy: false`, re-opening the direct-egress leak",
    "     that commit a14ff01b closed (403 free-tier rejections replayed on the",
    "     host's direct IP).",
    "  2. It would write `rotateStrategy: \"round-robin\"`, discarding the pool pin",
    "     and rotating across ALL active pools.",
    "",
    "Use the replacement script instead (resolves DATA_DIR, writes",
    "strictProxy:true, pins rotateStrategy:\"none\", idempotent):",
    "",
    "  node scripts/seed-opencode-proxy-pool.mjs",
    "",
  ].join("\n") + "\n"
);
process.exit(1);

/* eslint-disable no-unreachable */
import path from "path";
import os from "os";

// better-sqlite3 is an optional dependency and may be absent. Static import
// declarations are hoisted and evaluated before the deprecation guard above
// can run, so resolve it lazily here, inside the unreachable legacy body.
const Database = (await import("better-sqlite3")).default;

// Script to bind VPSEase local proxy tunnel to 9Router Proxy Pools
const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const dbPath = path.join(appData, "9router", "db", "data.sqlite");

console.log("=== Setting up VPSEase Proxy Pool in 9Router ===");
console.log("DB Path:", dbPath);

const db = new Database(dbPath);

// Target VPSEase mixed inbound: SOCKS5 with ?dns=local (PR #4987 transport fix)
const POOL_ID = "vpsease-main";
const PROXY_URL = "socks5://127.0.0.1:20808?dns=local";

const poolPayload = {
  name: "VPSEase Proxy Pool",
  proxyUrl: PROXY_URL,
  description: "VPSEase Sing-box VLESS Egress Gateway with local DNS resolution",
  strictProxy: false
};

const now = new Date().toISOString();

// 1. Upsert to proxyPools
const upsertPool = db.prepare(`
  INSERT INTO proxyPools (id, isActive, testStatus, data, createdAt, updatedAt)
  VALUES (?, 1, 'active', ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    isActive = 1,
    testStatus = 'active',
    data = excluded.data,
    updatedAt = excluded.updatedAt
`);

upsertPool.run(POOL_ID, JSON.stringify(poolPayload), now, now);
console.log(`[ProxyPool] Upserted pool '${POOL_ID}' with URL: ${PROXY_URL}`);

// 2. Bind OpenCode Provider Strategy to use this pool in settings (id=1)
const settingsRow = db.prepare("SELECT data FROM settings WHERE id = 1").get();
let settings = {};
if (settingsRow && settingsRow.data) {
  try {
    settings = JSON.parse(settingsRow.data);
  } catch {}
}

if (!settings.providerStrategies) settings.providerStrategies = {};
settings.providerStrategies.opencode = {
  proxyPoolId: POOL_ID,
  rotateStrategy: "round-robin"
};

const updateSettings = db.prepare(`
  INSERT INTO settings (id, data)
  VALUES (1, ?)
  ON CONFLICT(id) DO UPDATE SET
    data = excluded.data
`);

updateSettings.run(JSON.stringify(settings));
console.log("[Settings] Bound providerStrategies.opencode -> proxyPoolId: vpsease-main");

db.close();
console.log("=== VPSEase Proxy Registration Complete ===");
