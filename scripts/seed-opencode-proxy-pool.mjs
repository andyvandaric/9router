#!/usr/bin/env node
/**
 * Seed the OpenCode Free egress proxy pool and pin it to the opencode provider.
 *
 * Why this exists: `scripts/setup-vpsease-proxy.mjs` never took effect. It
 * hardcoded `%APPDATA%/9router/db/data.sqlite` while the runtime resolves the
 * database through DATA_DIR (src/lib/dataDir.js → src/lib/db/paths.js), and it
 * wrote rotateStrategy "round-robin", which makes src/sse/services/auth.js
 * rotate the pinned pool id away across every active pool. This script resolves
 * the database the way the runtime does and pins with rotateStrategy "none".
 *
 * Usage:
 *   node scripts/seed-opencode-proxy-pool.mjs [--force]
 *
 * Environment:
 *   DATA_DIR  optional. When set, the runtime keeps its database in
 *             $DATA_DIR/db/data.sqlite. This script honours it automatically
 *             because it uses the same resolver the server uses — it never
 *             builds a database path of its own.
 *
 * Exit codes: 0 = seeded, 1 = refused (conflicting configuration) or error.
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const SRC_DIR = path.join(REPO_ROOT, "src");

// ── Seed values ──────────────────────────────────────────────────────────────
// The proxy URL is a seed value for buyer distributions, not a runtime
// constant: it must never appear under src/ or open-sse/. The port is a
// property of the VPSEase deployment (prod 20808), not of 9router.
const POOL_ID = "vpsease-main";
const POOL_NAME = "VPSEase Proxy Pool";
const PROXY_URL = "socks5://127.0.0.1:20808?dns=local";
const POOL_DESCRIPTION = "VPSEase Sing-box VLESS Egress Gateway with local DNS resolution";

// A pinned pool requires rotateStrategy "none". Any other value makes
// src/sse/services/auth.js ignore proxyPoolId and rotate across all pools.
const PROVIDER_ID = "opencode";
const ROTATE_STRATEGY = "none";

// ── Alias resolution ────────────────────────────────────────────────────────
// The repo maps "@/*" → "src/*" (jsconfig.json). Node has no such mapping, so
// register a loader hook that resolves the alias the same way the bundler does.
// Without it, importing src/lib/db/paths.js fails on its "@/lib/dataDir.js".
const ALIAS_LOADER = `
const SRC_DIR = ${JSON.stringify(SRC_DIR)};
export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith("@/")) return nextResolve(specifier, context);
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  let target = join(SRC_DIR, specifier.slice(2));
  if (!existsSync(target)) {
    if (existsSync(target + ".js")) target = target + ".js";
    else if (existsSync(join(target, "index.js"))) target = join(target, "index.js");
  }
  return { url: pathToFileURL(target).href, shortCircuit: true };
}
`;

function parseArgs(argv) {
  const args = { force: false, help: false };
  for (const arg of argv) {
    if (arg === "--force") args.force = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else {
      console.error(`Unknown argument: ${arg}`);
      console.error("Usage: node scripts/seed-opencode-proxy-pool.mjs [--force]");
      process.exit(1);
    }
  }
  return args;
}

function printUsage() {
  console.log(
    [
      "Seed the OpenCode Free egress proxy pool and pin it to the opencode provider.",
      "",
      "Usage: node scripts/seed-opencode-proxy-pool.mjs [--force]",
      "",
      "  --force  overwrite an already-configured pool that points elsewhere",
      "",
      "Environment:",
      "  DATA_DIR  when set, the runtime database lives at $DATA_DIR/db/data.sqlite",
    ].join("\n"),
  );
}

async function loadRepoModules() {
  register("data:text/javascript," + encodeURIComponent(ALIAS_LOADER));

  const paths = await import(pathToFileURL(path.join(SRC_DIR, "lib/db/paths.js")).href);
  const pools = await import(pathToFileURL(path.join(SRC_DIR, "lib/db/repos/proxyPoolsRepo.js")).href);
  const settings = await import(pathToFileURL(path.join(SRC_DIR, "lib/db/repos/settingsRepo.js")).href);

  return { dataFile: paths.DATA_FILE, pools, settings };
}

/**
 * Refuse to silently repoint an operator's existing configuration.
 * @returns {string[]} human-readable conflicts; empty means "safe to seed"
 */
