/**
 * Startup safety self-check (§2.1 items 1–4). Runs before anything else;
 * the paper engine refuses to operate if it fails. Result is logged.
 */
import { readFileSync, existsSync } from "node:fs";
import { EXECUTION_MODE, assertPaperMode } from "../safety/executionMode.js";
import {
  DENYLIST,
  NETWORK_ALLOWLIST,
  SCAN_EXEMPT_LINE_MARKER,
  SCAN_EXEMPT_PATH_SUFFIXES,
} from "../safety/denylist.js";

export interface SelfCheckResult {
  ok: boolean;
  mode: string;
  checks: { name: string; ok: boolean; detail: string }[];
}

export function runSafetySelfCheck(
  sourceFiles: { path: string; text: string }[],
  dependencyNames: string[],
): SelfCheckResult {
  const checks: SelfCheckResult["checks"] = [];

  // 1. Hardcoded paper mode.
  try {
    assertPaperMode();
    checks.push({
      name: "execution-mode",
      ok: EXECUTION_MODE === "PAPER",
      detail: `EXECUTION_MODE=${EXECUTION_MODE}`,
    });
  } catch (err) {
    checks.push({
      name: "execution-mode",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // 2. No dependency on the denylist (wallet/signing libs).
  const badDeps = dependencyNames.filter((dep) =>
    DENYLIST.some((entry) =>
      entry.dependencySubstrings.some((sub) => dep.includes(sub)),
    ),
  );
  checks.push({
    name: "no-banned-dependencies",
    ok: badDeps.length === 0,
    detail: badDeps.length === 0 ? "clean" : `banned: ${badDeps.join(",")}`,
  });

  // 3. Source scan (signing primitives, secret handling, swap endpoints).
  // Exempts the denylist definition itself and marked redaction-pattern lines.
  const sourceHits: string[] = [];
  for (const file of sourceFiles) {
    const normalized = file.path.replace(/\\/g, "/");
    if (SCAN_EXEMPT_PATH_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) {
      continue;
    }
    const scannableLines = file.text
      .split("\n")
      // Shared rule with scripts/safety-scan.mjs: exempt marked lines first
      // (marker lives in a trailing comment), then strip `//` comments.
      .filter((line) => !line.includes(SCAN_EXEMPT_LINE_MARKER))
      .map((line) => line.replace(/\/\/.*$/, ""));
    const scannable = scannableLines.join("\n");
    for (const entry of DENYLIST) {
      for (const pattern of entry.sourcePatterns) {
        pattern.lastIndex = 0;
        if (pattern.test(scannable)) {
          sourceHits.push(`${file.path}: ${entry.reason}`);
        }
      }
      for (const sub of entry.urlSubstrings) {
        if (scannable.includes(sub)) {
          sourceHits.push(`${file.path}: URL substring "${sub}" — ${entry.reason}`);
        }
      }
    }
  }
  checks.push({
    name: "no-banned-source-patterns",
    ok: sourceHits.length === 0,
    detail: sourceHits.length === 0 ? "clean" : sourceHits.join(" | "),
  });

  // 4. Allowlist non-empty and sane (all https hosts).
  const allowOk =
    NETWORK_ALLOWLIST.length > 0 &&
    NETWORK_ALLOWLIST.every((h) => /^[a-z0-9.-]+$/i.test(h));
  checks.push({
    name: "network-allowlist",
    ok: allowOk,
    detail: `hosts: ${NETWORK_ALLOWLIST.join(",")}`,
  });

  return { ok: checks.every((c) => c.ok), mode: EXECUTION_MODE, checks };
}

/** Convenience: read own package.json dep names for the manifest scan. */
export function readOwnDependencyNames(pkgPath: string): string[] {
  if (!existsSync(pkgPath)) return [];
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
}
