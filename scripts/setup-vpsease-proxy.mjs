import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import os from "os";

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
