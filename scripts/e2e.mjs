// End-to-end vertical-slice script (§24.1). M1 skeleton: runs the startup
// safety self-check and DB migration smoke test. Later milestones extend this
// file through the full slice (data → scan → risk → order → close →
// reconcile → restart → dedupe → dashboard==DB). It must NEVER pass vacuously:
// every stage asserts real state and throws on failure.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { runSafetySelfCheck, readOwnDependencyNames } from "../dist/safety/selfCheck.js";
import { openDatabase, MIGRATIONS } from "../dist/db/database.js";
import { SNAPSHOT_MIGRATIONS } from "../dist/db/snapshots.js";
import { logger } from "../dist/util/logger.js";

// Mirror of the safety-scan walker: src/**/*.ts plus scripts/**/*.mjs.
// If this drifts from scripts/safety-scan.mjs, tests/db.test.ts fails.
function* walkScanned(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(String(dir), entry);
    if (statSync(full).isDirectory()) {
      yield* walkScanned(full);
    } else if (full.endsWith(".ts")) {
      yield full;
    } else if (full.endsWith(".mjs")) {
      const normalized = full.replace(/\\/g, "/");
      if (normalized.includes("/src/") || normalized.includes("/scripts/")) yield full;
    }
  }
}

async function main() {
  logger.info("e2e_start", { mode: "PAPER" });

  // Stage 1: safety self-check over real sources (src + scripts).
  const sources = [];
  for (const root of [new URL("../src", import.meta.url), new URL("../scripts", import.meta.url)]) {
    for (const path of walkScanned(root.pathname)) {
      sources.push({ path, text: readFileSync(path, "utf8") });
    }
  }
  const deps = readOwnDependencyNames(new URL("../package.json", import.meta.url).pathname);
  const check = runSafetySelfCheck(sources, deps);
  logger.info("e2e_self_check", { ok: check.ok, checks: check.checks });
  if (!check.ok) throw new Error("E2E FAIL: safety self-check failed");

  // Stage 2: migrate scratch DBs from empty (M1 smoke; full app flow in M4).
  // Both migration sets: wrong-set wiring (audit m5) fails here, not in prod.
  const { rmSync } = await import("node:fs");
  for (const [suffix, migrations] of [[".e2e-smoke.sqlite", MIGRATIONS], [".e2e-snap.sqlite", SNAPSHOT_MIGRATIONS]]) {
    const dbPath = new URL(`../data/${suffix}`, import.meta.url).pathname;
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    const db = openDatabase(dbPath, migrations);
    const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get();
    if (row == null || typeof row.v !== "number" || row.v < migrations.length) {
      throw new Error(`E2E FAIL: migrations did not apply for ${suffix}`);
    }
    db.close();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  }

  logger.info("e2e_pass", { stages: ["self-check", "migrate-smoke"] });
  console.log("e2e: PASS (M1 skeleton: self-check + migrate smoke; full slice in M4)");
}

main().catch((err) => {
  console.error(`e2e: FAIL — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
