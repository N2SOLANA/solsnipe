/**
 * Solsnipe trading terminal renderer (PAPER ONLY).
 *
 * Single self-contained HTML page: sidebar nav, topbar status, metric cards,
 * SVG price chart from recorded observations, searchable/sortable scanner
 * table, candidate verdicts computed by the real scanner pipeline, portfolio
 * and performance panels, compact health indicators, audit log.
 *
 * Every number comes from the DashboardView (SELECTs over local DBs).
 * Nothing is invented: empty panels say why, verdicts come only from
 * scanObservation/runRiskChecks, charts plot recorded points only.
 */
import type {
  ActivityView, DashboardView, HealthView, ScannerItem, ScannerView,
  PortfolioPanel, PerformancePanel, MarketHistoryPoint,
} from "./views.js";

function esc(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtUsd(v: string | null): string {
  if (v === null) return '<span class="na">—</span>';
  const n = Number(v);
  if (!Number.isFinite(n)) return '<span class="na">—</span>';
  if (n === 0) return "0";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toPrecision(3)}`;
}

function fmtPrice(v: string | null): string {
  if (v === null) return '<span class="na">—</span>';
  const n = Number(v);
  if (!Number.isFinite(n)) return '<span class="na">—</span>';
  if (n >= 1) return n.toFixed(2);
  return n.toPrecision(4);
}

function fmtAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function fmtPairAge(ms: number | null): string {
  if (ms === null) return '<span class="na">n/a</span>';
  return fmtAge(ms);
}

function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

function lamports(n: string | null): string {
  if (n === null) return '<span class="na">—</span>';
  try {
    const sol = Number(BigInt(n)) / 1e9;
    return `${sol.toFixed(4)} SOL`;
  } catch {
    return '<span class="na">—</span>';
  }
}

// ---------------------------------------------------------------------------
// SVG price chart: recorded daily first-prices per mint, log-ish scaled.
// ---------------------------------------------------------------------------

const CHART_COLORS = ["#4ade80", "#60a5fa", "#f472b6", "#fbbf24", "#a78bfa", "#34d399"];

function renderChart(history: MarketHistoryPoint[], mints: { mint: string; label: string }[]): string {
  if (history.length === 0) {
    return `<div class="chart-empty">No recorded price history yet — the chart appears once the recorder has written observations.</div>`;
  }
  const W = 640, H = 180, PL = 8, PR = 8, PT = 10, PB = 22;
  const byMint = new Map<string, MarketHistoryPoint[]>();
  for (const p of history) {
    const list = byMint.get(p.mint) ?? [];
    list.push(p);
    byMint.set(p.mint, list);
  }
  const vals = history.map((p) => Number(p.priceUsd)).filter((n) => Number.isFinite(n) && n > 0);
  if (vals.length === 0) return `<div class="chart-empty">Recorded prices are not numeric — nothing to plot.</div>`;
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || hi || 1;
  const t0 = Math.min(...history.map((p) => p.observedAt));
  const t1 = Math.max(...history.map((p) => p.observedAt));
  const tspan = t1 - t0 || 1;
  const X = (t: number) => PL + ((t - t0) / tspan) * (W - PL - PR);
  const Y = (v: number) => PT + (1 - (v - lo) / span) * (H - PT - PB);
  let paths = "";
  let i = 0;
  for (const [mint, pts] of byMint) {
    const color = CHART_COLORS[i % CHART_COLORS.length];
    i += 1;
    const sorted = [...pts].sort((a, b) => a.observedAt - b.observedAt);
    const d = sorted.map((p, j) => `${j === 0 ? "M" : "L"}${X(p.observedAt).toFixed(1)},${Y(Number(p.priceUsd)).toFixed(1)}`).join(" ");
    const label = mints.find((m) => m.mint === mint)?.label ?? shortAddr(mint);
    paths += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2"><title>${esc(label)} — ${sorted.length} recorded points</title></path>`;
    const last = sorted[sorted.length - 1];
    if (last !== undefined) {
      paths += `<circle cx="${X(last.observedAt).toFixed(1)}" cy="${Y(Number(last.priceUsd)).toFixed(1)}" r="3" fill="${color}"><title>${esc(label)} last: ${esc(last.priceUsd)}</title></circle>`;
    }
  }
  const mid = new Date(t0 + tspan / 2).toISOString().slice(0, 10);
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Recorded daily first-prices per token">
<text x="${PL}" y="${H - 6}" class="chart-t">${esc(new Date(t0).toISOString().slice(0, 10))}</text>
<text x="${W / 2}" y="${H - 6}" class="chart-t" text-anchor="middle">${esc(mid)}</text>
<text x="${W - PR}" y="${H - 6}" class="chart-t" text-anchor="end">${esc(new Date(t1).toISOString().slice(0, 10))}</text>
${paths}</svg>
<p class="note">Recorded daily first-prices, ${history.length} points. Actual observations only — no interpolation.</p>`;
}

// ---------------------------------------------------------------------------
// Sections.
// ---------------------------------------------------------------------------

function metricCards(d: DashboardView, nowMs: number): string {
  const accepts = d.candidates.filter((c) => c.outcome === "ACCEPT").length;
  const stale = d.scanner.rows.filter((r) => r.freshness === "STALE").length;
  const cards = [
    { label: "Tracked pairs", value: String(d.scanner.totalPairs), sub: `${d.scanner.rows.length} shown` },
    { label: "ACCEPT candidates", value: String(accepts), sub: `of ${d.candidates.length} evaluated` },
    {
      label: "Portfolio equity", value: d.portfolio.empty ? "N/A" : lamports(d.portfolio.equityLamports),
      sub: d.portfolio.empty ? "no fills persisted" : "simulated",
    },
    {
      label: "Net P&L (replay)", value: d.performance.empty ? "N/A" : lamports(d.performance.netPnlLamports),
      sub: d.performance.empty ? "no replay" : esc(d.performance.verdict ?? ""),
    },
    {
      label: "System", value: esc(d.health.recorderStatus),
      sub: stale > 0 ? `${stale} stale rows` : `updated ${fmtAge(nowMs - (d.health.lastUpdateTs ?? nowMs))} ago`,
      tone: d.health.recorderStatus === "RUNNING" ? "ok" : "warn",
    },
  ];
  return `<div class="cards">${cards.map((c) => `<div class="card"><div class="card-label">${c.label}</div><div class="card-value${c.tone === "warn" ? " warn" : ""}">${c.value}</div><div class="card-sub">${c.sub}</div></div>`).join("")}</div>`;
}

function renderOverview(d: DashboardView, nowMs: number, mints: { mint: string; label: string }[]): string {
  void nowMs;
  return `<section id="overview"><h2>Overview</h2>${metricCards(d, d.generatedAt)}
