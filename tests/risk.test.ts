import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parsePairs } from "../src/providers/dexscreener.js";
import type { NormalizedObservation } from "../src/providers/types.js";
import {
  meetsEntryBar,
  runRiskChecks,
  RISK_CHECK_IDS,
} from "../src/risk/checks.js";

const NOW = 1_791_700_000_000;

function firstBonk(): NormalizedObservation {
  const json = JSON.parse(
    readFileSync(new URL("../fixtures/probes/dexscreener_tokens_BONK.json", import.meta.url), "utf8"),
  );
  const { observations } = parsePairs(json, "dexscreener:tokens", NOW - 5_000, 250);
  const obs = observations[0];
  if (obs === undefined) throw new Error("BONK fixture yielded no observations");
  return obs;
}

describe("risk checks", () => {
  it("M3 entry bar blocks on missing RPC evidence (conservative default)", () => {
    // Six of eight checks are NOT_SUPPORTED without RPC — entry must block.
    const report = runRiskChecks(firstBonk(), NOW);
    expect(report.entryAllowed).toBe(false);
    expect(report.summary).toContain("BLOCKED");
    const statuses = new Set(report.checks.map((c) => c.status));
    expect(statuses.has("NOT_SUPPORTED")).toBe(true);
  });

  it("UNKNOWN and NOT_SUPPORTED are never PASS", () => {
    const report = runRiskChecks(firstBonk(), NOW);
    for (const c of report.checks) {
      if (c.status === "UNKNOWN" || c.status === "NOT_SUPPORTED") {
        expect(
          meetsEntryBar(report.checks, [c.checkId]),
          `${c.checkId}=${c.status} must not pass`,
        ).toBe(false);
      }
    }
    // ...for every check id, including future ones (exact-equality enforcement).
    for (const id of RISK_CHECK_IDS) {
      const found = report.checks.find((c) => c.checkId === id);
      expect(found).toBeDefined();
    }
  });

  it("missing check blocks entry (no silent skip)", () => {
    const report = runRiskChecks(firstBonk(), NOW);
    expect(meetsEntryBar(report.checks.slice(0, 3))).toBe(false);
    expect(meetsEntryBar([])).toBe(false);
  });

  it("liquidity-depth PASS/FAIL/UNKNOWN follows the evidence", () => {
    const base = firstBonk();
    const deep = runRiskChecks({ ...base, liquidityUsd: "100000" }, NOW);
    expect(deep.checks.find((c) => c.checkId === "risk.liquidity-depth")?.status).toBe("PASS");
    const shallow = runRiskChecks({ ...base, liquidityUsd: "1000" }, NOW);
    expect(shallow.checks.find((c) => c.checkId === "risk.liquidity-depth")?.status).toBe("FAIL");
    const missing = runRiskChecks({ ...base, liquidityUsd: null }, NOW);
    expect(missing.checks.find((c) => c.checkId === "risk.liquidity-depth")?.status).toBe("UNKNOWN");
  });

  it("every check carries evidence + limitations", () => {
    const report = runRiskChecks(firstBonk(), NOW);
    expect(report.checks.length).toBe(RISK_CHECK_IDS.length);
    for (const c of report.checks) {
      expect(c.evidence.length).toBeGreaterThan(0);
      expect(c.limitations.length).toBeGreaterThan(0);
    }
    expect(report.summary.length).toBeGreaterThan(0);
  });
});
