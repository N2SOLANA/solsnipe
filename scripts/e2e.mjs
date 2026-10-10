// End-to-end vertical-slice script (§24.1). M1 skeleton: runs the startup
// safety self-check and DB migration smoke test. Later milestones extend this
// file through the full slice (data → scan → risk → order → close →
// reconcile → restart → dedupe → dashboard==DB). It must NEVER pass vacuously:
// every stage asserts real state and throws on failure.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { runSafetySelfCheck, readOwnDependencyNames } from "../dist/safety/selfCheck.js";
import { openDatabase } from "../dist/db/database.js";
import { logger } from "../dist/util/logger.js";

function* walkTs(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(String(dir), entry);
    if (statSync(full).isDirectory()) yield* walkTs(full);
    else if (full.endsWith(".ts")) yield full;
  }
}

async function main() {
  logger.info("e2e_start", { mode: "PAPER" });

  // Stage 1: safety self-check over real sources.
  const srcDir = new URL("../src", import.meta.url);
  const sources = [...walkTs(srcDir.pathname)].map((path) => ({
    path,
    text: readFileSync(path, "utf8"),
  }));
  const deps = readOwnDependencyNames(new URL("../package.json", import.meta.url).pathname);
  const check = runSafetySelfCheck(sources, deps);
  logger.info("e2e_self_check", { ok: check.ok, checks: check.checks });
  if (!check.ok) throw new Error("E2E FAIL: safety self-check failed");

  // Stage 2: migrate a scratch DB from empty (M1 smoke; full app flow in M4).
  const dbPath = new URL("../data/.e2e-smoke.sqlite", import.meta.url).pathname;
  const { rmSync } = await import("node:fs");
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  const db = openDatabase(dbPath);
  const row = db.prepare("SELECT version AS v FROM schema_version ORDER BY version DESC LIMIT 1").get();
  if (row == null || typeof row.v !== "number" || row.v < 1) {
    throw new Error("E2E FAIL: migrations did not apply");
  }
  db.close();
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });

  logger.info("e2e_pass", { stages: ["self-check", "migrate-smoke"] });
  console.log("e2e: PASS (M1 skeleton: self-check + migrate smoke; full slice in M4)");
}

main().catch((err) => {
  console.error(`e2e: FAIL — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
