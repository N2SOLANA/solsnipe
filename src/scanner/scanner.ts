/**
 * Scanner entry point, Milestone 3 (spec §10, §11). Combines the rules into
 * a persist-ready, zod-validated ScannerResult with a human explanation.
 *
 * The scanner identifies candidates; it never authorizes execution.
 */
import { z } from "zod";
import type { NormalizedObservation } from "../providers/types.js";
import {
  deriveOutcome,
  evalAllRules,
  RuleResultSchema,
  ScannerOutcomeSchema,
  ScannerThresholdsSchema,
  type RuleResult,
  type ScannerOutcome,
  type ScannerThresholds,
} from "./rules.js";

export const ScannerResultSchema = z.object({
  candidateId: z.string().min(1).max(160),
  mint: z.string().min(1).max(64),
  pairAddress: z.string().min(1).max(64),
  scannedAt: z.number().int().nonnegative(),
  outcome: ScannerOutcomeSchema,
  rules: z.array(RuleResultSchema),
  /** Freshness status echoed for the dashboard (§11). */
  dataFreshness: z.enum(["fresh", "stale", "unknown"]),
  /** Human-readable explanation — always present, even on ACCEPT. */
  explanation: z.string().min(1).max(4000),
  source: z.string().min(1).max(64),
  observedAt: z.number().int().nonnegative(),
});
export type ScannerResult = z.infer<typeof ScannerResultSchema>;

export interface ScanOptions {
  nowMs: number;
  thresholds?: Partial<ScannerThresholds>;
  /** Rule ids that gate the outcome (default: all six). */
  requiredIds?: readonly string[];
}

export function candidateIdFor(obs: NormalizedObservation): string {
  return `${obs.mint}|${obs.pairAddress}`;
}

function failingIds(rules: RuleResult[]): string {
  return rules
    .filter((r) => r.verdict === "fail")
    .map((r) => r.ruleId)
    .join(", ");
}

function unknownIds(rules: RuleResult[]): string {
  return rules
    .filter((r) => r.verdict === "unknown")
    .map((r) => r.ruleId)
    .join(", ");
}

/** One-line summary per rule, then the outcome line. Always non-empty. */
export function explainOutcome(
  outcome: ScannerOutcome,
  rules: RuleResult[],
  obs: NormalizedObservation,
): string {
  const lines = rules.map((r) => {
    const seen =
      r.observedValue === null ? "no data" : `observed ${r.observedValue}`;
    return `- ${r.ruleId}: ${r.verdict.toUpperCase()} (${seen}; needs ${r.threshold})`;
  });
  let header: string;
  if (outcome === "ACCEPT") {
    header =
      `ACCEPT ${obs.mint}/${obs.pairAddress}: all ${String(rules.length)} required ` +
      `rules passed. Screening only — not an execution authorization.`;
  } else if (outcome === "REJECT") {
    const ids = failingIds(rules);
    header =
      `REJECT ${obs.mint}/${obs.pairAddress}: ` +
      `failed required rule${ids.includes(",") ? "s" : ""} (${ids}).`;
  } else {
    const ids = unknownIds(rules);
    header =
      `REVIEW ${obs.mint}/${obs.pairAddress}: ` +
      `incomplete evidence on ${ids === "" ? "required rules" : ids} — investigate before deciding.`;
  }
  return `${header}\n${lines.join("\n")}`;
}

function freshnessOf(
  t: ScannerThresholds,
  obs: NormalizedObservation,
  nowMs: number,
): "fresh" | "stale" | "unknown" {
  const ageMs = nowMs - obs.observedAt;
  if (!Number.isFinite(ageMs) || ageMs < 0) return "unknown";
  return ageMs <= t.maxDataAgeMs ? "fresh" : "stale";
}

/** Scan one observation. Pure apart from zod validation; never throws on data. */
export function scanObservation(
  obs: NormalizedObservation,
  options: ScanOptions,
): ScannerResult {
  const thresholds: ScannerThresholds = ScannerThresholdsSchema.parse({
    ...options.thresholds,
  });
  const rules = evalAllRules(obs, thresholds, options.nowMs);
  const outcome = deriveOutcome(rules, options.requiredIds);
  return ScannerResultSchema.parse({
    candidateId: candidateIdFor(obs),
    mint: obs.mint,
    pairAddress: obs.pairAddress,
    scannedAt: options.nowMs,
    outcome,
    rules,
    dataFreshness: freshnessOf(thresholds, obs, options.nowMs),
    explanation: explainOutcome(outcome, rules, obs),
    source: obs.source,
    observedAt: obs.observedAt,
  });
}
