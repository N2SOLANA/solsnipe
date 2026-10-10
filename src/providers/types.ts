/**
 * Market-data provider abstraction (§9.1). Scanner, strategy, risk engine,
 * execution, and dashboard consume NormalizedObservation — never raw provider
 * payloads. New sources implement MarketDataProvider without touching callers.
 */
import { z } from "zod";

/** Strict decimal string: no exponent, no hex, no whitespace (trim first). */
export const DecimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, "not a plain decimal string");

/** Signed decimal (priceChange may be negative). */
export const SignedDecimalString = DecimalString;

export const Millis = z.number().int().nonnegative().finite();
const NonNegInt = z.number().int().nonnegative().finite();

/** One validated market observation. Decimal fields are strings (no float). */
export const NormalizedObservationSchema = z.object({
  mint: z.string().min(1).max(64),
  pairAddress: z.string().min(1).max(64),
  dexId: z.string().min(1).max(64),
  chainId: z.string().min(1).max(32),
  quoteMint: z.string().min(1).max(64).nullable(),
  priceUsd: DecimalString.max(64).nullable(), // decimal string or null if missing
  priceNative: DecimalString.max(64).nullable(),
  liquidityUsd: DecimalString.max(64).nullable(),
  liquidityBase: DecimalString.max(64).nullable(),
  liquidityQuote: DecimalString.max(64).nullable(),
  volumeH24: DecimalString.max(64).nullable(),
  volumeH6: DecimalString.max(64).nullable(),
  volumeH1: DecimalString.max(64).nullable(),
  volumeM5: DecimalString.max(64).nullable(),
  txnsH24Buys: NonNegInt.nullable(),
  txnsH24Sells: NonNegInt.nullable(),
  priceChangeH24: SignedDecimalString.max(32).nullable(),
  marketCap: DecimalString.max(64).nullable(),
  fdv: DecimalString.max(64).nullable(),
  pairCreatedAt: Millis.nullable(), // ms epoch, null when unverifiable
  observedAt: Millis, // when WE received/validated it
  source: z.string().min(1).max(64), // e.g. "dexscreener:tokens"
  latencyMs: NonNegInt,
  rawHash: z.string().length(64), // sha256 hex of stable-stringified raw item
  validationNotes: z.array(z.string().max(240)),
});

export type NormalizedObservation = z.infer<typeof NormalizedObservationSchema>;

export interface FetchResult {
  observations: NormalizedObservation[];
  statusCode: number | null; // null when no HTTP response (network error)
  latencyMs: number;
  fetchedAt: number;
  error: string | null;
}

export interface MarketDataProvider {
  readonly name: string;
  fetchPairsByMints(mints: string[]): Promise<FetchResult>;
  searchPairs(query: string): Promise<FetchResult>;
}
