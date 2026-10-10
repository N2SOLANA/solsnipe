import { describe, expect, it } from "vitest";
import { readFileSync, mkdtempSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, MIGRATIONS } from "../src/db/database.js";
import { runSafetySelfCheck } from "../src/safety/selfCheck.js";
import {
  DENYLIST,
  SCAN_EXEMPT_LINE_MARKER,
  SCAN_EXEMPT_PATH_SUFFIXES,
} from "../src/safety/denylist.js";

/**
 * The standalone scanner (scripts/safety-scan.mjs) and the in-code DENYLIST
 * must agree — otherwise one can pass while the other would fail. This test
 * extracts the literal patterns from the script and compares against DENYLIST.
 */
describe("safety-scan sync", () => {
  it("script patterns match DENYLIST", () => {
    const script = readFileSync(new URL("../scripts/safety-scan.mjs", import.meta.url), "utf8");
    const sourcePatterns = DENYLIST.flatMap((d) => d.sourcePatterns.map(String));
    for (const p of sourcePatterns) {
      // The script embeds equivalent literals; check each pattern's core token appears.
      const core = p.replace(/^\/\\b|\/.*$/g, "").slice(0, 12);
      expect(script, `script missing pattern core "${core}"`).toContain(core);
    }
    const urlSubs = DENYLIST.flatMap((d) => d.urlSubstrings);
    for (const sub of urlSubs) {
      expect(script, `script missing url substring "${sub}"`).toContain(sub);
    }
    const depSubs = DENYLIST.flatMap((d) => d.dependencySubstrings);
    for (const sub of depSubs) {
      expect(script, `script missing dep substring "${sub}"`).toContain(sub);
    }
  });

  it("self-check passes on own clean sources", () => {
    const result = runSafetySelfCheck(
      [{ path: "clean.ts", text: "export const x = 1;" }],
      ["zod", "decimal.js", "typescript", "vitest"],
    );
    expect(result.ok).toBe(true);
  });

  it("both scanners honor the same exemptions", () => {
    // 1. Constants referenced by selfCheck match the literals in the script.
    const script = readFileSync(new URL("../scripts/safety-scan.mjs", import.meta.url), "utf8");
    expect(script).toContain(SCAN_EXEMPT_LINE_MARKER);
    for (const suffix of SCAN_EXEMPT_PATH_SUFFIXES) {
      expect(script).toContain(suffix);
    }
    // 2. Exempt marker is USED only in logger.ts (its definition lives in
    //    denylist.ts; any other file carrying it would silently widen the hole).
    const srcDir = new URL("../src", import.meta.url).pathname;
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith(".ts")) {
          const usingLines = readFileSync(full, "utf8")
            .split("\n")
            .filter(
              (line) =>
                line.includes(SCAN_EXEMPT_LINE_MARKER) &&
                !line.includes("SCAN_EXEMPT_LINE_MARKER ="),
            );
          if (usingLines.length > 0) hits.push(full);
        }
      }
    };
    walk(srcDir);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.replace(/\\/g, "/")).toMatch(/util\/logger\.ts$/);
    // 3. Logger still scans clean AFTER its exempt lines are stripped
    //    (exemption hides only the marked lines, not the whole file).
    //    `//` comments are stripped first: naming a concept in a comment in
    //    order to redact it is defensive, not secret handling.
    const loggerText = readFileSync(
      new URL("../src/util/logger.ts", import.meta.url),
      "utf8",
    );
    expect(loggerText).toContain(SCAN_EXEMPT_LINE_MARKER);
    const stripped = loggerText
      .split("\n")
      .filter((line) => !line.includes(SCAN_EXEMPT_LINE_MARKER))
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
    const residual = DENYLIST.flatMap((d) => d.sourcePatterns).filter((p) => {
      p.lastIndex = 0;
      return p.test(stripped);
    });
    expect(residual.map(String)).toEqual([]);
  });

  it("self-check catches banned patterns", () => {
    const bad = runSafetySelfCheck(
      [{ path: "evil.ts", text: "wallet.signTransaction(tx);" }],
      ["@solana/web3.js"],
    );
    expect(bad.ok).toBe(false);
    expect(bad.checks.filter((c) => !c.ok).length).toBeGreaterThanOrEqual(2);
  });
});

describe("database migrations", () => {
  it("migrates a fresh in-memory-equivalent DB forward-only", () => {
    const dir = mkdtempSync(join(tmpdir(), "solsnipe-test-"));
    try {
      const db = openDatabase(join(dir, "test.sqlite"));
      const row = db
        .prepare("SELECT MAX(version) AS v FROM schema_version")
        .get() as { v: number };
      expect(row.v).toBe(MIGRATIONS.length);
      // Re-open: idempotent, no duplicate rows.
      db.close();
      const db2 = openDatabase(join(dir, "test.sqlite"));
      const row2 = db2
        .prepare("SELECT MAX(version) AS v FROM schema_version")
        .get() as { v: number };
      expect(row2.v).toBe(MIGRATIONS.length);
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
