/**
 * Recorder watchlist: a static JSON file (not env, not a DB table) listing
 * token mints to poll (§9.3 provenance). Reload is explicit via file mtime or
 * SIGHUP; malformed reloads never break the running loop.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const EntrySchema = z.object({
  mint: z.string().min(1),
  label: z.string().max(64).optional(),
  active: z.boolean().optional().default(true),
});

const WatchlistSchema = z.array(EntrySchema).min(0);

export interface Watchlist {
  mints: string[];
  labels: Map<string, string>;
  hash: string;
}

export function loadWatchlist(path: string): Watchlist {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const entries = WatchlistSchema.parse(raw);
  const seen = new Set<string>();
  const mints: string[] = [];
  const labels = new Map<string, string>();
  for (const entry of entries) {
    const mint = entry.mint.trim();
    if (entry.active !== true) continue;
    if (!BASE58_RE.test(mint)) {
      throw new Error(`invalid mint in watchlist: "${mint.slice(0, 20)}..."`);
    }
    if (!seen.has(mint)) {
      seen.add(mint);
      mints.push(mint);
      labels.set(mint, entry.label ?? mint.slice(0, 8));
    }
  }
  if (mints.length === 0) {
    throw new Error(`watchlist ${path} has zero active mints after validation`);
  }
  const hash = createHash("sha256").update(stableJoin(mints)).digest("hex").slice(0, 16);
  return { mints, labels, hash };
}

function stableJoin(mints: string[]): string {
  return [...mints].sort().join(",");
}