<h3>Recorded market activity</h3>${renderChart(d.marketHistory, mints)}</section>`;
}

function verdictBadge(outcome: string): string {
  const cls = outcome === "ACCEPT" ? "ok" : outcome === "REJECT" ? "bad" : "warn";
  return `<span class="badge ${cls}">${esc(outcome)}</span>`;
}

function renderScannerRows(rows: ScannerItem[], nowMs: number): string {
  return rows.map((r, idx) => `<tr data-idx="${idx}" data-search="${esc(r.mint.toLowerCase())} ${esc(r.pairAddress.toLowerCase())} ${esc(r.dexId.toLowerCase())}">
<td><span class="mono">${esc(shortAddr(r.mint))}</span><br><span class="dim mono" title="${esc(r.pairAddress)}">pair ${esc(shortAddr(r.pairAddress))}</span></td>
<td>${esc(r.dexId)}</td>
<td class="num">${fmtPrice(r.priceUsd)}</td>
<td class="num">${fmtUsd(r.liquidityUsd)}</td>
<td class="num">${fmtUsd(r.volumeH24)}</td>
<td class="num ${Number(r.priceChangeH24 ?? 0) >= 0 ? "ok" : "bad"}">${r.priceChangeH24 === null ? '<span class="na">—</span>' : `${esc(Number(r.priceChangeH24).toFixed(1))}%`}</td>
<td>${fmtPairAge(r.pairAgeMs)}</td>
<td class="${r.freshness === "STALE" ? "stale" : "fresh"}">obs ${fmtAge(r.ageMs)} ago</td>
</tr>`).join("\n");
}

function renderScanner(d: DashboardView, nowMs: number): string {
  if (d.scanner.empty) {
    return `<section id="scanner"><h2>Market scanner</h2><p class="empty">No market data recorded yet. ${esc(d.scanner.reason ?? "")}</p></section>`;
  }
  return `<section id="scanner"><h2>Market scanner</h2>
