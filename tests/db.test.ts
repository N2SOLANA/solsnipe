import { describe, expect, it } from "vitest";
import { readFileSync, mkdtempSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, MIGRATIONS } from "../src/db/database.js";
import { runSafetySelfCheck } from "../src/safety/selfCheck.js";
import {
  DENYLIST,
  SCAN_EXEMPT_BLOCK_END,
  SCAN_EXEMPT_BLOCK_START,
  SCAN_EXEMPT_LINE_MARKER,
  SCAN_EXEMPT_PATH_SUFFIXES,
} from "../src/safety/denylist.js";
import { toScannableText } from "../src/safety/selfCheck.js";

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
    expect(script).toContain(SCAN_EXEMPT_BLOCK_START);
    expect(script).toContain(SCAN_EXEMPT_BLOCK_END);
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
    // 3. Exempt definition blocks appear ONLY in allowlisted files, are
    //    balanced, and everything outside them still scans clean. A stray
    //    block marker in any other file would silently widen the hole.
    const roots = [
      new URL("../src", import.meta.url).pathname,
      new URL("../scripts", import.meta.url).pathname,
    ];
    const blockUsers: string[] = [];
    const walkAll = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walkAll(full);
        else if (full.endsWith(".ts") || full.endsWith(".mjs")) {
          const text = readFileSync(full, "utf8");
          if (text.includes(SCAN_EXEMPT_BLOCK_START) || text.includes(SCAN_EXEMPT_BLOCK_END)) {
            blockUsers.push(full);
          }
        }
      }
    };
    for (const r of roots) walkAll(r);
    expect(blockUsers.map((f) => f.replace(/\\/g, "/").split("/").slice(-2).join("/")).sort()).toEqual(
      ["safety/denylist.ts", "scripts/safety-scan.mjs"].sort(),
    );
    // Balanced: scanner state machine must terminate outside a block.
    // Count `//`-comment markers only — the constant DEFINITIONS quote the
    // same strings and must not self-count.
    for (const full of blockUsers) {
      const text = readFileSync(full, "utf8");
      const commentMarkers = text
        .split("\n")
        .filter((l) => l.trimStart().startsWith("//"));
      const starts = commentMarkers.filter((l) => l.includes(SCAN_EXEMPT_BLOCK_START)).length;
      const ends = commentMarkers.filter((l) => l.includes(SCAN_EXEMPT_BLOCK_END)).length;
      expect({ file: full, starts, ends }).toEqual({ file: full, starts: 1, ends: 1 });
      expect(text.indexOf(SCAN_EXEMPT_BLOCK_START)).toBeLessThan(
        text.indexOf(SCAN_EXEMPT_BLOCK_END),
      );
      // Outside the block, the file itself must scan clean via the REAL
      // shared path — guards against live code hiding beside definitions.
      const scannable = toScannableText(full, text);
      const residual = DENYLIST.flatMap((d) => d.sourcePatterns).filter((p) => {
        p.lastIndex = 0;
        return p.test(scannable);
      });
      expect(residual.map(String)).toEqual([]);
      for (const sub of DENYLIST.flatMap((d) => d.urlSubstrings)) {
        expect(scannable).not.toContain(sub);
      }
    }
  });

  it("self-check catches banned patterns", () => {
    const bad = runSafetySelfCheck(
      [{ path: "evil.ts", text: "wallet.signTransaction(tx);" }],
      ["@solana/web3.js"],
    );
    expect(bad.ok).toBe(false);
    expect(bad.checks.filter((c) => !c.ok).length).toBeGreaterThanOrEqual(2);
  });

  it("self-check flags https swap URLs inside string literals (audit C1)", () => {
    // Regression: naive `//`-stripping truncated "https://..." at the `//`
    // of the scheme, blinding banned-URL matching. Both directions:
    const planted = 'const u = "https://lite-api.jup.ag/swap/v1/swap?x=1";';
    const bad = runSafetySelfCheck([{ path: "planted.ts", text: planted }], []);
    expect(bad.ok).toBe(false);
    expect(
      bad.checks.find((c) => c.name === "no-banned-source-patterns")?.detail,
    ).toContain("/swap/v1/swap");
    const commentOnly = [
      "// see https://lite-api.jup.ag/swap/v1/swap for docs (comment, no code)",
      "export const x = 1;",
    ].join("\n");
    const clean = runSafetySelfCheck([{ path: "comment.ts", text: commentOnly }], []);
    expect(clean.ok).toBe(true);
  });

  it("self-check stripComments behaves like scripts/safety-scan.mjs copy", async () => {
    // The .mjs copy can't import TS, so equivalence is behavioral, not
    // textual: both implementations must agree on tricky inputs, especially
    // https:// literals (audit C1) and comment/string edge cases.
    const { stripComments } = await import("../src/safety/stripComments.js");
    const script = readFileSync(new URL("../scripts/safety-scan.mjs", import.meta.url), "utf8");
    const start = script.search(/function\s+stripComments\s*\(/);
    if (start < 0) throw new Error("stripComments not found in safety-scan.mjs");
    let depth = 0;
    let i = script.indexOf("{", start);
    const bodyStart = i;
    for (; i < script.length; i++) {
      if (script[i] === "{") depth++;
      else if (script[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    const params = script.slice(script.indexOf("(", start) + 1, script.indexOf(")", start));
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const mjsStrip = new Function(params, script.slice(bodyStart + 1, i)) as (
      s: string,
    ) => string;
    const cases = [
      'const u = "https://lite-api.jup.ag/swap/v1/swap?x=1"; // trailing',
      "// full-line comment https://x.example.com/swap/v1/build",
      "const a = '// not a comment'; const b = \"/* nor this */\";",
      "const t = `backtick // kept`;",
      "const e = \"escaped \\\" // kept\";",
      "code(); /* block\nmultiline */ more();",
      "https://bare-url-in-code.example/a",
      "const r = /regex\\/with\\/slashes/; // after regex",
    ];
    for (const input of cases) {
      expect(mjsStrip(input), `mjs/ts diverge on: ${input.slice(0, 60)}`).toBe(
        stripComments(input),
      );
    }
    // And the critical security property directly on both:
    expect(stripComments('const u = "https://h/swap/v1/swap";')).toContain("/swap/v1/swap");
    expect(mjsStrip('const u = "https://h/swap/v1/swap";')).toContain("/swap/v1/swap");
  });

  it("safety-scan covers scripts/*.mjs operator files (audit C2)", () => {
    const script = readFileSync(new URL("../scripts/safety-scan.mjs", import.meta.url), "utf8");
    expect(script).toContain("../scripts");
    expect(script).toContain(".mjs");
    // And the e2e self-check walker mirrors it.
    const e2e = readFileSync(new URL("../scripts/e2e.mjs", import.meta.url), "utf8");
    expect(e2e).toContain("../scripts");
    expect(e2e).toContain(".mjs");
  });
});

describe("database migrations", () => {
  it("migrates a fresh in-memory-equivalent DB forward-only", () => {
    const dir = mkdtempSync(join(tmpdir(), "solsnipe-test-"));
    try {
      const db = openDatabase(join(dir, "test.sqlite"), MIGRATIONS);
      const row = db
        .prepare("SELECT MAX(version) AS v FROM schema_version")
        .get() as { v: number };
      expect(row.v).toBe(MIGRATIONS.length);
      // Re-open: idempotent, no duplicate rows.
      db.close();
      const db2 = openDatabase(join(dir, "test.sqlite"), MIGRATIONS);
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
