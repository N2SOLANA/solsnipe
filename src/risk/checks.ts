/**
 * On-chain risk checks, Milestone 3 (spec §12, §12.4).
 *
 * PAPER-ONLY: no RPC calls in M3 — Dexscreener observations cannot establish
 * mint/freeze authority, extensions, locks, concentration, or sellability
 * (§12, docs/PROVIDERS.md §1 "What Dexscreener does NOT give us"). Checks
 * that need data we do not have return UNKNOWN or NOT_SUPPORTED, and the
 * type system keeps those distinct from PASS.
 *
 * Hard invariant: UNKNOWN and NOT_SUPPORTED are NEVER treated as PASS.
 * `meetsEntryBar` enforces it structurally — there is no caller discretion.
 */
import { z } from "zod";
import { Decimal } from "decimal.js";
import type { NormalizedObservation } from "../providers/types.js";
import {
  isClassicTokenProgram,
  isToken2022Program,
  type MintInfo,
} from "./solanaRpc.js";

export const RiskStatusSchema = z.enum(["PASS", "FAIL", "UNKNOWN", "NOT_SUPPORTED"]);
export type RiskStatus = z.infer<typeof RiskStatusSchema>;

export const RiskCheckSchema = z.object({
  checkId: z.string().min(1).max(64),
  status: RiskStatusSchema,
  source: z.string().min(1).max(64),
  observedAt: z.number().int().nonnegative(),
  /** What the evidence shows (or why it is missing). Always present. */
  evidence: z.string().min(1).max(2000),
  /** Limits of the evidence / reason for uncertainty. Always present. */
  limitations: z.string().min(1).max(2000),
});
export type RiskCheck = z.infer<typeof RiskCheckSchema>;

export const RiskReportSchema = z.object({
  candidateId: z.string().min(1).max(160),
  checkedAt: z.number().int().nonnegative(),
  checks: z.array(RiskCheckSchema),
  /** True only when every required check is PASS (see meetsEntryBar). */
  entryAllowed: z.boolean(),
  summary: z.string().min(1).max(4000),
});
export type RiskReport = z.infer<typeof RiskReportSchema>;

/** Checks evaluated in M3. RPC-backed ids are reserved for a later milestone. */
export const RISK_CHECK_IDS = [
  "risk.liquidity-depth",
  "risk.pair-age",
  "risk.mint-authority",
  "risk.freeze-authority",
  "risk.token-extensions",
  "risk.liquidity-lock",
  "risk.holder-concentration",
  "risk.sellability",
] as const;

/**
 * Stub interface for the future RPC-backed checks (Milestone 3+: §12.1–12.3).
 * Declared now so callers depend on the shape, not on RPC access we do not
 * yet use. No implementation and no calls in M3.
 */
export interface MintAccountEvidence {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  tokenProgram: "token" | "token-2022" | "unknown";
  /** Token-2022 extension names present, empty when none/unknown. */
  extensions: readonly string[];
  fetchedAt: number;
  source: string;
}

