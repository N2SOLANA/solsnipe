# SOLSNIPE execution model (M4, spec §15.4)

PAPER-ONLY. Every value below is a **modeled** assumption, never a verified
market outcome. A BUY signal is not a completed paper trade: the order, fill,
portfolio, ledger, and history records must agree.

## The four prices (never conflated)

1. `observedPrice` — last market price as observed (input, echoed back).
2. `executablePrice` — observed price moved by modeled latency drift, then
   spread/slippage and constant-product impact, against the trader.
3. `fillPrice` — executable price minus the modeled adverse-selection draw.
4. Portfolio valuation — derived at a FRESH mark price, never at fillPrice.
   The model returns this as `valuationNote`, not a number, so no caller can
   mistake a modeled fill for a valuation input.

## Assumptions and defaults

| # | Assumption | Default | Why modeled |
|---|---|---|---|
| 1 | Landing latency is skewed 0.4–3 s (`minLatencyMs`/`maxLatencyMs`/`latencySkew=2`; sample = min + (max−min)·u²) | 400 / 3000 / 2 | No venue is touched; delay is drawn, not measured |
| 2 | Price drifts during latency with sigma `driftSigmaPerSecond=0.02` (magnitude σ·√t, sign from a second draw) applied to the freshest price | 0.02 | No order book is read; drift is synthetic |
| 3 | Constant-product impact ≈ notional / (reserves + notional), assuming quote-side reserves ≈ `quoteReserveShare=0.5` of reported total liquidity | 0.5 | Pool reserve split is not observed; labeled estimate |
| 4 | Spread/slippage beyond impact = `spreadPerVolatility=0.5` × observed volatility | 0.5 | No spread feed; scaled guess |
| 5 | Pool fee = pair's verified fee when known, else `defaultPoolFeeFraction=0.003`, ceiled (costs up) | 0.003 | True fee often unverifiable |
| 6 | Flat network + priority + modeled tip legs, BUY and SELL separately | 10,000 lamports each | Real fee schedule not consulted |
| 7 | Adverse-selection / MEV draw uniform in [0, `maxAdverseDrawFraction=0.01`], against the trader | 0.01 | Sandwich/front-run risk on illiquid memecoins, modeled |
| 8 | Failure probability = `baseFailureProbability=0.02` + `failurePerVolatility=0.5`·volatility + `lowLiquidityFailureUplift=0.1` below `lowLiquidityUsd=40,000` | see defaults | No venue rejects anything; failures drawn |
| 9 | Partial fills: fills capped at `maxFillShareOfReserves=0.5` of assumed quote reserves; excess reported as `fillFraction < 1` | 0.5 | Liquidity-based estimate, not a venue response |
| 10 | Stale execution data is NEVER filled at: with no sufficiently fresh execution-time observation the attempt fails (`stale-execution-price`) | `maxExecutionDataAgeMs` from caller | Filling at a stale price would invent value |

## Further modeled policies

- Failed attempts still report the flat network/priority leg where realistic;
  the pool fee never accrues on a failure.
- Simulated exits need an exit quote or liquidity-based estimate; inadequate
  liquidity yields delay, partial fill, or failure per the model — never a
  clean exit at the displayed price.
- All draws come from a seeded PRNG (`mulberry32`), so a (quote, params, seed)
  triple always reproduces the same vector. Tests pin vectors by seed.
- Money: `bigint` lamports for cash/quantities/fees; prices as decimal
  strings (no float money, §5.2). Conservative rounding: costs up
  (pool fee ceiled), proceeds floored at ledger posting.
