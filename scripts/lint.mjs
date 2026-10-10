// Minimal project-local lint (no extra deps): forbids dangerous constructs.
// Usage: node scripts/lint.mjs (non-zero exit on violation).
// Scope: src/**/*.ts AND scripts/**/*.mjs (the recorder operator files must
// meet the same bar — audit C2). Excludes this file's own rule definitions.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = [new URL("../src", import.meta.url), new URL("../scripts", import.meta.url)];
const SELF = new URL(import.meta.url).pathname;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir.pathname ?? String(dir), entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walk(full);
    } else if (full.endsWith(".ts")) {
      yield full;
    } else if (full.endsWith(".mjs")) {
      const normalized = full.replace(/\\/g, "/");
      if (normalized.includes("/src/") || normalized.includes("/scripts/")) yield full;
    }
  }
}

// [regex, allowedFileFragments[]|null, message]
const RULES = [
  [/\beval\s*\(/, null, "eval() is forbidden"],
  [/\bnew\s+Function\s*\(/, null, "new Function() is forbidden"],
  // process.env: config reads it (validated), lifecycle passes an explicit
  // minimal subset (PATH + SOLSNIPE_*) to the detached child. Nowhere else.
  [/process\.env/, ["src/config.ts", "scripts/recorder-lifecycle.mjs"], "process.env only allowed in src/config.ts and scripts/recorder-lifecycle.mjs"],
  [/@ts-ignore/, null, "@ts-ignore is forbidden (fix the type instead)"],
  // All outbound HTTP goes through allowedFetch (audit M3). httpClient.ts
  // legitimately calls the global; tests may stub it.
  [/(?<![A-Za-z0-9_$.])fetch\s*\(/, ["src/net/httpClient.ts"], "bare fetch() forbidden — use allowedFetch from src/net/httpClient.ts"],
];

let failures = 0;
let filesLinted = 0;
for (const root of ROOTS) {
  for (const file of walk(root)) {
    if (file === SELF) continue; // rule definitions, not violations
    filesLinted += 1;
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    for (const [pattern, allowed, message] of RULES) {
      const normalized = file.replace(/\\/g, "/");
      if (allowed !== null && allowed.some((frag) => normalized.endsWith(frag))) continue;
      lines.forEach((line, i) => {
        pattern.lastIndex = 0;
        if (pattern.test(line)) {
          console.error(`LINT ${file}:${i + 1}: ${message}: ${line.trim().slice(0, 120)}`);
          failures++;
        }
      });
    }
  }
}
if (failures > 0) {
  console.error(`lint: ${failures} violation(s)`);
  process.exit(1);
}
console.log(`lint: clean (${filesLinted} files)`);