<p class="note">Source: ${esc(d.scanner.sources)} · ${d.scanner.totalPairs} pairs · observation age vs pair age shown separately.</p>
<div class="toolbar"><input id="scan-search" type="search" placeholder="Filter by mint, pair, or DEX…" aria-label="Filter scanner rows">
<select id="scan-sort" aria-label="Sort scanner rows">
<option value="liq-desc">Liquidity ↓</option><option value="liq-asc">Liquidity ↑</option>
<option value="vol-desc">Volume 24h ↓</option><option value="vol-asc">Volume 24h ↑</option>
<option value="chg-desc">Change 24h ↓</option><option value="chg-asc">Change 24h ↑</option>
<option value="age-asc">Pair age ↑ (newest)</option><option value="age-desc">Pair age ↓ (oldest)</option>
</select></div>
<table id="scan-table"><thead><tr><th>Token / Pair</th><th>DEX</th><th class="num">Price</th><th class="num">Liquidity</th><th class="num">Vol 24h</th><th class="num">Δ 24h</th><th>Pair age</th><th>Observation</th></tr></thead>
<tbody>${renderScannerRows(d.scanner.rows, nowMs)}</tbody></table></section>`;
}

function renderCandidates(d: DashboardView): string {
  if (d.candidates.length === 0) {
    return `<section id="candidates"><h2>Candidate intelligence</h2><p class="empty">No scanner verdicts computed for the latest observations yet.</p></section>`;
  }
  const ranked = [...d.candidates].sort((a, b) =>
    (a.outcome === "ACCEPT" ? 0 : a.outcome === "REVIEW" ? 1 : 2) - (b.outcome === "ACCEPT" ? 0 : b.outcome === "REVIEW" ? 1 : 2));
  return `<section id="candidates"><h2>Candidate intelligence</h2>
<p class="note">Verdicts computed by the real scanner + risk pipeline at snapshot time. Never scores — only evidence.</p>
<div class="cand-list">${ranked.map((c) => {
  const fails = c.rules.filter((r) => r.verdict === "fail");
  const unknowns = c.rules.filter((r) => r.verdict === "unknown");
  const riskFails = c.risk.filter((r) => r.status === "FAIL");
  const riskUnknown = c.risk.filter((r) => r.status === "UNKNOWN" || r.status === "NOT_SUPPORTED");
  return `<article class="cand"><header>${verdictBadge(c.outcome)} <span class="mono">${esc(shortAddr(c.mint))}</span> <span class="dim">· ${esc(c.dexId)} · pair ${esc(shortAddr(c.pairAddress))}</span></header>
<p>${esc(c.explanation.split("\n")[0] ?? "")}</p>
${fails.length > 0 ? `<p class="bad">Failed: ${esc(fails.map((r) => `${r.ruleId} (observed ${r.observedValue ?? "no data"}; needs ${r.threshold})`).join("; "))}</p>` : ""}
${unknowns.length > 0 ? `<p class="warn">Incomplete: ${esc(unknowns.map((r) => r.ruleId).join(", "))}</p>` : ""}
${riskFails.length > 0 ? `<p class="bad">Risk FAIL: ${esc(riskFails.map((r) => r.checkId).join(", "))}</p>` : ""}
${riskUnknown.length > 0 ? `<p class="warn">Risk unevidenced: ${esc(riskUnknown.map((r) => `${r.checkId} (${r.status})`).join(", "))}</p>` : ""}
</article>`;
}).join("")}</div></section>`;
}

function renderPortfolio(p: PortfolioPanel): string {
  if (p.empty) {
    return `<section id="paper"><h2>Paper trading</h2><div class="empty-box"><h3>No simulated fills yet</h3><p>${esc(p.reason ?? "")}</p><p class="note">Entries require every risk check to PASS. With holder-concentration, liquidity-lock, and sellability unevidenced, the daemon records BLOCKED_RISK audit events instead of fills — that blocking is the system working, not a malfunction.</p></div></section>`;
  }
  const pos = p.openPositions.length === 0
    ? `<p class="empty">No open simulated positions (all cash).</p>`
    : `<table><thead><tr><th>Token</th><th class="num">Qty</th><th class="num">Cost</th><th class="num">Mark</th><th class="num">Value</th><th class="num">Unrealized</th></tr></thead><tbody>${p.openPositions.map((x) =>
      `<tr><td class="mono">${esc(shortAddr(x.token))}</td><td class="num">${esc(x.qtyBaseUnits)}</td><td class="num">${esc(x.costBasisLamports)}</td><td class="num">${esc(x.markPrice ?? "—")}</td><td class="num">${esc(x.marketValueLamports ?? "—")}</td><td class="num">${esc(x.unrealizedPnlLamports ?? "—")}</td></tr>`).join("")}</tbody></table>`;
  return `<section id="paper"><h2>Paper trading</h2>${p.emergencyStop ? `<p class="warn">EMERGENCY STOP active — new entries blocked.</p>` : ""}
