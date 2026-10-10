import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parsePairs } from "../src/providers/dexscreener.js";
import type { NormalizedObservation } from "../src/providers/types.js";
import {
  meetsEntryBar,
  runRiskChecks,
  RISK_CHECK_IDS,
} from "../src/risk/checks.js";
import { fetchMintInfo } from "../src/risk/solanaRpc.js";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

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

  it("revoked authorities PASS with mint evidence; live authorities FAIL", () => {
    const obs = firstBonk();
    const revoked = runRiskChecks(obs, NOW, {
      mintInfo: {
        mintAuthority: null, freezeAuthority: null, decimals: 5,
        supply: "8799436428721866810",
        programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        fetchedAt: NOW, slot: 455406590,
      },
    });
    expect(revoked.checks.find((c) => c.checkId === "risk.mint-authority")?.status).toBe("PASS");
    expect(revoked.checks.find((c) => c.checkId === "risk.freeze-authority")?.status).toBe("PASS");
    expect(revoked.checks.find((c) => c.checkId === "risk.token-extensions")?.status).toBe("PASS");
    const live = runRiskChecks(obs, NOW, {
      mintInfo: {
        mintAuthority: "SoME111111111111111111111111111111111111111", freezeAuthority: null, decimals: 9,
        supply: "1000000",
        programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        fetchedAt: NOW, slot: 1,
      },
    });
    expect(live.checks.find((c) => c.checkId === "risk.mint-authority")?.status).toBe("FAIL");
    expect(live.entryAllowed).toBe(false);
  });

  it("live RPC: BONK mint authorities are revoked (PASS), classic program", async () => {
    const info = await fetchMintInfo(BONK);
    expect(info).not.toBeNull();
    expect(info?.mintAuthority).toBeNull();
    expect(info?.freezeAuthority).toBeNull();
    expect(info?.programId).toBe("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    const report = runRiskChecks(firstBonk(), NOW, { mintInfo: info });
    expect(report.checks.find((c) => c.checkId === "risk.mint-authority")?.status).toBe("PASS");
    expect(report.checks.find((c) => c.checkId === "risk.freeze-authority")?.status).toBe("PASS");
  }, 30_000);
});