function findConflicts(existingPool, existingPoolId) {
  const conflicts = [];
  if (existingPoolId && existingPoolId !== POOL_ID) {
    conflicts.push(
      `settings.providerStrategies.${PROVIDER_ID}.proxyPoolId is "${existingPoolId}" (seeding would repoint the provider to "${POOL_ID}")`,
    );
  }
  if (existingPool && existingPool.proxyUrl !== PROXY_URL) {
    conflicts.push(
      `pool "${POOL_ID}" already uses proxyUrl "${existingPool.proxyUrl}" (seeding would replace it with "${PROXY_URL}")`,
    );
  }
  return conflicts;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return 0;
  }

  const { dataFile, pools, settings } = await loadRepoModules();

  console.log("=== Seeding 9Router OpenCode egress pool ===");
  console.log("DB file:", dataFile);

  const existingPool = await pools.getProxyPoolById(POOL_ID);
  const currentSettings = await settings.getSettings();
  const existingPoolId = currentSettings.providerStrategies?.[PROVIDER_ID]?.proxyPoolId || null;

  const conflicts = findConflicts(existingPool, existingPoolId);
  if (conflicts.length > 0 && !args.force) {
    console.error("[Refused] A different pool is already configured:");
    for (const conflict of conflicts) console.error(`  - ${conflict}`);
    console.error("Re-run with --force to overwrite it.");
    return 1;
  }
  for (const conflict of conflicts) console.warn(`[Override --force] ${conflict}`);

  const poolPayload = {
    id: POOL_ID,
    name: POOL_NAME,
    proxyUrl: PROXY_URL,
    description: POOL_DESCRIPTION,
    type: "http",
    isActive: true,
    // This pool exists to keep traffic off the direct IP: the upstream free
    // tier blocks flagged egress addresses, and the direct-egress replay path
    // on a 403 would expose the very address this pool protects.
    strictProxy: true,
  };

  // createProxyPool upserts, but going through updateProxyPool on the update
  // path keeps the pool's health fields (testStatus/lastTestedAt/lastError)
  // instead of resetting them to "unknown" on every re-run.
  const action = existingPool ? "updated" : "created";
  if (existingPool) await pools.updateProxyPool(POOL_ID, poolPayload);
  else await pools.createProxyPool(poolPayload);
  console.log(`[proxyPools] ${action} pool "${POOL_ID}" → ${PROXY_URL}`);

  // updateSettings merges at the top level only, so providerStrategies is
  // rebuilt here to keep the other providers' entries intact.
  const providerStrategies = {
    ...(currentSettings.providerStrategies || {}),
    [PROVIDER_ID]: { proxyPoolId: POOL_ID, rotateStrategy: ROTATE_STRATEGY },
  };
  await settings.updateSettings({ providerStrategies });
  console.log(`[settings] providerStrategies.${PROVIDER_ID} → proxyPoolId="${POOL_ID}", rotateStrategy="${ROTATE_STRATEGY}"`);

  // Read back through the repo APIs so the printed result is observed, not assumed.
  const poolsNow = await pools.getProxyPools();
  const settingsNow = await settings.getSettings();
  const seededPool = poolsNow.find((pool) => pool.id === POOL_ID);
  const seededStrategy = settingsNow.providerStrategies?.[PROVIDER_ID];

  console.log("--- verified ---");
  console.log(`proxyPools rows with id "${POOL_ID}": ${poolsNow.filter((pool) => pool.id === POOL_ID).length}`);
  console.log(`pool proxyUrl: ${seededPool?.proxyUrl || "(missing)"}`);
  console.log(`pool isActive: ${seededPool?.isActive}`);
  console.log(`settings.providerStrategies.${PROVIDER_ID}: ${JSON.stringify(seededStrategy)}`);
  console.log("=== done ===");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("[seed-opencode-proxy-pool] failed:", error?.message || error);
    process.exit(1);
  });