<div class="cards"><div class="card"><div class="card-label">Equity</div><div class="card-value">${lamports(p.equityLamports)}</div><div class="card-sub">simulated</div></div>
<div class="card"><div class="card-label">Cash</div><div class="card-value">${lamports(p.cashLamports)}</div><div class="card-sub">start ${lamports(p.startLamports)}</div></div>
<div class="card"><div class="card-label">Realized P&L</div><div class="card-value">${lamports(p.realizedPnlLamports)}</div><div class="card-sub">closed fills</div></div></div>${pos}</section>`;
}

function renderPerformance(p: PerformancePanel): string {
  if (p.empty) {
    return `<section id="performance"><h2>Performance</h2><div class="empty-box"><h3>No backtest results yet</h3><p>${esc(p.reason ?? "")}</p></div></section>`;
  }
  const inconclusive = p.verdict !== null && /inconclusive/i.test(p.verdict);
  return `<section id="performance"><h2>Performance <span class="dim">(replay, simulated)</span></h2>
<div class="cards"><div class="card"><div class="card-label">Trades</div><div class="card-value">${p.trades}</div><div class="card-sub">independent closes</div></div>
<div class="card"><div class="card-label">Net P&L</div><div class="card-value">${lamports(p.netPnlLamports)}</div><div class="card-sub">after modeled costs</div></div>
<div class="card"><div class="card-label">Verdict</div><div class="card-value ${inconclusive ? "warn" : ""}" style="font-size:15px">${esc(p.verdict ?? "—")}</div><div class="card-sub">${p.windowStart === null ? "" : `${esc(new Date(p.windowStart).toISOString().slice(0, 10))} → ${p.windowEnd === null ? "" : esc(new Date(p.windowEnd).toISOString().slice(0, 10))}`}</div></div></div>
${inconclusive ? `<p class="warn">Few trades cannot establish an edge — this validates the pipeline, not the strategy.</p>` : ""}</section>`;
}

function renderHealth(h: HealthView, nowMs: number): string {
  const stale = h.dataStale
    ? `<p class="warn">DATA STALE — last update ${h.lastUpdateTs === null ? "never" : fmtAge(nowMs - h.lastUpdateTs) + " ago"}. Do not treat as current.</p>`
    : `<p class="ok">Data current — last update ${h.lastUpdateTs === null ? "never" : fmtAge(nowMs - h.lastUpdateTs) + " ago"}.</p>`;
  const checks = h.selfCheck.checks.map((c) =>
    `<details><summary>${c.ok ? '<span class="ok">●</span>' : '<span class="bad">●</span>'} ${esc(c.name)}</summary><p class="note">${esc(c.detail)}</p></details>`).join("");
  const gaps = h.gaps.length === 0
    ? `<p class="ok">No gaps — continuous coverage since first poll.</p>`
    : `<p class="warn">${h.gaps.length} disclosed gap(s) — outage windows, never interpolated.</p><table><thead><tr><th>Start</th><th>End</th><th>Kind</th><th>Reason</th></tr></thead><tbody>${h.gaps.slice(0, 10).map((g) =>
      `<tr><td class="mono">${esc(new Date(g.gapStart).toISOString())}</td><td class="mono">${esc(new Date(g.gapEnd).toISOString())}</td><td>${esc(g.kind)}</td><td>${esc(g.reason)}</td></tr>`).join("")}</tbody></table>`;
  return `<section id="health"><h2>System health</h2>${stale}
