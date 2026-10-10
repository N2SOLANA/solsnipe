/**
 * Static dashboard renderer — M7 data layer (§19.2).
 *
 * Renders a DashboardView to one self-contained dashboard/snapshot.html:
 * inline CSS, monospace, no external assets, works offline. Every number
 * comes from the view-model (which comes from SELECTs over the snapshot DB);
 * nothing is invented here. Fixture/seeded data is labeled via the `source`
 * field rendered per table ("Snapshot source: ..."). No charts — with no
 * trade history any chart would be fabricated (§19, §30).
 */

import type { ActivityView, DashboardView, HealthView, ScannerView } from "./views.js";

function esc(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "<span class=\"na\">n/a</span>";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function age(observedAt: number | null, nowMs: number): string {
  if (observedAt === null) return "never";
  const ms = nowMs - observedAt;
  if (ms < 0) return "future?";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${String(s)}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${String(h)}h ago`;
  return `${String(Math.floor(h / 24))}d ago`;
}

function abbrevAddr(addr: string): string {
  return addr.length > 16 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function renderScanner(view: ScannerView, nowMs: number): string {
  if (view.empty) {
    return `<section><h2>A. Market scanner</h2><p class="empty">No market data recorded yet. ${esc(view.reason)}</p></section>`;
  }
  const staleRows = view.rows.filter((r) => r.freshness === "STALE").length;
  const staleNote =
    staleRows > 0
      ? `<p class="warn">STALE: ${String(staleRows)} of ${String(view.rows.length)} rows older than ${String(Math.round(view.staleAfterMs / 1000))}s — do not treat as current prices.</p>`
      : `<p class="ok">All rows fresh (within ${String(Math.round(view.staleAfterMs / 1000))}s).</p>`;
  const trunc = view.truncated
    ? `<p class="note">Showing latest ${String(view.rows.length)} of ${String(view.totalPairs)} pairs.</p>`
    : "";
  const body = view.rows
    .map(
      (r) => `<tr>
  <td title="${esc(r.mint)} / ${esc(r.pairAddress)}">${esc(abbrevAddr(r.mint))}</td>
  <td class="num">${esc(r.priceUsd)}</td>
  <td class="num">${esc(r.liquidityUsd)}</td>
  <td class="num">${esc(r.volumeH24)}</td>
  <td class="num">${r.pairAgeMs === null ? '<span class="na">n/a</span>' : esc(age(nowMs - r.pairAgeMs, nowMs))}</td>
  <td class="${r.freshness === "STALE" ? "stale" : "fresh"}">${r.freshness} (${esc(age(r.observedAt, nowMs))})</td>
</tr>`,
    )
    .join("\n");
  return `<section><h2>A. Market scanner</h2>
<p class="note">Snapshot source: ${esc(view.sources)}. Discovered pairs: ${String(view.totalPairs)}.</p>
${staleNote}${trunc}
<table><thead><tr><th>Mint</th><th class="num">Price USD</th><th class="num">Liq USD</th><th class="num">Vol 24h</th><th>Pair age</th><th>Freshness</th></tr></thead>
<tbody>${body}</tbody></table></section>`;
}

function renderHealth(view: HealthView, nowMs: number): string {
  const mode = `<p class="paper">EXECUTION MODE: ${esc(view.executionMode)} (paper only — no real trades possible)</p>`;
  const stale = view.dataStale
    ? `<p class="warn">DATA STALE: last update ${view.lastUpdateTs === null ? "never" : esc(age(view.lastUpdateTs, nowMs))}. Do not trade on this.</p>`
    : `<p class="ok">Data current — last update ${view.lastUpdateTs === null ? "never" : esc(age(view.lastUpdateTs, nowMs))}.</p>`;
  const checks = view.selfCheck.checks
    .map((c) => `<li>${c.ok ? "PASS" : "FAIL"} — ${esc(c.name)}: ${esc(c.detail)}</li>`)
    .join("\n");
  const providers =
    view.providers.length === 0
      ? `<p class="empty">No provider polls recorded yet.</p>`
      : `<table><thead><tr><th>Provider</th><th>Endpoint</th><th>HTTP</th><th class="num">Latency ms</th><th>Status</th><th>Last</th></tr></thead><tbody>${view.providers
          .map(
            (p) => `<tr><td>${esc(p.provider)}</td><td>${esc(p.endpoint)}</td>
<td class="num">${p.statusCode === null ? "—" : esc(p.statusCode)}</td>
<td class="num">${esc(p.latencyMs)}</td>
<td class="${p.ok ? "fresh" : "stale"}">${p.ok ? "OK" : "ERROR"}</td>
<td>${esc(age(p.lastTs, nowMs))}</td></tr>`,
          )
          .join("\n")}</tbody></table>`;
  const gaps =
    view.gaps.length === 0
      ? `<p class="ok">No gaps recorded — continuous coverage since first poll.</p>`
      : `<p class="warn">Disclosed gaps (${String(view.gaps.length)}): outage windows with no data — never interpolated.</p>
<table><thead><tr><th>Start</th><th>End</th><th>Kind</th><th>Reason</th><th>Detail</th></tr></thead><tbody>${view.gaps
          .map(
            (g) => `<tr><td>${esc(new Date(g.gapStart).toISOString())}</td>
<td>${esc(new Date(g.gapEnd).toISOString())}</td>
<td>${esc(g.kind)}</td><td>${esc(g.reason)}</td><td>${esc(g.detail ?? "")}</td></tr>`,
          )
          .join("\n")}</tbody></table>`;
  return `<section><h2>F. System health</h2>
${mode}${stale}
<p>Recorder: <strong>${esc(view.recorderStatus)}</strong> — ${esc(view.recorderDetail)}</p>
<p class="note">Rows: ${String(view.counts.observations)} obs / ${String(view.counts.heartbeats)} heartbeats / ${String(view.counts.fetchEvents)} fetch events / ${String(view.counts.gaps)} gaps.</p>
<h3>Safety self-check: ${view.selfCheck.ok ? "PASS" : "FAIL"}</h3><ul>${checks}</ul>
<h3>Providers</h3>${providers}
<h3>Gaps</h3>${gaps}</section>`;
}

function renderActivity(view: ActivityView): string {
  const fetches =
    view.fetchEvents.length === 0
      ? `<p class="empty">No fetch events recorded yet.</p>`
      : `<table><thead><tr><th>Poll</th><th>Time</th><th>Provider</th><th>HTTP</th><th class="num">Latency ms</th><th class="num">Obs</th><th>Error</th></tr></thead><tbody>${view.fetchEvents
          .map(
            (f) => `<tr><td class="num">${esc(f.pollId)}</td>
<td>${esc(new Date(f.ts).toISOString())}</td><td>${esc(f.provider)}</td>
<td class="num">${f.statusCode === null ? "—" : esc(f.statusCode)}</td>
<td class="num">${esc(f.latencyMs)}</td><td class="num">${esc(f.obsCount)}</td>
<td>${f.error === null ? '<span class="na">—</span>' : esc(f.error)}</td></tr>`,
          )
          .join("\n")}</tbody></table>`;
  const beats =
    view.heartbeats.length === 0
      ? `<p class="empty">No heartbeats recorded yet.</p>`
      : `<table><thead><tr><th>Poll</th><th>Time</th><th>Status</th><th class="num">Watched</th><th class="num">Written</th></tr></thead><tbody>${view.heartbeats
          .map(
            (h) => `<tr><td class="num">${esc(h.pollId)}</td>
<td>${esc(new Date(h.ts).toISOString())}</td><td>${esc(h.status)}</td>
<td class="num">${esc(h.mintsWatched)}</td><td class="num">${esc(h.obsWritten)}</td></tr>`,
          )
          .join("\n")}</tbody></table>`;
  return `<section><h2>G. Activity &amp; audit</h2><p class="note">${esc(view.note)}</p>
<h3>Fetch events</h3>${fetches}<h3>Heartbeats</h3>${beats}</section>`;
}

export function renderSnapshotHtml(d: DashboardView): string {
  const now = d.generatedAt;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Solsnipe dashboard snapshot (PAPER)</title>
<style>
body{background:#111;color:#ddd;font-family:ui-monospace,Menlo,Consolas,monospace;margin:0;padding:16px;font-size:13px}
h1{font-size:18px;color:#7fff9e}h2{font-size:15px;color:#7fff9e;border-bottom:1px solid #333;padding-bottom:4px}
h3{font-size:13px;color:#ccc}table{border-collapse:collapse;width:100%;margin:8px 0}
th,td{border:1px solid #333;padding:4px 8px;text-align:left;vertical-align:top}
th{background:#1c1c1c;color:#aaa}td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.paper{background:#0a2a12;border:1px solid #2c7a3f;padding:8px;color:#7fff9e;font-weight:bold}
.warn{color:#ffa94d}.stale{color:#ffa94d;font-weight:bold}.fresh{color:#7fff9e}
.ok{color:#7fff9e}.empty{color:#bbb;font-style:italic}.note{color:#999}.na{color:#666}
section{margin-bottom:24px}
</style></head><body>
<h1>SOLSNIPE — dashboard snapshot (PAPER ONLY)</h1>
<p class="note">Generated ${esc(new Date(now).toISOString())} from the local snapshot DB (read-only). Prices shown are last-recorded observations with explicit freshness — never live quotes.</p>
${renderScanner(d.scanner, now)}
<section><h2>B. Candidate research</h2><p class="empty">Per-rule evidence and risk checks are not built yet (Milestones 3–4). No scanner verdicts (ACCEPT/REJECT/REVIEW) exist to display.</p></section>
<section><h2>C. Paper-trading terminal</h2><p class="empty">No orders yet — the paper-trading engine (Milestone 4) is not built. There is no order state machine to display.</p></section>
<section><h2>D. Portfolio overview</h2><p class="empty">${esc(d.portfolio.reason)}</p></section>
<section><h2>E. Performance analytics</h2><p class="empty">${esc(d.performance.reason)}</p></section>
${renderHealth(d.health, now)}
${renderActivity(d.activity)}
</body></html>
`;
}
