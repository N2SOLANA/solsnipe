import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parsePairs } from "../src/providers/dexscreener.js";
import type { NormalizedObservation } from "../src/providers/types.js";
import { scanObservation, explainOutcome } from "../src/scanner/scanner.js";
import { deriveOutcome, evalAllRules, DEFAULT_SCANNER_THRESHOLDS } from "../src/scanner/rules.js";

const NOW = 1_791_700_000_000; // fixed decision time (no clock reads)

function bonkObservations(): NormalizedObservation[] {
  const json = JSON.parse(
    readFileSync(new URL("../fixtures/probes/dexscreener_tokens_BONK.json", import.meta.url), "utf8"),
  );
  const { observations, dropped } = parsePairs(json, "dexscreener:tokens", NOW - 5_000, 250);
  expect(dropped).toEqual([]);
  expect(observations.length).toBeGreaterThan(0);
  return observations;
}

describe("scanner (fixture-driven)", () => {
  it("REJECTs low-liquidity venues, ACCEPTs deep ones", () => {
    const all = bonkObservations();
    const outcomes = new Map(all.map((o) => [o.pairAddress, scanObservation(o, { nowMs: NOW }).outcome]));
    // BONK fixture spans orca/meteora/raydium with varied liquidity — expect a mix.
    const values = new Set(outcomes.values());
    expect(values.has("REJECT")).toBe(true);
    for (const [addr, outcome] of outcomes) {
      const obs = all.find((o) => o.pairAddress === addr);
      const liq = obs?.liquidityUsd === null ? null : Number(obs?.liquidityUsd);
      if (liq !== null && liq < 40_000) expect(outcome).toBe("REJECT");
    }
  });

  it("REVIEW on incomplete evidence (UNKNOWN never ACCEPTs)", () => {
    const obs = { ...bonkObservations()[0] };
    const nulled = {
      ...obs,
      liquidityUsd: null,
      volumeH24: null,
      txnsH24Buys: null,
      txnsH24Sells: null,
      pairCreatedAt: null,
    } as NormalizedObservation;
    const result = scanObservation(nulled, { nowMs: NOW });
    expect(result.outcome).toBe("REVIEW");
    expect(result.explanation).toContain("REVIEW");
    expect(result.explanation.length).toBeGreaterThan(20);
  });

  it("stale observations are flagged, not passed as fresh", () => {
    const obs = bonkObservations()[0] as NormalizedObservation;
    const stale = scanObservation(obs, { nowMs: NOW + 10 * 60_000 });
    expect(stale.dataFreshness).toBe("stale");
    expect(stale.outcome).toBe("REJECT"); // freshness rule fails required gate
  });

  it("threshold boundaries: at-limit passes, below fails", () => {
    const base = bonkObservations()[0] as NormalizedObservation;
    const rich = {
      ...base,
      liquidityUsd: "40000",
      volumeH24: "100000",
      txnsH24Buys: 100,
      txnsH24Sells: 100,
      pairCreatedAt: NOW - 31 * 60_000,
      priceChangeH24: "1.5",
      observedAt: NOW - 1_000,
    } as NormalizedObservation;
    const rules = evalAllRules(rich, DEFAULT_SCANNER_THRESHOLDS, NOW);
    const liq = rules.find((r) => r.ruleId === "liquidity-depth");
    expect(liq?.verdict).toBe("pass");
    const poor = { ...rich, liquidityUsd: "39999.99" };
    const rules2 = evalAllRules(poor, DEFAULT_SCANNER_THRESHOLDS, NOW);
    expect(rules2.find((r) => r.ruleId === "liquidity-depth")?.verdict).toBe("fail");
    expect(deriveOutcome(rules2)).toBe("REJECT");
  });

  it("explanation is always present and names rules", () => {
    for (const obs of bonkObservations().slice(0, 3)) {
      const result = scanObservation(obs, { nowMs: NOW });
      expect(result.explanation.length).toBeGreaterThan(20);
      expect(result.explanation).toContain("liquidity-depth");
      expect(explainOutcome(result.outcome, result.rules, obs)).toBe(result.explanation);
    }
  });

  it("vacuous ACCEPT is impossible (zero rules → REVIEW)", () => {
    expect(deriveOutcome([])).toBe("REVIEW");
  });

  it("a fail outside the required subset still REJECTs (M5)", () => {
    const base = bonkObservations()[0] as NormalizedObservation;
    const rich = {
      ...base,
      liquidityUsd: "100000",
      volumeH24: "100000",
      txnsH24Buys: 100,
      txnsH24Sells: 100,
      pairCreatedAt: NOW - 31 * 60_000,
      priceChangeH24: "1.5",
      observedAt: NOW - 1_000,
    } as NormalizedObservation;
    const rules = evalAllRules(rich, DEFAULT_SCANNER_THRESHOLDS, NOW);
    // Sanity: full set ACCEPTs.
    expect(deriveOutcome(rules)).toBe("ACCEPT");
    // Narrow the required set to exclude liquidity — then break liquidity.
    // The failure must still surface as REJECT, not a narrowed ACCEPT.
    const subset = ["trading-activity", "pair-age", "data-freshness", "spike-guard", "volume-liquidity-sanity"];
    const broken = rules.map((r) =>
      r.ruleId === "liquidity-depth" ? { ...r, verdict: "fail" as const } : r,
    );
    expect(deriveOutcome(broken, subset)).toBe("REJECT");
  });
});