<p>Recorder: <strong class="${h.recorderStatus === "RUNNING" ? "ok" : "warn"}">${esc(h.recorderStatus)}</strong> <span class="note">— ${esc(h.recorderDetail)}</span></p>
<p class="note">${h.counts.observations} obs · ${h.counts.heartbeats} heartbeats · ${h.counts.fetchEvents} fetches · ${h.counts.gaps} gaps</p>
<h3>Safety self-check: ${h.selfCheck.ok ? '<span class="ok">PASS</span>' : '<span class="bad">FAIL</span>'}</h3>${checks}
<h3>Gaps</h3>${gaps}</section>`;
}

function renderActivity(a: ActivityView): string {
  const rows = a.fetchEvents.slice(0, 15).map((f) =>
    `<tr><td class="num">${f.pollId}</td><td class="mono">${esc(new Date(f.ts).toISOString().slice(11, 19))}</td><td>${esc(f.provider)}</td><td class="num">${f.statusCode === null ? "—" : f.statusCode}</td><td class="num">${f.latencyMs}</td><td class="num">${f.obsCount}</td><td>${f.error === null ? '<span class="na">—</span>' : esc(f.error.slice(0, 60))}</td></tr>`).join("");
  return `<section id="activity"><h2>Activity &amp; audit</h2><p class="note">${esc(a.note)}</p>
<table><thead><tr><th class="num">Poll</th><th>Time</th><th>Provider</th><th class="num">HTTP</th><th class="num">Latency</th><th class="num">Obs</th><th>Error</th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="empty">No fetch events recorded yet.</td></tr>'}</tbody></table></section>`;
}

