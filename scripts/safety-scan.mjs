// Static paper-only safety scan (§2.1 item 3). Part of `npm run verify`.
// Scans src/ and package.json for banned signing/sending/wallet/secret
// patterns and swap-endpoint URLs. Non-zero exit on ANY match.
//
// NOTE: patterns mirror src/safety/denylist.ts (incl. exemptions:
// safety/denylist.ts itself + lines with the marker below). A vitest sync
// test ("safety-scan sync" suite in tests/db.test.ts) fails if the two
// drift apart — update both.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const EXEMPT_LINE_MARKER = "safety-scan-exempt(redaction)";
const EXEMPT_BLOCK_START = "scan-exempt-block: pattern definitions (start)";
const EXEMPT_BLOCK_END = "scan-exempt-block: pattern definitions (end)";
// Files allowed to carry exempt definition blocks (sync test enforces).
const EXEMPT_BLOCK_FILES = ["safety/denylist.ts", "scripts/safety-scan.mjs"];

const ROOT = new URL("..", import.meta.url);

function* walkScanned(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(String(dir), entry);
    if (statSync(full).isDirectory()) {
      yield* walkScanned(full);
    } else if (full.endsWith(".ts")) {
      yield full;
    } else if (full.endsWith(".mjs")) {
      // Recorder lifecycle / e2e operator files must meet the same boundary.
      // Only files under src/ and scripts/ are scanned (audit C2).
      const normalized = full.replace(/\\/g, "/");
      if (normalized.includes("/src/") || normalized.includes("/scripts/")) yield full;
    }
  }
}

/**
 * String-aware comment stripper. MUST stay equivalent to
 * src/safety/stripComments.ts (pinned by tests/db.test.ts): `//` inside
 * string literals (e.g. "https://...") is NOT a comment — naive
 * line.replace(/\/\/.*$/,"") blinds banned-URL matching (audit C1).
 */
function stripComments(source) {
  let out = "";
  let i = 0;
  const n = source.length;
  let quote = null;
  while (i < n) {
    const c = source[i];
    if (quote !== null) {
      out += c;
      if (c === "\\") {
        if (i + 1 < n) out += source[i + 1];
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
      while (i < n && source[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") out += "\n";
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

// scan-exempt-block: pattern definitions (start)
const SOURCE_PATTERNS = [
  /\bsignTransaction\b/,
  /\bsignAllTransactions\b/,
  /\bsignAndSendTransaction\b/,
  /\bsendTransaction\b/,
  /\bsendRawTransaction\b/,
  /\bsendAndConfirmTransaction\b/,
  /\bKeypair\b/,
  /\bfromSecretKey\b/,
  /\bmnemonicToSeed\b/,
  /\bgenerateMnemonic\b/,
  /\bseed\s*phrase\b/i,
  /\bmnemonic\b/i,
  /\bprivate\s*key\b/i,
  /\bsecret\s*key\b/i,
];

const URL_SUBSTRINGS = [
  "/swap/v1/swap",
  "/swap/v1/build",
  "quoteResponseToSwapInstruction",
  "sendTransaction",
  "sendRawTransaction",
];

const BANNED_DEP_SUBSTRINGS = [
  "@solana/web3.js",
  "@solana/wallet-adapter",
  "@solana/wallet-adapter-base",
  "bs58",
  "bip39",
  "ed25519-hd-key",
];
// scan-exempt-block: pattern definitions (end)

let failures = 0;
let filesScanned = 0;
const scanRoots = [new URL("../src", import.meta.url), new URL("../scripts", import.meta.url)];
for (const root of scanRoots) {
  if (!existsSync(root)) continue;
  for (const file of walkScanned(root.pathname)) {
    const normalized = file.replace(/\\/g, "/");
    filesScanned += 1;
    const text = readFileSync(file, "utf8");
    // Shared rule with runSafetySelfCheck (see toScannableText): exempt
    // marked lines, drop marked definition blocks (only in allowlisted
    // files), then strip comments string-aware.
    const blockAllowed = EXEMPT_BLOCK_FILES.some((s) => normalized.endsWith(s));
    const kept = [];
    let inBlock = false;
    for (const line of text.split("\n")) {
      if (blockAllowed && line.includes(EXEMPT_BLOCK_START)) {
        inBlock = true;
        continue;
      }
      if (inBlock) {
        if (line.includes(EXEMPT_BLOCK_END)) inBlock = false;
        continue;
      }
      if (line.includes(EXEMPT_LINE_MARKER)) continue;
      kept.push(line);
    }
    const scannable = stripComments(kept.join("\n"));
    for (const pattern of SOURCE_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(scannable)) {
        console.error(`SAFETY-SCAN FAIL ${file}: matches ${pattern}`);
        failures++;
      }
    }
    for (const sub of URL_SUBSTRINGS) {
      if (scannable.includes(sub)) {
        console.error(`SAFETY-SCAN FAIL ${file}: URL substring "${sub}"`);
        failures++;
      }
    }
  }
}

const pkgPath = new URL("../package.json", import.meta.url);
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const deps = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
for (const dep of deps) {
  for (const sub of BANNED_DEP_SUBSTRINGS) {
    if (dep.includes(sub)) {
      console.error(`SAFETY-SCAN FAIL package.json: banned dependency "${dep}"`);
      failures++;
    }
  }
}

if (failures > 0) {
  console.error(`safety-scan: ${failures} violation(s) — PAPER-ONLY boundary breached`);
  process.exit(1);
}
console.log(`safety-scan: clean (${filesScanned} files, ${deps.length} deps checked)`);
