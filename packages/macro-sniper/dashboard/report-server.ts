#!/usr/bin/env tsx
/**
 * Macro Sniper Web Dashboard
 *
 * Usage: node --env-file=.env --import tsx dashboard/report-server.ts
 * Access: http://149.28.17.145/
 */

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { analysisResults, generatedReports, positions, positionTrades, riskState, yieldSnapshots } from "../src/db/schema.js";

runMigrations();

const PORT = Number(process.env.DASHBOARD_PORT ?? 80);
const DIR = new URL(".", import.meta.url).pathname;

/* ─── DB helpers ─────────────────────────────────── */

function latestSignal(db: ReturnType<typeof getDb>, type: string) {
	const r = db.select().from(analysisResults).where(eq(analysisResults.type, type)).orderBy(desc(analysisResults.date)).limit(1).all()[0];
	if (!r) return null;
	return { signal: r.signal, date: r.date, meta: typeof r.metadata === "string" ? JSON.parse(r.metadata) : r.metadata };
}

/* ─── Markdown → HTML ────────────────────────────── */

function inline(t: string) {
	return t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/__(.+?)__/g, "<strong>$1</strong>");
}

function mdToHtml(md: string): string {
	const lines = md.split("\n");
	const out: string[] = [];
	let tbl: string[][] = [];
	let inTbl = false;

	function flushTbl() {
		if (tbl.length < 2) { inTbl = false; tbl = []; return; }
		const hd = tbl[0];
		const bd = tbl.slice(2);
		let h = '<div class="tbl-wrap"><table><thead><tr>';
		for (const c of hd) h += `<th>${inline(c.trim())}</th>`;
		h += "</tr></thead><tbody>";
		for (const row of bd) {
			h += "<tr>";
			for (let i = 0; i < hd.length; i++) {
				const c = row[i]?.trim() ?? "";
				let cls = "";
				if (/^\+|^\$\+|risk_on|expanding|bullish|Long/.test(c)) cls = ' class="c-g"';
				else if (/^-[0-9$]|^\$-|risk_off|contracting|bearish|flat/.test(c)) cls = ' class="c-r"';
				h += `<td${cls}>${inline(c)}</td>`;
			}
			h += "</tr>";
		}
		h += "</tbody></table></div>";
		out.push(h);
		inTbl = false; tbl = [];
	}

	for (const line of lines) {
		if (line.includes("|") && line.trim().startsWith("|")) {
			if (!inTbl) inTbl = true;
			tbl.push(line.split("|").slice(1, -1));
			continue;
		}
		if (inTbl) flushTbl();
		out.push(line);
	}
	if (inTbl) flushTbl();

	return inline(out.join("\n")
		.replace(/^#{4}\s+(.+)$/gm, '<h4>$1</h4>')
		.replace(/^#{3}\s+(.+)$/gm, '<div class="sec-hd">$1</div>')
		.replace(/^#{2}\s+(.+)$/gm, '<h2>$1</h2>')
		.replace(/^#{1}\s+(.+)$/gm, '<h1 class="rpt-title">$1</h1>')
		.replace(/^---+$/gm, '')
		.replace(/^\*\s+(.+)$/gm, "<li>$1</li>")
		.replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>")
		.replace(/\n\n/g, "</p><p>")
		.replace(/\n/g, "<br>"));
}

/* ─── CSS ────────────────────────────────────────── */

const CSS = /*css*/`
:root{--bg:#0a0e14;--s1:#131820;--s2:#1a2030;--s3:#222a38;--bd:#2a3245;--tx:#e2e8f0;--tx2:#8892a4;--ac:#60a5fa;--gn:#34d399;--rd:#f87171;--yl:#fbbf24;--pp:#a78bfa;--or:#fb923c;--cy:#22d3ee}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--tx);font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;line-height:1.65}
a{color:var(--ac);text-decoration:none}a:hover{text-decoration:underline}

/* Nav */
.nav{background:linear-gradient(180deg,var(--s1),var(--s2));border-bottom:1px solid var(--bd);padding:0 24px;position:sticky;top:0;z-index:100;display:flex;align-items:center;height:52px;gap:20px;backdrop-filter:blur(12px)}
.nav-brand{font-size:17px;font-weight:800;letter-spacing:-.3px;background:linear-gradient(135deg,var(--ac),var(--pp));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.nav-sep{color:var(--bd);font-size:18px}
.nav a{font-size:13px;font-weight:600;color:var(--tx2);padding:14px 0;border-bottom:2px solid transparent;transition:all .2s}
.nav a:hover,.nav a.on{color:var(--tx);text-decoration:none;border-bottom-color:var(--ac)}

.wrap{max-width:1080px;margin:0 auto;padding:20px}

/* Hero */
.hero{display:grid;grid-template-columns:1fr auto;gap:20px;padding:24px;background:linear-gradient(135deg,var(--s1),var(--s2));border:1px solid var(--bd);border-radius:16px;margin-bottom:20px}
.hero-signal{font-size:42px;font-weight:800;line-height:1}
.hero-conf{font-size:14px;color:var(--tx2);margin-top:6px}
.hero-date{font-size:28px;font-weight:700;color:var(--tx2)}
.hero-model{font-size:12px;margin-top:4px}

/* Signal strip */
.sig-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin-bottom:16px}
.sig-card{background:var(--s1);border:1px solid var(--bd);border-radius:10px;padding:10px 12px;text-align:center;position:relative;overflow:hidden}
.sig-card::after{content:'';position:absolute;bottom:0;left:0;right:0;height:3px}
.sig-card.sg::after{background:var(--gn)}.sig-card.sr::after{background:var(--rd)}.sig-card.sy::after{background:var(--yl)}.sig-card.sn::after{background:var(--bd)}
.sig-label{font-size:11px;color:var(--tx2);text-transform:uppercase;letter-spacing:.5px}
.sig-val{font-size:15px;font-weight:700;margin-top:2px}

/* Cards */
.card{background:var(--s1);border:1px solid var(--bd);border-radius:12px;padding:16px;margin-bottom:12px}
.card-hd{font-size:11px;color:var(--tx2);text-transform:uppercase;letter-spacing:.6px;margin-bottom:10px}
.grid{display:grid;gap:12px}.g2{grid-template-columns:1fr 1fr}.g3{grid-template-columns:1fr 1fr 1fr}.g4{grid-template-columns:repeat(4,1fr)}.g5{grid-template-columns:repeat(5,1fr)}.g6{grid-template-columns:repeat(6,1fr)}

/* Positions */
.pos{background:var(--s2);border:1px solid var(--bd);border-radius:10px;padding:14px;border-left:4px solid var(--bd)}
.pos.pg{border-left-color:var(--gn)}.pos.pl{border-left-color:var(--rd)}
.pos-sym{font-size:15px;font-weight:700}
.pos-dir{font-size:11px;color:var(--tx2);background:var(--s3);padding:1px 8px;border-radius:8px;margin-left:6px}
.pos-row{display:flex;justify-content:space-between;margin-top:6px;font-size:13px;color:var(--tx2)}
.pos-pnl{font-size:20px;font-weight:800;margin-top:4px}

/* Gauges */
.gauge{height:6px;background:var(--s3);border-radius:3px;overflow:hidden;margin:6px 0}
.gauge-fill{height:100%;border-radius:3px;transition:width .4s}
.gauge-center{position:relative}.gauge-center::after{content:'';position:absolute;left:50%;top:-2px;width:2px;height:10px;background:var(--tx2);transform:translateX(-1px)}

/* Metrics */
.metric{text-align:center}
.metric-val{font-size:22px;font-weight:800}
.metric-label{font-size:11px;color:var(--tx2);margin-top:2px}
.metric-sub{font-size:12px;color:var(--tx2)}

/* Yield curve vis */
.yc-bar{display:flex;height:32px;border-radius:6px;overflow:hidden;margin:8px 0}
.yc-bar div{display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--bg)}

/* Heatmap */
.hm{display:grid;gap:2px;font-size:11px;text-align:center}
.hm-cell{padding:6px 4px;border-radius:4px;font-weight:600}

/* Report content */
.rpt{margin-top:20px}
.rpt .rpt-title{font-size:20px;margin:24px 0 10px;padding-bottom:8px;border-bottom:2px solid var(--bd)}
.rpt .rpt-title:first-child{margin-top:0}
.rpt h2{font-size:17px;color:var(--ac);margin:20px 0 8px}
.rpt .sec-hd{font-size:15px;font-weight:700;color:var(--yl);margin:24px 0 10px;padding:12px 16px;background:var(--s2);border:1px solid var(--bd);border-radius:10px;border-left:4px solid var(--yl)}
.rpt h4{font-size:13px;color:var(--tx2)}
.rpt p{margin:6px 0}.rpt strong{color:#fff}.rpt hr{display:none}
.rpt ul{margin:6px 0 6px 18px}.rpt li{margin:3px 0}.rpt li::marker{color:var(--ac)}
.tbl-wrap{overflow-x:auto;margin:12px 0}
table{width:100%;border-collapse:separate;border-spacing:0;font-size:12px;background:var(--s2);border-radius:8px;overflow:hidden}
th{text-align:left;color:var(--ac);font-weight:700;padding:10px 12px;background:var(--s3);border-bottom:2px solid var(--bd);white-space:nowrap;font-size:11px;text-transform:uppercase;letter-spacing:.3px}
td{padding:8px 12px;border-bottom:1px solid rgba(42,50,69,.5);font-variant-numeric:tabular-nums}
tr:hover td{background:rgba(96,165,250,.04)}
.c-g{color:var(--gn)}.c-r{color:var(--rd)}.c-y{color:var(--yl)}

/* List */
.rpt-list{list-style:none}
.rpt-list li{border-bottom:1px solid var(--bd)}
.rpt-list a{display:flex;justify-content:space-between;align-items:center;padding:16px 20px;color:var(--tx);transition:background .15s}
.rpt-list a:hover{background:rgba(96,165,250,.05);text-decoration:none}
.rpt-dt{font-size:17px;font-weight:700}.rpt-info{display:flex;gap:12px;align-items:center;color:var(--tx2);font-size:13px}
.badge{display:inline-block;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:700}
.b-cl{background:rgba(167,139,250,.12);color:var(--pp)}.b-gm{background:rgba(52,211,153,.12);color:var(--gn)}

/* Nav links */
.rpt-nav{display:flex;justify-content:space-between;padding:16px 0;margin-top:20px;border-top:1px solid var(--bd)}

footer{text-align:center;color:var(--tx2);font-size:11px;padding:24px;letter-spacing:.3px}
@media(max-width:800px){.g2,.g3,.g4,.g5,.g6{grid-template-columns:1fr}.hero{grid-template-columns:1fr}.sig-strip{grid-template-columns:repeat(2,1fr)}}
`;

/* ─── Components ─────────────────────────────────── */

function nav(active: string) {
	const links = [
		["/", "📋 日报列表", "list"],
		["/latest", "📰 最新日报", "latest"],
		["/positions", "📦 持仓交易", "positions"],
		["/usd-model-live.html", "💵 USD看板", "usd"],
	];
	return `<div class="nav"><span class="nav-brand">Macro Sniper</span><span class="nav-sep">|</span>${links.map(([h, l, k]) => `<a href="${h}" class="${active === k ? "on" : ""}">${l}</a>`).join("")}</div>`;
}

function pg(title: string, body: string, n: string, head = "") {
	return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — Macro Sniper</title><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet"><script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"><\/script><style>${CSS}</style>${head}</head><body>${n}<div class="wrap">${body}</div><footer>Macro Sniper · Claude + FRED + Binance + Alpaca · 每日 08:00 ET</footer></body></html>`;
}

function sigClass(s: string) {
	if (/risk_on|expanding|bullish|bull_/.test(s)) return "sg";
	if (/risk_off|contracting|bearish|bear_/.test(s)) return "sr";
	if (s === "conflicted") return "sy";
	return "sn";
}

function gaugeBar(val: number, max: number, color: string) {
	const pct = Math.min(100, Math.max(0, (val / max) * 100));
	return `<div class="gauge gauge-center"><div class="gauge-fill" style="width:${pct}%;background:${color}"></div></div>`;
}

function corrColor(v: number): string {
	if (v > 0.7) return "rgba(52,211,153,.3)";
	if (v > 0.3) return "rgba(52,211,153,.15)";
	if (v < -0.3) return "rgba(248,113,113,.25)";
	if (v < 0) return "rgba(248,113,113,.1)";
	return "rgba(136,146,164,.1)";
}

/* ─── Route: Report list ─────────────────────────── */

function handleList() {
	const db = getDb();
	const rows = db.select({ id: generatedReports.id, date: generatedReports.date, model: generatedReports.model, createdAt: generatedReports.createdAt, len: sql<number>`length(${generatedReports.content})` }).from(generatedReports).where(eq(generatedReports.reportType, "daily")).orderBy(desc(generatedReports.id)).all();
	const seen = new Set<string>();
	const uniq = rows.filter(r => { if (seen.has(r.date)) return false; seen.add(r.date); return true; });
	const bias = latestSignal(db, "market_bias");
	const items = uniq.map(r => {
		const b = r.model.includes("claude") ? '<span class="badge b-cl">Claude</span>' : '<span class="badge b-gm">Gemini</span>';
		return `<li><a href="/report/${r.id}"><span class="rpt-dt">📋 ${r.date}</span><span class="rpt-info">${b}<span>${r.createdAt.substring(11, 16)} UTC</span><span>${(r.len / 1024).toFixed(1)}KB</span></span></a></li>`;
	}).join("");

	return pg("日报列表", `
		<div style="display:flex;align-items:center;gap:16px;margin:20px 0 8px">
			<h1 style="font-size:24px;font-weight:800">宏观投研日报</h1>
			${bias ? `<span class="sig-card ${sigClass(bias.signal)}" style="display:inline-block;padding:4px 16px">${bias.signal}</span>` : ""}
		</div>
		<p style="color:var(--tx2);margin-bottom:16px">共 ${uniq.length} 份日报 · 每日 08:00 ET 自动生成</p>
		<div class="card" style="padding:0;overflow:hidden"><ul class="rpt-list">${items}</ul></div>
	`, nav("list"));
}

/* ─── Route: Report detail ───────────────────────── */

function handleReport(id: number): string | null {
	const db = getDb();
	const row = db.select().from(generatedReports).where(eq(generatedReports.id, id)).limit(1).all()[0];
	if (!row) return null;

	const modelBdg = row.model.includes("claude") ? '<span class="badge b-cl">Claude Opus</span>' : '<span class="badge b-gm">Gemini Flash</span>';

	// ── Signals ──
	const sigs = ["market_bias", "liquidity_signal", "yield_curve", "credit_risk", "sentiment_signal", "btc_signal", "funding_stress", "auction_health"].map(t => {
		const r = latestSignal(db, t);
		const labels: Record<string, string> = { market_bias: "🎯 偏向", liquidity_signal: "💧 流动性", yield_curve: "📈 曲线", credit_risk: "🛡️ 信用", sentiment_signal: "🌡️ 情绪", btc_signal: "₿ BTC", funding_stress: "🏦 资金", auction_health: "🏛️ 拍卖" };
		return r ? `<div class="sig-card ${sigClass(r.signal)}"><div class="sig-label">${labels[t] ?? t}</div><div class="sig-val">${r.signal}</div></div>` : "";
	}).join("");

	// ── Positions ──
	const posRows = db.select().from(positions).all().filter(p => p.direction !== "flat" && p.quantity > 0);
	const totalPnl = posRows.reduce((s, p) => s + p.unrealizedPnl, 0);
	const totalCost = posRows.reduce((s, p) => s + p.avgCost * p.quantity, 0);
	const posCards = posRows.map(p => {
		const pct = p.avgCost > 0 ? (p.unrealizedPnl / (p.avgCost * p.quantity)) * 100 : 0;
		const s = p.unrealizedPnl >= 0 ? "+" : "";
		return `<div class="pos ${p.unrealizedPnl >= 0 ? "pg" : "pl"}">
			<div><span class="pos-sym">${p.symbol}</span><span class="pos-dir">${p.direction}</span></div>
			<div class="pos-row"><span>${p.quantity.toFixed(4)} @ $${p.avgCost.toFixed(2)}</span><span>${p.openedAt ? p.openedAt.split("T")[0] : "—"}</span></div>
			<div class="pos-pnl ${p.unrealizedPnl >= 0 ? "c-g" : "c-r"}">${s}$${p.unrealizedPnl.toFixed(2)} <span style="font-size:13px;font-weight:600">(${s}${pct.toFixed(2)}%)</span></div>
		</div>`;
	}).join("");

	// ── Key metrics from analysis ──
	const liq = latestSignal(db, "liquidity_signal");
	const yc = latestSignal(db, "yield_curve");
	const sent = latestSignal(db, "sentiment_signal");
	const usdM = latestSignal(db, "usd_model");
	const btc = latestSignal(db, "btc_signal");
	const corr = latestSignal(db, "correlation_matrix");
	const fund = latestSignal(db, "funding_stress");
	const bias = latestSignal(db, "market_bias");

	// Liquidity waterfall
	const lm = liq?.meta;
	const liqHtml = lm ? `
		<div class="card"><div class="card-hd">💧 流动性构成 (百万美元)</div>
		<div class="grid g4" style="text-align:center;margin-top:8px">
			<div class="metric"><div class="metric-val" style="color:var(--ac)">${(lm.fed_total_assets / 1e6).toFixed(2)}T</div><div class="metric-label">Fed 总资产</div></div>
			<div class="metric"><div class="metric-val" style="color:var(--or)">−${(lm.tga / 1e6).toFixed(2)}T</div><div class="metric-label">TGA</div></div>
			<div class="metric"><div class="metric-val" style="color:var(--rd)">−${(lm.on_rrp / 1e6).toFixed(4)}T</div><div class="metric-label">ON RRP</div></div>
			<div class="metric"><div class="metric-val" style="color:var(--gn)">${(lm.net_liquidity / 1e6).toFixed(2)}T</div><div class="metric-label">净流动性</div><div class="metric-sub">${lm.net_liquidity_7d_change > 0 ? "+" : ""}${(lm.net_liquidity_7d_change / 100).toFixed(1)}亿 7d</div></div>
		</div></div>` : "";

	// Yield curve with Chart.js
	const ym = yc?.meta;
	// Fetch historical yield data for chart
	const ycSeries = ["DGS2", "DGS5", "DGS10", "DGS20", "DGS30"];
	const ycLabels = ["2Y", "5Y", "10Y", "20Y", "30Y"];
	const ycHistData: Record<string, { date: string; value: number }[]> = {};
	const since30d = new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
	for (const s of ycSeries) {
		ycHistData[s] = db.select({ date: yieldSnapshots.dataDate, value: yieldSnapshots.value }).from(yieldSnapshots)
			.where(and(eq(yieldSnapshots.seriesId, s), gte(yieldSnapshots.dataDate, since30d)))
			.orderBy(asc(yieldSnapshots.dataDate)).all();
	}
	// Current curve points for shape chart
	const curvePoints = ycSeries.map(s => {
		const rows = ycHistData[s];
		return rows.length > 0 ? rows[rows.length - 1].value : null;
	});
	// Previous curve (5 days ago) for comparison
	const prevPoints = ycSeries.map(s => {
		const rows = ycHistData[s];
		return rows.length > 5 ? rows[rows.length - 6].value : rows.length > 0 ? rows[0].value : null;
	});
	// Unique dates for time series
	const ycDates = [...new Set(Object.values(ycHistData).flatMap(rows => rows.map(r => r.date)))].sort();

	const chartData = JSON.stringify({
		curvePoints, prevPoints, ycLabels,
		timeSeries: {
			dates: ycDates.map(d => d.slice(5)),
			series: ycSeries.map((s, i) => ({ label: ycLabels[i], data: ycDates.map(d => ycHistData[s].find(r => r.date === d)?.value ?? null) }))
		}
	});

	const ycHtml = ym ? `
		<div class="card"><div class="card-hd">📈 收益率曲线 — <span style="color:${sigClass(yc?.signal ?? "") === "sg" ? "var(--gn)" : sigClass(yc?.signal ?? "") === "sr" ? "var(--rd)" : "var(--yl)"}">${yc?.signal}</span></div>
		<div class="grid g5" style="text-align:center;margin:8px 0">
			${[["2Y", ym.dgs2], ["10Y", ym.dgs10], ["20Y", ym.dgs20], ["30Y", ym.dgs30]].map(([l, v]) => `<div class="metric"><div class="metric-val">${v != null ? (v as number).toFixed(2) : "—"}%</div><div class="metric-label">${l}</div></div>`).join("")}
			<div class="metric"><div class="metric-val" style="color:var(--yl)">${ym.spread_10s2s != null ? (ym.spread_10s2s * 100).toFixed(0) : "—"}bp</div><div class="metric-label">10s2s</div><div class="metric-sub">2Y Δ5d ${ym.delta_5d_2y_bps > 0 ? "+" : ""}${ym.delta_5d_2y_bps?.toFixed(0)}bp</div></div>
		</div>
		<div class="grid g2" style="margin-top:12px">
			<div><div style="font-size:11px;color:var(--tx2);margin-bottom:4px">曲线形态 (今日 vs 5日前)</div><div style="height:180px"><canvas id="ycShape"></canvas></div></div>
			<div><div style="font-size:11px;color:var(--tx2);margin-bottom:4px">利率走势</div><div style="height:180px"><canvas id="ycHist"></canvas></div></div>
		</div>
		<script>
		(function(){
			const D=${chartData};
			const colors=['#60a5fa','#22d3ee','#fbbf24','#fb923c','#f87171'];
			// Shape chart
			new Chart(document.getElementById('ycShape'),{type:'line',data:{labels:D.ycLabels,datasets:[
				{label:'今日',data:D.curvePoints,borderColor:'#60a5fa',borderWidth:3,pointRadius:5,pointBackgroundColor:'#60a5fa',tension:.3,fill:false},
				{label:'5日前',data:D.prevPoints,borderColor:'rgba(136,146,164,.5)',borderWidth:2,borderDash:[5,3],pointRadius:3,pointBackgroundColor:'rgba(136,146,164,.5)',tension:.3,fill:false}
			]},options:{responsive:true,maintainAspectRatio:false,scales:{y:{grid:{color:'rgba(42,50,69,.5)'},ticks:{color:'#8892a4',callback:v=>v+'%'}},x:{grid:{color:'rgba(42,50,69,.3)'},ticks:{color:'#8892a4'}}},plugins:{legend:{labels:{color:'#e2e8f0',usePointStyle:true,pointStyle:'circle',boxWidth:6}}}}});
			// History chart
			new Chart(document.getElementById('ycHist'),{type:'line',data:{labels:D.timeSeries.dates,datasets:D.timeSeries.series.map((s,i)=>({label:s.label,data:s.data,borderColor:colors[i],borderWidth:2,pointRadius:2,tension:.3,spanGaps:true}))},options:{responsive:true,maintainAspectRatio:false,scales:{y:{grid:{color:'rgba(42,50,69,.5)'},ticks:{color:'#8892a4',callback:v=>v+'%'}},x:{grid:{color:'rgba(42,50,69,.3)'},ticks:{color:'#8892a4',maxTicksLimit:8}}},plugins:{legend:{labels:{color:'#e2e8f0',usePointStyle:true,pointStyle:'circle',boxWidth:6}}}}});
		})();
		</script>
		</div>` : "";

	// USD model factors
	const um = usdM?.meta;
	const usdHtml = um ? `
		<div class="card"><div class="card-hd">💵 USD 5因子模型 — 综合 ${um.composite_score?.toFixed(1)} — DXY ${um.dxy}</div>
		${[
			["利率支撑 r_f", um.rate_support_score, 100, "var(--ac)"],
			["风险溢价 π_risk", um.risk_premium_score, 100, "var(--or)"],
			["便利收益 cy", um.convenience_yield_score, 100, "var(--pp)"],
			["对冲传导", um.hedge_transmission_score, 100, "var(--cy)"],
			["全球相对", um.global_relative_score, 100, "var(--yl)"],
		].map(([name, val, max, color]) => `
			<div style="display:flex;align-items:center;gap:10px;padding:4px 0">
				<span style="width:90px;font-size:12px;color:var(--tx2)">${name}</span>
				<span style="width:40px;text-align:right;font-weight:700;font-size:14px;color:${color}">${(val as number)?.toFixed(0)}</span>
				<div style="flex:1">${gaugeBar(val as number, max as number, color as string)}</div>
			</div>`).join("")}
		</div>` : "";

	// Sentiment
	const sm = sent?.meta;
	const sentHtml = sm ? `
		<div class="card"><div class="card-hd">🌡️ 情绪面 — 综合 ${sm.composite_score?.toFixed(1)}</div>
		<div class="grid g3" style="text-align:center;margin-top:8px">
			<div class="metric"><div class="metric-val" style="color:${sm.vix > 25 ? "var(--rd)" : sm.vix < 15 ? "var(--gn)" : "var(--yl)"}">${sm.vix?.toFixed(1)}</div><div class="metric-label">VIX</div></div>
			<div class="metric"><div class="metric-val">${sm.move?.toFixed(1)}</div><div class="metric-label">MOVE</div></div>
			<div class="metric"><div class="metric-val" style="color:${sm.fear_greed_index < 25 ? "var(--rd)" : sm.fear_greed_index > 75 ? "var(--gn)" : "var(--yl)"}; font-size:28px">${sm.fear_greed_index}</div><div class="metric-label">恐惧贪婪</div><div class="metric-sub">${sm.fear_greed_index < 25 ? "极度恐惧" : sm.fear_greed_index < 40 ? "恐惧" : sm.fear_greed_index < 60 ? "中性" : sm.fear_greed_index < 75 ? "贪婪" : "极度贪婪"}</div></div>
		</div></div>` : "";

	// BTC
	const bm = btc?.meta;
	const btcHtml = bm ? `
		<div class="card"><div class="card-hd">₿ BTC 信号 — ${btc?.signal}</div>
		<div class="grid g4" style="text-align:center;margin-top:8px">
			<div class="metric"><div class="metric-val">$${(bm.btc_price / 1000).toFixed(1)}K</div><div class="metric-label">价格</div><div class="metric-sub">${bm.change_pct_24h > 0 ? "+" : ""}${bm.change_pct_24h?.toFixed(1)}% 24h</div></div>
			<div class="metric"><div class="metric-val">${bm.technicals_score?.toFixed(0)}</div><div class="metric-label">技术面</div>${gaugeBar(bm.technicals_score, 100, "var(--ac)")}</div>
			<div class="metric"><div class="metric-val">${bm.derivatives_score?.toFixed(0)}</div><div class="metric-label">衍生品</div>${gaugeBar(bm.derivatives_score, 100, "var(--or)")}</div>
			<div class="metric"><div class="metric-val">${bm.onchain_score?.toFixed(0) ?? "—"}</div><div class="metric-label">链上</div>${gaugeBar(bm.onchain_score ?? 50, 100, "var(--pp)")}</div>
		</div></div>` : "";

	// Correlation heatmap
	const cm = corr?.meta?.window_7d_hourly;
	const corrSyms = ["SPY", "QQQ", "IWM", "BTCUSD", "DXY"];
	const corrHtml = cm ? `
		<div class="card"><div class="card-hd">🔗 7日相关性矩阵 — ${corr?.signal}</div>
		<div class="hm" style="grid-template-columns:60px repeat(${corrSyms.length},1fr);margin-top:8px">
			<div></div>${corrSyms.map(s => `<div style="font-weight:700;color:var(--ac);font-size:11px">${s.replace("USD", "")}</div>`).join("")}
			${corrSyms.map(a => `<div style="font-weight:700;color:var(--ac);font-size:11px;text-align:right;padding-right:8px">${a.replace("USD", "")}</div>${corrSyms.map(b => {
				if (a === b) return `<div class="hm-cell" style="background:var(--s3);color:var(--tx2)">1.00</div>`;
				const v = cm[`${a}_${b}`] ?? cm[`${b}_${a}`] ?? null;
				if (v == null) return `<div class="hm-cell" style="background:var(--s3)">—</div>`;
				const col = v > 0.5 ? "var(--gn)" : v < -0.3 ? "var(--rd)" : "var(--tx)";
				return `<div class="hm-cell" style="background:${corrColor(v)};color:${col}">${v.toFixed(2)}</div>`;
			}).join("")}`).join("")}
		</div></div>` : "";

	// Recent trades
	const trades = db.select().from(positionTrades).orderBy(desc(positionTrades.createdAt)).limit(6).all();
	const tradeHtml = trades.length > 0 ? `
		<div class="card"><div class="card-hd">📝 最近交易</div>
		<div class="tbl-wrap"><table><thead><tr><th>时间</th><th>标的</th><th>操作</th><th>方向</th><th>数量</th><th>价格</th><th>PnL</th></tr></thead><tbody>
		${trades.map(t => {
			const pnl = t.realizedPnl != null ? `<span class="${t.realizedPnl >= 0 ? "c-g" : "c-r"}">${t.realizedPnl >= 0 ? "+" : ""}$${t.realizedPnl.toFixed(2)}</span>` : "—";
			const opColors: Record<string, string> = { open: "var(--gn)", close: "var(--rd)", add: "var(--ac)", reduce: "var(--or)", stop_loss: "var(--rd)", flip: "var(--pp)" };
			return `<tr><td>${t.createdAt.substring(5, 16)}</td><td style="font-weight:700">${t.symbol}</td><td style="color:${opColors[t.operationType] ?? "var(--tx)"}">${t.operationType}</td><td>${t.side}</td><td>${t.quantity.toFixed(4)}</td><td>$${t.price.toFixed(2)}</td><td>${pnl}</td></tr>`;
		}).join("")}
		</tbody></table></div></div>` : "";

	// Conflicts
	const conflicts = bias?.meta?.conflicts ?? [];
	const conflictHtml = conflicts.length > 0 ? `
		<div class="card" style="border-left:4px solid var(--yl)"><div class="card-hd">⚠️ 信号冲突</div>
		${conflicts.map((c: string) => `<p style="margin:4px 0;font-size:13px">• ${c}</p>`).join("")}
		</div>` : "";

	// Position total
	const ts = totalPnl >= 0 ? "+" : "";
	const posSection = posRows.length > 0 ? `
		<div class="card"><div class="card-hd">📦 当前持仓 · 总计 <span class="${totalPnl >= 0 ? "c-g" : "c-r"}" style="font-size:14px;font-weight:700">${ts}$${totalPnl.toFixed(2)} (${ts}${totalCost > 0 ? (totalPnl / totalCost * 100).toFixed(2) : "0.00"}%)</span></div>
		<div class="grid g4" style="margin-top:8px">${posCards}</div></div>` : "";

	// Navigation
	const prev = db.select({ id: generatedReports.id }).from(generatedReports).where(sql`${generatedReports.id} < ${id}`).orderBy(desc(generatedReports.id)).limit(1).all()[0];
	const next = db.select({ id: generatedReports.id }).from(generatedReports).where(sql`${generatedReports.id} > ${id}`).orderBy(generatedReports.id).limit(1).all()[0];

	return pg(`日报 ${row.date}`, `
		<div class="hero">
			<div>
				<div class="hero-signal" style="color:${bias?.signal === "risk_on" ? "var(--gn)" : bias?.signal === "risk_off" ? "var(--rd)" : bias?.signal === "conflicted" ? "var(--yl)" : "var(--tx2)"}">${bias?.signal ?? "—"}</div>
				<div class="hero-conf">置信度: ${bias?.meta?.confidence ?? "—"}</div>
			</div>
			<div style="text-align:right">
				<div class="hero-date">${row.date}</div>
				<div class="hero-model">${modelBdg} · ${row.createdAt.substring(11, 16)} UTC</div>
			</div>
		</div>
		<div class="sig-strip">${sigs}</div>
		${conflictHtml}
		${posSection}
		<div class="grid g2">
			${liqHtml}${ycHtml}
		</div>
		<div class="grid g2">
			${usdHtml}${sentHtml}
		</div>
		<div class="grid g2">
			${btcHtml}${corrHtml}
		</div>
		${tradeHtml}
		<details style="margin-top:16px"><summary style="cursor:pointer;color:var(--ac);font-weight:700;padding:12px 0">📄 展开完整报告文本</summary>
		<div class="rpt card" style="margin-top:8px">${mdToHtml(row.content)}</div></details>
		<div class="rpt-nav">${prev ? `<a href="/report/${prev.id}">← 上一篇</a>` : "<span></span>"}<a href="/">返回列表</a>${next ? `<a href="/report/${next.id}">下一篇 →</a>` : "<span></span>"}</div>
	`, nav("report"));
}

function handleLatest() {
	const db = getDb();
	const r = db.select({ id: generatedReports.id }).from(generatedReports).where(eq(generatedReports.reportType, "daily")).orderBy(desc(generatedReports.id)).limit(1).all()[0];
	if (!r) return pg("无日报", '<p style="color:var(--tx2)">暂无数据</p>', nav("latest"));
	return handleReport(r.id) ?? pg("404", "<h1>Not Found</h1>", nav(""));
}

/* ─── Route: Positions & Trades ───────────────────── */

function handlePositions() {
	const db = getDb();

	// Current positions
	const posRows = db.select().from(positions).all();
	const activePos = posRows.filter(p => p.direction !== "flat" && p.quantity > 0);
	const totalPnl = activePos.reduce((s, p) => s + p.unrealizedPnl, 0);
	const totalCost = activePos.reduce((s, p) => s + p.avgCost * p.quantity, 0);
	const totalMv = activePos.reduce((s, p) => s + p.currentPrice * p.quantity, 0);
	const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;

	// Risk state
	const riskRows = db.select().from(riskState).all();
	const riskMap = new Map(riskRows.map(r => [r.key, r.value]));
	const riskLevel = riskMap.get("risk_level") ?? "normal";
	const portfolioHwm = Number(riskMap.get("portfolio_hwm") ?? "0");
	const drawdown = portfolioHwm > 0 ? ((portfolioHwm - (totalMv + totalCost)) / portfolioHwm * 100) : 0;

	// Position cards with more detail
	const posCardsFull = activePos.map(p => {
		const pct = p.avgCost > 0 ? (p.unrealizedPnl / (p.avgCost * p.quantity)) * 100 : 0;
		const mv = p.currentPrice * p.quantity;
		const s = p.unrealizedPnl >= 0 ? "+" : "";
		const holdDays = p.openedAt ? ((Date.now() - new Date(p.openedAt).getTime()) / 86400000).toFixed(1) : "—";
		return `<div class="pos ${p.unrealizedPnl >= 0 ? "pg" : "pl"}" style="padding:18px">
			<div style="display:flex;justify-content:space-between;align-items:center">
				<div><span class="pos-sym" style="font-size:18px">${p.symbol}</span><span class="pos-dir">${p.direction}</span></div>
				<div class="pos-pnl ${p.unrealizedPnl >= 0 ? "c-g" : "c-r"}" style="font-size:24px">${s}$${p.unrealizedPnl.toFixed(2)}</div>
			</div>
			<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:12px;text-align:center">
				<div><div style="font-size:16px;font-weight:700">${p.quantity.toFixed(4)}</div><div style="font-size:11px;color:var(--tx2)">数量</div></div>
				<div><div style="font-size:16px;font-weight:700">$${p.avgCost.toFixed(2)}</div><div style="font-size:11px;color:var(--tx2)">成本价</div></div>
				<div><div style="font-size:16px;font-weight:700">$${p.currentPrice.toFixed(2)}</div><div style="font-size:11px;color:var(--tx2)">现价</div></div>
				<div><div style="font-size:16px;font-weight:700;color:${p.unrealizedPnl >= 0 ? "var(--gn)" : "var(--rd)"}">${s}${pct.toFixed(2)}%</div><div style="font-size:11px;color:var(--tx2)">盈亏%</div></div>
			</div>
			<div style="display:flex;justify-content:space-between;margin-top:10px;font-size:12px;color:var(--tx2)">
				<span>市值 $${mv.toFixed(2)}</span>
				<span>建仓 ${p.openedAt ? p.openedAt.split("T")[0] : "—"}</span>
				<span>持有 ${holdDays}天</span>
				<span>HWM $${p.highWaterMark?.toFixed(2) ?? "—"}</span>
			</div>
		</div>`;
	}).join("");

	// All trades
	const allTrades = db.select().from(positionTrades).orderBy(desc(positionTrades.createdAt)).all();

	// Stats
	const closedTrades = allTrades.filter(t => t.realizedPnl != null);
	const wins = closedTrades.filter(t => t.realizedPnl! > 0);
	const losses = closedTrades.filter(t => t.realizedPnl! < 0);
	const totalRealizedPnl = closedTrades.reduce((s, t) => s + (t.realizedPnl ?? 0), 0);
	const winRate = closedTrades.length > 0 ? (wins.length / closedTrades.length * 100) : 0;
	const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.realizedPnl!, 0) / wins.length : 0;
	const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.realizedPnl!, 0) / losses.length : 0;
	const profitFactor = Math.abs(avgLoss) > 0 ? Math.abs(avgWin / avgLoss) : 0;

	// Per-symbol PnL
	const symPnl: Record<string, { pnl: number; trades: number; wins: number }> = {};
	for (const t of closedTrades) {
		if (!symPnl[t.symbol]) symPnl[t.symbol] = { pnl: 0, trades: 0, wins: 0 };
		symPnl[t.symbol].pnl += t.realizedPnl!;
		symPnl[t.symbol].trades++;
		if (t.realizedPnl! > 0) symPnl[t.symbol].wins++;
	}

	const opIcons: Record<string, string> = { open: "🟢", close: "🔴", add: "📈", reduce: "📉", flip: "🔄", stop_loss: "🚨", btc_crash: "⚠️" };
	const opColors: Record<string, string> = { open: "var(--gn)", close: "var(--rd)", add: "var(--ac)", reduce: "var(--or)", stop_loss: "var(--rd)", flip: "var(--pp)", btc_crash: "var(--yl)" };
	const triggerLabels: Record<string, string> = {
		daily_pipeline: "📅 每日流水线",
		hourly_btc: "⏰ 每小时BTC",
		stop_loss: "🚨 止损触发",
		btc_crash: "⚠️ BTC急跌联动",
		manual: "🔧 手动操作",
	};

	function buildTriggerDetail(t: typeof allTrades[0]): string {
		const label = triggerLabels[t.trigger] ?? t.trigger;
		const parts: string[] = [`<strong>${label}</strong>`];

		if (t.signalScore != null) {
			const scoreColor = t.signalScore >= 50 ? "var(--gn)" : t.signalScore >= 20 ? "var(--yl)" : "var(--tx2)";
			parts.push(`<span style="color:${scoreColor}">评分 ${t.signalScore.toFixed(1)}</span>`);
		}

		// Extract key info from signalSnapshot
		const snap = t.signalSnapshot ? (typeof t.signalSnapshot === "string" ? JSON.parse(t.signalSnapshot) : t.signalSnapshot) : null;
		if (snap) {
			const factors: string[] = [];

			// Liquidity
			if (snap.liquidity?.note) {
				const m = snap.liquidity.note.match(/liquidity=(\w+)/);
				if (m) factors.push(`流动性:${m[1] === "expanding" ? '<span class="c-g">扩张</span>' : m[1] === "contracting" ? '<span class="c-r">收缩</span>' : "中性"}`);
			}

			// BTC signal
			if (snap.btcSignal?.note) {
				const m = snap.btcSignal.note.match(/btc_signal=(\w+)/);
				if (m) factors.push(`BTC:${m[1] === "bullish" ? '<span class="c-g">看多</span>' : m[1] === "bearish_alert" ? '<span class="c-r">看空</span>' : "中性"}`);
			}

			// Correlation regime
			if (snap.corrRegime?.note) {
				const m = snap.corrRegime.note.match(/corr_regime=(\w+)/);
				if (m) factors.push(`相关性:${m[1]}`);
			}

			// Sentiment
			if (snap.sentiment?.rawValue != null) {
				const v = snap.sentiment.rawValue;
				factors.push(`情绪:${typeof v === "number" ? v.toFixed(0) : v}`);
			}

			// USD model (for equity)
			if (snap.usdModel?.note && !snap.usdModel.note.includes("n/a")) {
				const m = snap.usdModel.note.match(/usd_composite=([\d.]+)/);
				if (m) factors.push(`USD:${Number(m[1]).toFixed(0)}`);
			}

			// Yield curve (for equity)
			if (snap.yieldCurve?.note && !snap.yieldCurve.note.includes("n/a")) {
				const m = snap.yieldCurve.note.match(/yield_curve=(\w+)/);
				if (m) factors.push(`曲线:${m[1]}`);
			}

			// Conflict note
			if (snap.conflictNote) {
				factors.push(`<span class="c-y">⚠冲突</span>`);
			}

			// Stop loss metadata
			if (snap.method) {
				factors.push(`方式:${snap.method}`);
				if (snap.stopPrice != null) factors.push(`止损价:$${Number(snap.stopPrice).toFixed(2)}`);
			}

			// BTC crash metadata
			if (snap.btcReturn24h != null) {
				factors.push(`BTC 24h:${(snap.btcReturn24h * 100).toFixed(1)}%`);
			}

			if (factors.length > 0) {
				parts.push(`<span style="font-size:11px">${factors.join(" · ")}</span>`);
			}
		}

		return parts.join("<br>");
	}

	const tradeRows = allTrades.map(t => {
		const pnl = t.realizedPnl != null ? `<span class="${t.realizedPnl >= 0 ? "c-g" : "c-r"}">${t.realizedPnl >= 0 ? "+" : ""}$${t.realizedPnl.toFixed(2)}</span>` : "—";
		const holdStr = t.holdingDuration != null && t.holdingDuration > 0 ? (t.holdingDuration >= 86400 ? (t.holdingDuration / 86400).toFixed(1) + "d" : (t.holdingDuration / 3600).toFixed(1) + "h") : "—";
		const icon = opIcons[t.operationType] ?? "•";
		return `<tr>
			<td>${t.createdAt.substring(0, 16).replace("T", " ")}</td>
			<td style="font-weight:700">${t.symbol}</td>
			<td style="color:${opColors[t.operationType] ?? "var(--tx)"}">${icon} ${t.operationType}</td>
			<td>${t.side}</td>
			<td>${t.quantity.toFixed(4)}</td>
			<td>$${t.price.toFixed(2)}</td>
			<td>$${t.notional.toFixed(0)}</td>
			<td>${pnl}</td>
			<td>${t.realizedPnlPct != null ? `${(t.realizedPnlPct * 100).toFixed(2)}%` : "—"}</td>
			<td>${holdStr}</td>
			<td style="font-size:11px;line-height:1.4">${buildTriggerDetail(t)}</td>
		</tr>`;
	}).join("");

	return pg("持仓与交易", `
		<h1 style="font-size:24px;font-weight:800;margin:20px 0 16px">📦 持仓与交易</h1>

		<div class="grid g2" style="margin-bottom:16px">
			<div class="card">
				<div class="card-hd">账户概览</div>
				<div class="grid g4" style="text-align:center;margin-top:8px">
					<div class="metric"><div class="metric-val ${totalPnl >= 0 ? "c-g" : "c-r"}">${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}</div><div class="metric-label">未实现盈亏</div></div>
					<div class="metric"><div class="metric-val">$${totalMv.toFixed(0)}</div><div class="metric-label">持仓市值</div></div>
					<div class="metric"><div class="metric-val" style="color:${riskLevel === "normal" ? "var(--gn)" : riskLevel === "halt" ? "var(--rd)" : "var(--yl)"}">${riskLevel}</div><div class="metric-label">风控等级</div></div>
					<div class="metric"><div class="metric-val">${activePos.length}</div><div class="metric-label">持仓数</div></div>
				</div>
			</div>
			<div class="card">
				<div class="card-hd">交易统计</div>
				<div class="grid g4" style="text-align:center;margin-top:8px">
					<div class="metric"><div class="metric-val ${totalRealizedPnl >= 0 ? "c-g" : "c-r"}">${totalRealizedPnl >= 0 ? "+" : ""}$${totalRealizedPnl.toFixed(2)}</div><div class="metric-label">累计已实现PnL</div></div>
					<div class="metric"><div class="metric-val">${winRate.toFixed(0)}%</div><div class="metric-label">胜率 (${wins.length}W/${losses.length}L)</div></div>
					<div class="metric"><div class="metric-val">${profitFactor.toFixed(2)}</div><div class="metric-label">盈亏比</div></div>
					<div class="metric"><div class="metric-val">${allTrades.length}</div><div class="metric-label">总交易笔数</div></div>
				</div>
			</div>
		</div>

		<div class="card" style="margin-bottom:16px">
			<div class="card-hd">按标的PnL</div>
			<div class="grid g5" style="text-align:center;margin-top:8px">
				${Object.entries(symPnl).map(([sym, d]) => `
					<div class="metric">
						<div class="metric-val ${d.pnl >= 0 ? "c-g" : "c-r"}" style="font-size:18px">${d.pnl >= 0 ? "+" : ""}$${d.pnl.toFixed(2)}</div>
						<div class="metric-label">${sym}</div>
						<div class="metric-sub">${d.wins}/${d.trades} 胜 (${d.trades > 0 ? (d.wins / d.trades * 100).toFixed(0) : 0}%)</div>
					</div>
				`).join("")}
			</div>
		</div>

		${activePos.length > 0 ? `
		<div class="card" style="margin-bottom:16px">
			<div class="card-hd">当前持仓 · 总计 <span class="${totalPnl >= 0 ? "c-g" : "c-r"}" style="font-size:14px;font-weight:700">${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)} (${totalPnl >= 0 ? "+" : ""}${totalPnlPct.toFixed(2)}%)</span></div>
			<div class="grid g2" style="margin-top:8px">${posCardsFull}</div>
		</div>` : '<div class="card"><div class="card-hd">当前持仓</div><p style="color:var(--tx2)">空仓</p></div>'}

		<div class="card">
			<div class="card-hd">全部交易记录 (${allTrades.length} 笔)</div>
			<div class="tbl-wrap"><table>
				<thead><tr><th>时间</th><th>标的</th><th>操作</th><th>方向</th><th>数量</th><th>价格</th><th>金额</th><th>PnL</th><th>PnL%</th><th>持仓</th><th>触发</th></tr></thead>
				<tbody>${tradeRows}</tbody>
			</table></div>
		</div>
	`, nav("positions"));
}

/* ─── Server ─────────────────────────────────────── */

const server = createServer((req, res) => {
	const path = new URL(req.url ?? "/", `http://${req.headers.host}`).pathname;
	try {
		let html: string | null = null;
		if (path === "/" || path === "/index.html") html = handleList();
		else if (path === "/latest") html = handleLatest();
		else if (path === "/positions") html = handlePositions();
		else if (path.startsWith("/report/")) { const id = Number.parseInt(path.split("/")[2], 10); if (!Number.isNaN(id)) html = handleReport(id); }
		else if (path.endsWith(".html")) { try { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(readFileSync(join(DIR, path.replace(/^\//, "")), "utf-8")); return; } catch { /* fall */ } }
		if (html) { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(html); }
		else { res.writeHead(404, { "Content-Type": "text/html" }); res.end(pg("404", "<h1>404</h1>", nav(""))); }
	} catch (e) { console.error(e); res.writeHead(500); res.end("Error"); }
});

server.listen(PORT, "0.0.0.0", () => console.log(`http://0.0.0.0:${PORT}/`));