export function renderSnapshotHtml(d: DashboardView): string {
  const nowMs = d.generatedAt;
  const mints: { mint: string; label: string }[] = [...new Map(d.scanner.rows.map((r) => [r.mint, { mint: r.mint, label: shortAddr(r.mint) }])).values()];
  const staleBanner = d.health.dataStale
    ? `<div class="banner warn">STALE DATA — last update ${d.health.lastUpdateTs === null ? "never" : fmtAge(nowMs - d.health.lastUpdateTs) + " ago"}. Figures below are historical records, not current prices.</div>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Solsnipe terminal (PAPER)</title>
<style>
:root{--bg:#0b0e11;--panel:#11161c;--panel2:#151c25;--border:#1f2937;--ink:#e5e9f0;--dim:#8b98ab;--green:#4ade80;--red:#f87171;--amber:#fbbf24;--blue:#60a5fa;--pink:#f472b6}
*{box-sizing:border-box}body{background:var(--bg);color:var(--ink);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;margin:0;font-size:13px;line-height:1.45}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.dim{color:var(--dim)}.note{color:var(--dim);font-size:12px}.na{color:#556}.ok{color:var(--green)}.bad{color:var(--red)}.warn{color:var(--amber)}.fresh{color:var(--green)}.stale{color:var(--amber)}
.app{display:flex;min-height:100vh}
.sidebar{width:200px;flex-shrink:0;background:var(--panel);border-right:1px solid var(--border);padding:16px 12px;position:sticky;top:0;height:100vh}
.brand{font-weight:800;font-size:16px;letter-spacing:.5px;margin-bottom:2px}.brand span{color:var(--green)}
.brand-sub{color:var(--dim);font-size:11px;margin-bottom:16px}
.nav a{display:block;color:var(--dim);text-decoration:none;padding:7px 10px;border-radius:6px;font-size:13px}
.nav a:hover{background:var(--panel2);color:var(--ink)}
.main{flex:1;min-width:0;padding:0 20px 40px}
.topbar{display:flex;gap:10px;align-items:center;position:sticky;top:0;background:var(--bg);padding:12px 0;border-bottom:1px solid var(--border);z-index:5;flex-wrap:wrap}
.pill{font-size:11px;font-weight:700;padding:3px 10px;border-radius:999px;border:1px solid var(--border)}
.pill.paper{background:#0a2a12;border-color:#2c7a3f;color:var(--green)}
.pill.stale{background:#2a1f0a;border-color:#7a5a2c;color:var(--amber)}
.pill.ok{background:#0a2a12;border-color:#2c7a3f;color:var(--green)}
.topbar .spacer{flex:1}.topbar .meta{color:var(--dim);font-size:12px}
.banner{padding:8px 14px;font-size:12px;font-weight:600}.banner.warn{background:#2a1f0a;color:var(--amber);border-bottom:1px solid #7a5a2c}
section{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin:16px 0}
h2{font-size:13px;text-transform:uppercase;letter-spacing:1px;color:var(--dim);margin:0 0 12px}h3{font-size:13px;margin:14px 0 6px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:4px}
.card{background:var(--panel2);border:1px solid var(--border);border-radius:8px;padding:10px 12px}
.card-label{font-size:11px;color:var(--dim)}.card-value{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums}.card-value.warn{color:var(--amber)}.card-sub{font-size:11px;color:var(--dim)}
table{border-collapse:collapse;width:100%;margin:8px 0;font-size:12px}
th,td{padding:6px 8px;text-align:left;border-bottom:1px solid var(--border);vertical-align:top}
th{color:var(--dim);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.4px}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
tbody tr:hover{background:var(--panel2)}
.chart{width:100%;height:auto;background:var(--panel2);border:1px solid var(--border);border-radius:8px}
.chart-t{fill:var(--dim);font-size:9px}.chart-empty{padding:20px;color:var(--dim);font-style:italic}
.toolbar{display:flex;gap:8px;margin:8px 0}
.toolbar input,.toolbar select{background:var(--panel2);border:1px solid var(--border);color:var(--ink);border-radius:6px;padding:6px 10px;font-size:12px}
.toolbar input{flex:1}
.badge{font-size:11px;font-weight:700;padding:2px 9px;border-radius:999px;border:1px solid var(--border)}
.badge.ok{background:#0a2a12;border-color:#2c7a3f;color:var(--green)}
.badge.bad{background:#2a0f0f;border-color:#7a2c2c;color:var(--red)}
.badge.warn{background:#2a1f0a;border-color:#7a5a2c;color:var(--amber)}
.cand-list{display:grid;gap:10px}.cand{background:var(--panel2);border:1px solid var(--border);border-radius:8px;padding:10px 12px}
.cand header{margin-bottom:4px}.cand p{margin:4px 0;font-size:12px}
.empty{color:var(--dim);font-style:italic}.empty-box{background:var(--panel2);border:1px dashed var(--border);border-radius:8px;padding:16px}
.empty-box h3{margin-top:0}
details{border:1px solid var(--border);border-radius:6px;padding:6px 10px;margin:4px 0}summary{cursor:pointer;font-size:12px}
@media(max-width:760px){.sidebar{display:none}.main{padding:0 12px 32px}}
</style></head><body>
<div class="app"><nav class="sidebar"><div class="brand">SOL<span>SNIPE</span></div><div class="brand-sub">memecoin intelligence · paper only</div>
<div class="nav"><a href="#overview">Overview</a><a href="#scanner">Scanner</a><a href="#candidates">Candidates</a><a href="#paper">Paper trading</a><a href="#performance">Performance</a><a href="#health">System</a><a href="#activity">Audit</a></div></nav>
<div class="main"><div class="topbar"><span class="pill paper">PAPER MODE</span><span class="pill ${d.health.dataStale ? "stale" : "ok"}">${d.health.dataStale ? "STALE" : "FRESH"}</span><span class="pill">${esc(d.health.recorderStatus)}</span><span class="spacer"></span><span class="meta">updated ${esc(new Date(nowMs).toISOString())}</span></div>
${staleBanner}
${renderOverview(d, nowMs, mints)}
${renderScanner(d, nowMs)}
${renderCandidates(d)}
${renderPortfolio(d.portfolio)}
${renderPerformance(d.performance)}
${renderHealth(d.health, nowMs)}
${renderActivity(d.activity)}
</div></div>
<script>
(function(){
var q=document.getElementById('scan-search'),s=document.getElementById('scan-sort'),tb=document.querySelector('#scan-table tbody');
if(!q||!s||!tb)return;
var rows=Array.prototype.slice.call(tb.rows);
function num(cell){var t=cell.textContent.replace(/[^0-9.eE+-]/g,'');var n=parseFloat(t);return isFinite(n)?n:-Infinity;}
function apply(){
var f=q.value.toLowerCase();
rows.forEach(function(r){r.style.display=r.getAttribute('data-search').indexOf(f)>=0?'':'none';});
var vis=rows.filter(function(r){return r.style.display!=='none';});
var k=s.value;
vis.sort(function(a,b){
var c=a.cells,b2=b.cells;
switch(k){
case 'liq-desc':return num(b2[3])-num(c[3]);
case 'liq-asc':return num(c[3])-num(b2[3]);
case 'vol-desc':return num(b2[4])-num(c[4]);
case 'vol-asc':return num(c[4])-num(b2[4]);
case 'chg-desc':return num(b2[5])-num(c[5]);
case 'chg-asc':return num(c[5])-num(b2[5]);
case 'age-asc':return a.getAttribute('data-idx')<b.getAttribute('data-idx')?-1:1;
default:return 0;
}});
vis.forEach(function(r){tb.appendChild(r);});
}
q.addEventListener('input',apply);s.addEventListener('change',apply);
})();
</script>
</body></html>`;
}
