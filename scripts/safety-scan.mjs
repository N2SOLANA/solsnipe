// Static paper-only safety scan (§2.1 item 3). Part of `npm run verify`.
// Scans src/ and package.json for banned signing/sending/wallet/secret
// patterns and swap-endpoint URLs. Non-zero exit on ANY match.
//
// NOTE: patterns mirror src/safety/denylist.ts (incl. exemptions:
// safety/denylist.ts itself + lines with the marker below). A vitest sync
// test (tests/safety-scan-sync.test.ts) fails if the two drift apart —
// update both.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const EXEMPT_PATH_SUFFIX = "safety/denylist.ts";
const EXEMPT_LINE_MARKER = "safety-scan-exempt(redaction)";

const ROOT = new URL("..", import.meta.url);

function* walkTs(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(String(dir), entry);
    if (statSync(full).isDirectory()) yield* walkTs(full);
    else if (full.endsWith(".ts")) yield full;
  }
}

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

let failures = 0;
const srcDir = new URL("../src", import.meta.url);
if (existsSync(srcDir)) {
  for (const file of walkTs(srcDir.pathname)) {
    const normalized = file.replace(/\\/g, "/");
    if (normalized.endsWith(EXEMPT_PATH_SUFFIX)) continue; // pattern definitions, not call sites
    const text = readFileSync(file, "utf8");
    // Shared rule with runSafetySelfCheck: exempt marked redaction-pattern
    // lines FIRST (the marker lives in a trailing comment), then strip the
    // remaining `//` comments (they cannot execute anything).
    const scannable = text
      .split("\n")
      .filter((line) => !line.includes(EXEMPT_LINE_MARKER))
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
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
console.log(`safety-scan: clean (${deps.length} deps checked)`);
