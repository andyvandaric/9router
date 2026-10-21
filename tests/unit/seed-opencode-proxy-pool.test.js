// The OpenCode free-tier egress pool exists to keep traffic OFF the direct IP:
// the upstream free tier blocks flagged egress addresses, so a request that
// silently leaves over the real address gets that address flagged too.
//
// The pool row therefore has to carry strictProxy:true. The seed script wrote
// strictProxy:false, which allowed the direct-egress replay path to fire on a
// 403 and expose the very IP the pool was meant to protect.
//
// The script resolves the database through the repo's own resolver
// (src/lib/db/paths.js → DATA_DIR), so the test points DATA_DIR at a
// throwaway directory and reads the seeded row back from the resulting
// SQLite file. The operator's live database is never touched.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "seed-opencode-proxy-pool.mjs");
const POOL_ID = "vpsease-main";

let dataDir;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-seed-test-"));
});

afterEach(() => {
  // Windows can still hold the SQLite handle for a moment after the child
  // process exits; a locked temp dir must not fail the suite.
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

function runSeed(args = []) {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATA_DIR: dataDir },
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function readPoolRow() {
  const dbPath = path.join(dataDir, "db", "data.sqlite");
  const script = `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    const row = db.prepare("SELECT id, data FROM proxyPools WHERE id = ?").get(${JSON.stringify(POOL_ID)});
    process.stdout.write(JSON.stringify(row || null));
  `;
  const out = execFileSync(process.execPath, ["-e", script, dbPath], { encoding: "utf-8" });
  const row = JSON.parse(out);
  return row ? { id: row.id, ...JSON.parse(row.data) } : null;
}

describe("seed-opencode-proxy-pool", () => {
  it("seed script writes strictProxy true for the free-tier egress pool", () => {
    runSeed();

    const pool = readPoolRow();
    expect(pool).not.toBeNull();
    expect(pool.strictProxy).toBe(true);
  });
});