function dec(s: string | null | undefined): Decimal | null {
  if (s === null || s === undefined) return null;
  try {
    const d = new Decimal(s);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

function check(
  checkId: string,
  status: RiskStatus,
  obs: NormalizedObservation,
  evidence: string,
  limitations: string,
): RiskCheck {
  return RiskCheckSchema.parse({
    checkId,
    status,
    source: obs.source,
    observedAt: obs.observedAt,
    evidence,
    limitations,
  });
}

/**
 * Dexscreener-evidence check: pool depth. PASS when liquidityUsd meets the
 * bar; FAIL when it is present but below; UNKNOWN when missing. This is a
 * screening aid, not proof of safe liquidity (§12.2: lock status unknown).
 */
export function checkLiquidityDepth(
  obs: NormalizedObservation,
  minLiquidityUsd: string,
): RiskCheck {
  const liq = dec(obs.liquidityUsd);
  const limitations =
    "Dexscreener liquidity is a point-in-time venue quote, not a lock proof. " +
    "Liquidity-lock status is NOT established by this check (see risk.liquidity-lock).";
  if (liq === null) {
    return check(
      "risk.liquidity-depth",
      "UNKNOWN",
      obs,
      "liquidityUsd missing in observation — depth cannot be assessed.",
      limitations,
    );
  }
  const ok = liq.gte(minLiquidityUsd);
  return check(
    "risk.liquidity-depth",
    ok ? "PASS" : "FAIL",
    obs,
    `liquidityUsd=${obs.liquidityUsd} vs minimum ${minLiquidityUsd}.`,
    limitations,
  );
}

/**
 * Dexscreener-evidence check: pair age as a rug-proxies aid. PASS when the
 * pair age is known and meets the minimum; FAIL when known and younger;
 * UNKNOWN when pairCreatedAt is missing or implausible.
 */
export function checkPairAge(
  obs: NormalizedObservation,
  minPairAgeMs: number,
): RiskCheck {
  const limitations =
    "Age is venue pair age from Dexscreener, not token-mint age. " +
    "Aged pairs can still be unsafe; age is weak evidence.";
  if (obs.pairCreatedAt === null) {
    return check(
      "risk.pair-age",
      "UNKNOWN",
      obs,
      "pairCreatedAt missing — pair age unverifiable.",
      limitations,
    );
  }
  const ageMs = obs.observedAt - obs.pairCreatedAt;
  if (ageMs < 0) {
    return check(
      "risk.pair-age",
      "UNKNOWN",
      obs,
      `pairCreatedAt=${obs.pairCreatedAt} after observedAt=${obs.observedAt} (skew or bad data).`,
      limitations,
    );
  }
  return check(
    "risk.pair-age",
    ageMs >= minPairAgeMs ? "PASS" : "FAIL",
    obs,
    `pair age ${ageMs}ms vs minimum ${minPairAgeMs}ms.`,
    limitations,
  );
}

function rpcStub(
  checkId: string,
  obs: NormalizedObservation,
  evidence: string,
  limitations: string,
): RiskCheck {
  return check(checkId, "NOT_SUPPORTED", obs, evidence, limitations);
}

/** §12.1: mint authority from verified mint-account evidence. */
export function checkMintAuthority(
  obs: NormalizedObservation,
  mintInfo?: MintInfo | null,
): RiskCheck {
  if (mintInfo === undefined || mintInfo === null) {
    return rpcStub(
      "risk.mint-authority",
      obs,
      "Mint authority unverified — no mint-account read available.",
      "Requires Solana JSON-RPC getAccountInfo on the mint (authorized read-only source, §12.1). " +
        "Until then, authority may be live and mintable; treat as unknown risk.",
    );
  }
  if (mintInfo.mintAuthority === null) {
    return check(
      "risk.mint-authority",
      "PASS",
      obs,
      `Mint authority is null (revoked, fixed supply) at slot ${mintInfo.slot}.`,
      "Evidence is a point-in-time mint-account read; authority cannot be re-added once null, but the read itself could be stale.",
    );
  }
  return check(
    "risk.mint-authority",
    "FAIL",
    obs,
    `Mint authority is live: ${mintInfo.mintAuthority.slice(0, 12)}… — supply can be inflated.`,
    "A live authority may be a multisig with limited powers, but the evidence supports FAIL under the conservative policy.",
  );
}

/** §12.1: freeze authority from verified mint-account evidence. */
export function checkFreezeAuthority(
  obs: NormalizedObservation,
  mintInfo?: MintInfo | null,
): RiskCheck {
  if (mintInfo === undefined || mintInfo === null) {
    return rpcStub(
      "risk.freeze-authority",
      obs,
      "Freeze authority unverified — no mint-account read available.",
      "Requires Solana JSON-RPC getAccountInfo on the mint (§12.1). " +
        "A live freeze authority can block selling; treat as unknown risk.",
    );
  }
  if (mintInfo.freezeAuthority === null) {
    return check(
      "risk.freeze-authority",
      "PASS",
      obs,
      `Freeze authority is null (revoked) at slot ${mintInfo.slot} — accounts cannot be frozen.`,
      "Point-in-time evidence; revocation is irreversible so staleness only matters for the FAIL direction.",
    );
  }
  return check(
    "risk.freeze-authority",
    "FAIL",
    obs,
    `Freeze authority is live: ${mintInfo.freezeAuthority.slice(0, 12)}… — holder accounts can be frozen, blocking exit.`,
    "Conservative policy treats any live freeze authority as entry-blocking.",
  );
}

/** §12.1: token program from the mint-account owner. */
export function checkTokenExtensions(
  obs: NormalizedObservation,
  mintInfo?: MintInfo | null,
): RiskCheck {
  if (mintInfo === undefined || mintInfo === null) {
    return rpcStub(
      "risk.token-extensions",
      obs,
      "Token program and extensions unverified — Dexscreener does not report them.",
      "Requires mint-account owner/program id plus Token-2022 extension parsing (§12.1). " +
        "Policy: a transfer-restricting extension is FAIL once evidence exists.",
    );
  }
  if (isClassicTokenProgram(mintInfo.programId)) {
    return check(
      "risk.token-extensions",
      "PASS",
      obs,
      "Classic SPL Token program (no extensions possible).",
      "Owner check only; assumes the well-known program id is not spoofed (program ids are consensus addresses).",
    );
  }
  if (isToken2022Program(mintInfo.programId)) {
    return check(
      "risk.token-extensions",
      "UNKNOWN",
      obs,
      "Token-2022 program: extension parsing not yet implemented — transfer-fee/hook/permanent-delegate status unknown.",
      "Requires parsing extension TLV data from the mint account (§12.1). Until parsed, entry stays blocked; a restrictive extension would be FAIL.",
    );
  }
  return check(
    "risk.token-extensions",
    "FAIL",
    obs,
    `Unknown token program owner: ${mintInfo.programId.slice(0, 12)}… — transfer semantics unverifiable.`,
    "Only the two known SPL programs are accepted; anything else fails closed.",
  );
}

/** §12.2: a lock is PASS only with verifiable evidence — none in M3. */
export function checkLiquidityLock(obs: NormalizedObservation): RiskCheck {
  return rpcStub(
    "risk.liquidity-lock",
    obs,
    "No liquidity-lock evidence available — Dexscreener cannot establish lock status (§12.2).",
    "Lock claims need verifiable on-chain evidence (locker account / burn proof), out of scope for M3. " +
      "UNKNOWN-by-default would overstate; NOT_SUPPORTED until an evidence source is wired.",
  );
}

/** §12.3: needs largest-accounts + owner mapping with vault/burn caveats. */
export function checkHolderConcentration(obs: NormalizedObservation): RiskCheck {
  return rpcStub(
    "risk.holder-concentration",
    obs,
    "Holder concentration unverified — no token-account data in M3.",
    "Requires RPC getTokenLargestAccounts plus owner mapping; pool vaults, burn addresses, and " +
      "system accounts must be excluded and the limitation stated (§12.3).",
  );
}

/** §12.3: needs a permitted read-only quote; not wired in M3. */
export function checkSellability(obs: NormalizedObservation): RiskCheck {
  return rpcStub(
    "risk.sellability",
    obs,
    "Sellability unverified — no read-only quote performed in M3.",
    "Requires a permitted read-only quote endpoint (§12.3); a 5xx/non-JSON quote must be UNKNOWN, " +
      "never failure-to-sell. Until wired, selling is not evidenced.",
  );
}

export interface RiskOptions {
  minLiquidityUsd?: string;
  minPairAgeMs?: number;
  /** Verified mint-account evidence (none = RPC checks stay NOT_SUPPORTED). */
  mintInfo?: MintInfo | null;
}

/** Run all eight checks in a fixed order; mintInfo wires the RPC-backed three. */
export function runRiskChecks(
  obs: NormalizedObservation,
  checkedAt: number,
  options: RiskOptions = {},
): RiskReport {
  const minLiquidityUsd = options.minLiquidityUsd ?? "40000";
  const minPairAgeMs = options.minPairAgeMs ?? 30 * 60_000;
  const checks: RiskCheck[] = [
    checkLiquidityDepth(obs, minLiquidityUsd),
    checkPairAge(obs, minPairAgeMs),
    checkMintAuthority(obs, options.mintInfo),
    checkFreezeAuthority(obs, options.mintInfo),
    checkTokenExtensions(obs, options.mintInfo),
    checkLiquidityLock(obs),
    checkHolderConcentration(obs),
    checkSellability(obs),
  ];
  const entryAllowed = meetsEntryBar(checks);
  const byStatus = (s: RiskStatus): string => {
    const ids = checks
      .filter((c) => c.status === s)
      .map((c) => c.checkId)
      .join(", ");
    return ids === "" ? "none" : ids;
  };
  const summary =
    `Risk report for ${obs.mint}/${obs.pairAddress}: ` +
    `PASS[${byStatus("PASS")}] FAIL[${byStatus("FAIL")}] ` +
    `UNKNOWN[${byStatus("UNKNOWN")}] NOT_SUPPORTED[${byStatus("NOT_SUPPORTED")}]. ` +
    `Entry ${entryAllowed ? "allowed (all required checks PASS)" : "BLOCKED (default conservative policy: missing evidence is not safety)"}.`;
  return RiskReportSchema.parse({
    candidateId: `${obs.mint}|${obs.pairAddress}`,
    checkedAt,
    checks,
    entryAllowed,
    summary,
  });
}

/**
 * Entry bar (§12.4): allowed ONLY when every required check is PASS.
 * UNKNOWN and NOT_SUPPORTED are never PASS — enforced by exact equality
 * against "PASS", so any future status defaults to blocking.
 */
export function meetsEntryBar(
  checks: RiskCheck[],
  requiredIds: readonly string[] = RISK_CHECK_IDS,
): boolean {
  for (const id of requiredIds) {
    const found = checks.find((c) => c.checkId === id);
    if (found === undefined) return false; // missing check blocks entry
    if (found.status !== "PASS") return false; // FAIL, UNKNOWN, NOT_SUPPORTED all block
  }
  return checks.length > 0;
}
