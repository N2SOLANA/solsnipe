/**
 * Static safety-scan denylist (§2.1 item 3).
 *
 * Each entry is a pattern that must NEVER appear in `src/` or `package.json`
 * dependencies. The scanner (`scripts/safety-scan.mjs`) fails `npm run verify`
 * on any match. One file, comments explain each entry.
 *
 * Categories:
 *  - signing/sending primitives: any live-transaction capability
 *  - wallet libraries: key custody has no place in a paper-only release
 *  - seed/mnemonic handling: secrets we must never touch (§2)
 *  - swap/tx-building endpoints: read-only quotes allowed; building or
 *    submitting transactions is forbidden (§2, §12)
 */

export interface DenyEntry {
  /** Human-readable reason, shown on scan failure. */
  reason: string;
  /** Regexes matched against file text (source scan). */
  sourcePatterns: RegExp[];
  /** Substrings matched against dependency names (manifest scan). */
  dependencySubstrings: string[];
  /** URL substrings matched against string literals (endpoint scan). */
  urlSubstrings: string[];
}

export const DENYLIST: DenyEntry[] = [
  // scan-exempt-block: pattern definitions (start)
  {
    reason:
      "Transaction signing primitive — would enable real transaction submission (§2).",
    sourcePatterns: [
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
    ],
    dependencySubstrings: [
      "@solana/web3.js", // provides Keypair/sendTransaction — banned in v1 per §2.1.2
      "@solana/wallet-adapter",
      "@solana/wallet-adapter-base",
      "bs58", // commonly paired with secret-key handling; no legit v1 use
      "bip39", // mnemonic handling — we must never touch seed phrases (§2)
      "ed25519-hd-key",
    ],
    urlSubstrings: [],
  },
  {
    reason:
      "Swap or transaction-building endpoint — read-only quotes only (§2, §12).",
    sourcePatterns: [],
    dependencySubstrings: [],
    urlSubstrings: [
      // Aggregator swap/tx-build paths (Jupiter shown as example; any match fails).
      "/swap/v1/swap",
      "/swap/v1/build",
      "quoteResponseToSwapInstruction",
      // Generic tx-submission RPC methods outside plain reads.
      "sendTransaction",
      "sendRawTransaction",
    ],
  },
  {
    reason:
      "Seed-phrase / private-key handling — never request or store wallet secrets (§2).",
    sourcePatterns: [
      /\bseed\s*phrase\b/i,
      /\bmnemonic\b/i,
      /\bprivate\s*key\b/i,
      /\bsecret\s*key\b/i,
    ],
    dependencySubstrings: [],
    urlSubstrings: [],
  },
  // scan-exempt-block: pattern definitions (end)
];

/** Hosts that outbound HTTP is allowed to reach. Everything else is rejected. */
export const NETWORK_ALLOWLIST: readonly string[] = [
  "api.dexscreener.com", // primary market data (§5.3)
  "api.mainnet-beta.solana.com", // read-only Solana JSON-RPC (§12)
  "lite-api.jup.ag", // read-only quote candidate (§12.3, docs TBD)
] as const;

/**
 * Scan exemptions (enforced by the "safety-scan sync" suite in tests/db.test.ts).
 *
 * Both scanners (scripts/safety-scan.mjs and runSafetySelfCheck) apply one
 * shared rule:
 *  1. Drop source lines carrying SCAN_EXEMPT_LINE_MARKER — used ONLY for
 *     secret-redaction regexes in src/util/logger.ts (naming a secret concept
 *     in order to redact it is defensive, not secret handling).
 *  2. Drop marked definition BLOCKS (lines from a line containing
 *     SCAN_EXEMPT_BLOCK_START through the line containing
 *     SCAN_EXEMPT_BLOCK_END, inclusive). Blocks may appear ONLY in files
 *     listed in SCAN_EXEMPT_PATH_SUFFIXES — the sync test enforces this, so
 *     the exemption cannot silently widen to other files.
 *  3. Strip comments string-aware, then match DENYLIST patterns.
 *
 * Rationale: the denylist and both scanners must NAME the banned patterns to
 * forbid them. Whole-file skips would hide real violations; block-scoping
 * keeps every line outside the pattern-definition literal scannable.
 */
export const SCAN_EXEMPT_PATH_SUFFIXES: readonly string[] = [
  "safety/denylist.ts",
  "scripts/safety-scan.mjs",
];

export const SCAN_EXEMPT_LINE_MARKER = "safety-scan-exempt(redaction)";

export const SCAN_EXEMPT_BLOCK_START = "scan-exempt-block: pattern definitions (start)";
export const SCAN_EXEMPT_BLOCK_END = "scan-exempt-block: pattern definitions (end)";
