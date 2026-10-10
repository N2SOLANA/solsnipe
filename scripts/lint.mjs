// Minimal project-local lint (no extra deps): forbids dangerous constructs.
// Usage: node scripts/lint.mjs (non-zero exit on violation).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../src", import.meta.url);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir.pathname ?? String(dir), entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (full.endsWith(".ts")) yield full;
  }
}

// [regex, allowedFileFragment|null, message]
const RULES = [
  [/\beval\s*\(/, null, "eval() is forbidden"],
  [/\bnew\s+Function\s*\(/, null, "new Function() is forbidden"],
  [/process\.env/, "src/config.ts", "process.env only allowed in src/config.ts"],
  [/@ts-ignore/, null, "@ts-ignore is forbidden (fix the type instead)"],
];

let failures = 0;
for (const file of walk(SRC)) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  for (const [pattern, allowed, message] of RULES) {
    if (allowed && file.replace(/\\/g, "/").endsWith(allowed)) continue;
    lines.forEach((line, i) => {
      if (pattern.test(line)) {
        console.error(`LINT ${file}:${i + 1}: ${message}: ${line.trim().slice(0, 120)}`);
        failures++;
      }
    });
  }
}
if (failures > 0) {
  console.error(`lint: ${failures} violation(s)`);
  process.exit(1);
}
console.log("lint: clean");
