/**
 * String-aware comment stripper shared by both safety scanners
 * (runSafetySelfCheck and scripts/safety-scan.mjs, which imports the built
 * version from dist/). Purpose: banned-pattern matching must ignore `//`
 * comments (naming a concept in a comment cannot execute anything) WITHOUT
 * going blind inside string literals.
 *
 * Why string-aware: the naive `line.replace(/\/\/.*$/, "")` truncates
 * `const u = "https://x/swap/v1/swap"` at the `//` of `https://`, so banned
 * URL substrings could never match on ordinary https literals (audit C1).
 * This stripper only treats `//` and `/*` as comment starts OUTSIDE
 * single/double/backtick strings (with backslash-escape handling).
 *
 * Known limitation: regex literals containing `//` (e.g. `/a\/\/b/`) are
 * NOT specially handled — a `//` inside a regex literal starts comment
 * stripping. Direction of error: code hidden → possible false NEGATIVE.
 * Mitigation: banned regexes live in denylist.ts (scan-exempt by design);
 * if a future scanned file needs `//` inside a regex literal, extract the
 * literal to a named const and note it here.
 */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  let quote: string | null = null;
  while (i < n) {
    const c: string = source[i] as string;
    if (quote !== null) {
      out += c;
      if (c === "\\") {
        if (i + 1 < n) out += source[i + 1] as string;
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") i += 1; // drop comment, keep newline
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") out += "\n"; // preserve line numbers
        i += 1;
      }
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}
