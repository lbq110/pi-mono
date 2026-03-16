#!/usr/bin/env tsx
/**
 * Macro Sniper Web Dashboard
 * Serves daily reports + static files (USD dashboard).
 *
 * Usage: node --env-file=.env --import tsx dashboard/report-server.ts
 * Access: http://149.28.17.145/
 */

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { analysisResults, generatedReports, positions } from "../src/db/schema.js";

runMigrations();

const PORT = Number(process.env.DASHBOARD_PORT ?? 80);
const DASHBOARD_DIR = new URL(".", import.meta.url).pathname;

// ─── Markdown → HTML ────────────────────────────────

function mdToHtml(md: string): string {
	// Process tables first (before escaping)
	const lines = md.split("\n");
	const result: string[] = [];
	let inTable = false;
	let tableRows: string[][] = [];

	function flushTable() {
		if (tableRows.length < 2) {
			inTable = false;
			tableRows = [];
			return;
		}
		const headers = tableRows[0];
		const body = tableRows.slice(2); // skip separator row
		let t = '<div class="table-wrap"><table><thead><tr>';
		for (const h of headers) t += `<th>${processInline(h.trim())}</th>`;
		t += "</tr></thead><tbody>";
		for (const row of body) {
			t += "<tr>";
			for (let i = 0; i < headers.length; i++) {
				const cell = row[i]?.trim() ?? "";
				// Color PnL cells
				let cls = "";
				if (cell.startsWith("+") || cell.startsWith("$+") || cell.includes("risk_on") || cell.includes("expanding") || cell.includes("bullish") || cell.includes("Long")) cls = ' class="text-green"';
				else if (cell.startsWith("-") || cell.startsWith("$-") || cell.includes("risk_off") || cell.includes("contracting") || cell.includes("bearish") || cell.includes("flat")) cls = ' class="text-red"';
				t += `<td${cls}>${processInline(cell)}</td>`;
			}
			t += "</tr>";
		}
		t += "</tbody></table></div>";
		result.push(t);
		inTable = false;
		tableRows = [];
	}

	for (const line of lines) {
		if (line.includes("|") && line.trim().startsWith("|")) {
			const cells = line.split("|").slice(1, -1);
			if (!inTable) inTable = true;
			tableRows.push(cells);
			continue;
		}
		if (inTable) flushTable();
		result.push(line);
	}
	if (inTable) flushTable();

	let html = result
		.join("\n")
		.replace(/^#{4}\s+(.+)$/gm, '<h4>$1</h4>')
		.replace(/^#{3}\s+(.+)$/gm, '<h3 class="section-header">$1</h3>')
		.replace(/^#{2}\s+(.+)$/gm, '<h2>$1</h2>')
		.replace(/^#{1}\s+(.+)$/gm, '<h1>$1</h1>')
		.replace(/^---+$/gm, '<hr>')
		.replace(/^\*\s+(.+)$/gm, "<li>$1</li>")
		.replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>")
		.replace(/\n\n/g, "</p><p>")
		.replace(/\n/g, "<br>");

	html = processInline(html);
	return `<div>${html}</div>`;
}

function processInline(text: string): string {
	return text
		.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
		.replace(/__(.+?)__/g, "<strong>$1</strong>");
}

// ─── CSS ────────────────────────────────────────────

const CSS = `
:root{--bg:#0d1117;--surface:#161b22;--surface2:#1c2129;--border:#30363d;--text:#e6edf3;--muted:#8b949e;--accent:#58a6ff;--green:#3fb950;--red:#f85149;--yellow:#d29922;--purple:#bc8cff;--cyan:#39d353;--orange:#f0883e}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.7}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.container{max-width:960px;margin:0 auto;padding:20px}
nav{background:var(--surface);border-bottom:1px solid var(--border);padding:12px 20px;position:sticky;top:0;z-index:100;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
nav .title{font-size:18px;font-weight:700;color:var(--text)}
nav .sep{color:var(--border)}
nav a{font-weight:600}
nav .active{color:var(--text);border-bottom:2px solid var(--accent);padding-bottom:2px}

/* Report content */
.report-content{margin:16px 0}
.report-content h1{font-size:22px;margin:28px 0 12px;color:var(--text);border-bottom:2px solid var(--border);padding-bottom:8px}
.report-content h1:first-child{margin-top:0}
.report-content h2{font-size:18px;color:var(--accent);margin:24px 0 10px}
.report-content h3.section-header{font-size:16px;color:var(--yellow);margin:20px 0 10px;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 16px}
.report-content h4{font-size:14px;color:var(--muted);margin:12px 0 6px}
.report-content p{margin:6px 0}
.report-content strong{color:#fff}
.report-content hr{border:none;border-top:1px solid var(--border);margin:20px 0}
.report-content ul{margin:8px 0 8px 20px}
.report-content li{margin:4px 0}
.report-content li::marker{color:var(--accent)}
.text-green{color:var(--green)}.text-red{color:var(--red)}.text-yellow{color:var(--yellow)}.text-muted{color:var(--muted)}

/* Tables */
.table-wrap{overflow-x:auto;margin:12px 0}
table{width:100%;border-collapse:collapse;font-size:13px;background:var(--surface);border-radius:8px;overflow:hidden}
th{text-align:left;color:var(--accent);font-weight:600;padding:10px 12px;border-bottom:2px solid var(--border);background:var(--surface2);white-space:nowrap}
td{padding:8px 12px;border-bottom:1px solid var(--border);font-variant-numeric:tabular-nums}
tr:hover{background:rgba(88,166,255,0.04)}

/* Cards */
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px}
.card-header{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px}
.grid{display:grid;gap:12px}.grid-2{grid-template-columns:1fr 1fr}.grid-3{grid-template-columns:1fr 1fr 1fr}.grid-4{grid-template-columns:repeat(4,1fr)}.grid-5{grid-template-columns:repeat(5,1fr)}

/* Signal badges */
.badge{display:inline-block;padding:3px 12px;border-radius:14px;font-size:12px;font-weight:600}
.badge-bull{background:rgba(63,185,80,.15);color:var(--green)}
.badge-bear{background:rgba(248,81,73,.15);color:var(--red)}
.badge-neutral{background:rgba(139,148,158,.15);color:var(--muted)}
.badge-claude{background:rgba(188,140,255,.15);color:#bc8cff}
.badge-gemini{background:rgba(57,211,83,.15);color:#39d353}
.badge-warn{background:rgba(210,153,34,.15);color:var(--yellow)}

/* Big numbers */
.big-num{font-size:28px;font-weight:700;line-height:1.2}

/* Position cards */
.pos-card{background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:14px;position:relative;overflow:hidden}
.pos-card::before{content:'';position:absolute;top:0;left:0;width:4px;height:100%;border-radius:4px 0 0 4px}
.pos-card.pos-profit::before{background:var(--green)}.pos-card.pos-loss::before{background:var(--red)}
.pos-sym{font-size:16px;font-weight:700}.pos-dir{font-size:12px;color:var(--muted);margin-left:6px}
.pos-detail{font-size:13px;color:var(--muted);margin-top:4px}
.pos-pnl{font-size:18px;font-weight:700;margin-top:6px}

/* Meta bar */
.meta-bar{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0}
.meta-pill{background:var(--surface2);border:1px solid var(--border);padding:4px 14px;border-radius:20px;font-size:13px;display:flex;align-items:center;gap:6px}
.meta-dot{width:8px;height:8px;border-radius:50%;display:inline-block}

/* Report list */
.report-list{list-style:none}
.report-list li{border-bottom:1px solid var(--border)}
.report-list a{display:flex;justify-content:space-between;align-items:center;padding:16px;color:var(--text);text-decoration:none;transition:background .15s}
.report-list a:hover{background:rgba(88,166,255,.06)}
.report-date{font-size:18px;font-weight:700}.report-info{display:flex;gap:12px;align-items:center;color:var(--muted);font-size:13px}

/* Report nav */
.report-nav{display:flex;justify-content:space-between;margin:20px 0;padding:12px 0;border-top:1px solid var(--border)}

footer{text-align:center;color:var(--muted);font-size:12px;padding:24px}
@media(max-width:768px){.grid-2,.grid-3,.grid-4,.grid-5{grid-template-columns:1fr}}
`;

// ─── Helpers ────────────────────────────────────────

function renderNav(current: string): string {
	const items = [
		{ href: "/", label: "📋 日报列表", key: "list" },
		{ href: "/latest", label: "📰 最新日报", key: "latest" },
		{ href: "/usd-model-live.html", label: "💵 USD看板", key: "usd" },
	];
	return `<nav>
		<span class="title">Macro Sniper</span>
		<span class="sep">|</span>
		${items.map(i => `<a href="${i.href}" class="${current === i.key ? "active" : ""}">${i.label}</a>`).join("")}
	</nav>`;
}

function page(title: string, body: string, nav: string, extraHead = ""): string {
	return `<!DOCTYPE html><html lang="zh-CN"><head>
		<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
		<title>${title} — Macro Sniper</title>
		<style>${CSS}</style>${extraHead}
	</head><body>${nav}<div class="container">${body}</div>
	<footer>Macro Sniper · 每日 08:00 ET 自动采集分析 · Powered by Claude + FRED + Alpaca</footer>
	</body></html>`;
}

function signalBadge(signal: string): string {
	const bullish = ["risk_on", "expanding", "bullish", "bull_steepener", "bull_flattener"];
	const bearish = ["risk_off", "risk_off_confirmed", "risk_off_severe", "contracting", "bearish", "bearish_alert", "bear_steepener", "bear_flattener"];
	const cls = bullish.includes(signal) ? "badge-bull" : bearish.includes(signal) ? "badge-bear" : signal === "conflicted" ? "badge-warn" : "badge-neutral";
	return `<span class="badge ${cls}">${signal}</span>`;
}

// ─── Route: List ────────────────────────────────────

function handleList(): string {
	const db = getDb();
	const rows = db
		.select({
			id: generatedReports.id,
			date: generatedReports.date,
			model: generatedReports.model,
			createdAt: generatedReports.createdAt,
			len: sql<number>`length(${generatedReports.content})`,
		})
		.from(generatedReports)
		.where(eq(generatedReports.reportType, "daily"))
		.orderBy(desc(generatedReports.id))
		.all();

	const seen = new Set<string>();
	const unique = rows.filter((r) => {
		if (seen.has(r.date)) return false;
		seen.add(r.date);
		return true;
	});

	// Get latest signals for header
	const biasRow = db
		.select({ signal: analysisResults.signal })
		.from(analysisResults)
		.where(eq(analysisResults.type, "market_bias"))
		.orderBy(desc(analysisResults.date))
		.limit(1)
		.all()[0];

	const headerSignal = biasRow ? signalBadge(biasRow.signal) : "";

	const listItems = unique
		.map((r) => {
			const modelBadge = r.model.includes("claude")
				? '<span class="badge badge-claude">Claude</span>'
				: '<span class="badge badge-gemini">Gemini</span>';
			const time = `${r.createdAt.substring(11, 16)} UTC`;
			const size = `${(r.len / 1024).toFixed(1)}KB`;
			return `<li><a href="/report/${r.id}">
			<span class="report-date">📋 ${r.date}</span>
			<span class="report-info">${modelBadge}<span>${time}</span><span>${size}</span></span>
		</a></li>`;
		})
		.join("");

	return page(
		"日报列表",
		`
		<div style="display:flex;align-items:center;gap:16px;margin:20px 0 12px">
			<h1 style="font-size:22px;margin:0">宏观投研日报</h1>
			${headerSignal}
		</div>
		<p style="color:var(--muted);margin-bottom:16px">共 ${unique.length} 份日报 · 每日 08:00 ET (12:00 UTC) 自动生成</p>
		<div class="card" style="padding:0;overflow:hidden">
			<ul class="report-list">${listItems}</ul>
		</div>`,
		renderNav("list"),
	);
}

// ─── Route: Report Detail ───────────────────────────

function handleReport(id: number): string | null {
	const db = getDb();
	const row = db.select().from(generatedReports).where(eq(generatedReports.id, id)).limit(1).all()[0];
	if (!row) return null;

	const modelBadge = row.model.includes("claude")
		? '<span class="badge badge-claude">Claude Opus</span>'
		: '<span class="badge badge-gemini">Gemini Flash</span>';

	// ── Positions cards ──
	const posRows = db.select().from(positions).all();
	const activePos = posRows.filter((p) => p.direction !== "flat" && p.quantity > 0);
	const totalPnl = activePos.reduce((s, p) => s + p.unrealizedPnl, 0);
	const totalCost = activePos.reduce((s, p) => s + p.avgCost * p.quantity, 0);
	const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;

	const posCards = activePos
		.map((p) => {
			const pnlPct = p.avgCost > 0 ? (p.unrealizedPnl / (p.avgCost * p.quantity)) * 100 : 0;
			const cls = p.unrealizedPnl >= 0 ? "pos-profit" : "pos-loss";
			const sign = p.unrealizedPnl >= 0 ? "+" : "";
			const openDate = p.openedAt ? p.openedAt.split("T")[0] : "—";
			return `<div class="pos-card ${cls}">
			<div><span class="pos-sym">${p.symbol}</span><span class="pos-dir">${p.direction.toUpperCase()}</span></div>
			<div class="pos-detail">${p.quantity.toFixed(4)} 股 · 成本 $${p.avgCost.toFixed(2)} · 建仓 ${openDate}</div>
			<div class="pos-pnl ${p.unrealizedPnl >= 0 ? "text-green" : "text-red"}">${sign}$${p.unrealizedPnl.toFixed(2)} <span style="font-size:14px">(${sign}${pnlPct.toFixed(2)}%)</span></div>
		</div>`;
		})
		.join("");

	const totalSign = totalPnl >= 0 ? "+" : "";
	const totalCard =
		activePos.length > 0
			? `<div class="card" style="margin:16px 0">
		<div class="card-header">当前持仓 · 总计 ${totalSign}$${totalPnl.toFixed(2)} (${totalSign}${totalPnlPct.toFixed(2)}%)</div>
		<div class="grid grid-4" style="margin-top:8px">${posCards}</div>
	</div>`
			: "";

	// ── Signal pills ──
	const signalTypes = ["market_bias", "liquidity_signal", "yield_curve", "credit_risk", "sentiment_signal", "btc_signal", "funding_stress", "auction_health"];
	const signalLabels: Record<string, string> = {
		market_bias: "🎯 偏向",
		liquidity_signal: "💧 流动性",
		yield_curve: "📈 曲线",
		credit_risk: "🛡️ 信用",
		sentiment_signal: "🌡️ 情绪",
		btc_signal: "₿ BTC",
		funding_stress: "🏦 资金压力",
		auction_health: "🏛️ 拍卖",
	};
	const signalDots: Record<string, string> = {
		risk_on: "var(--green)",
		expanding: "var(--green)",
		bullish: "var(--green)",
		bull_steepener: "var(--green)",
		bull_flattener: "var(--green)",
		risk_off: "var(--red)",
		risk_off_confirmed: "var(--red)",
		contracting: "var(--red)",
		bearish_alert: "var(--red)",
		bear_steepener: "var(--red)",
		bear_flattener: "var(--orange)",
		conflicted: "var(--yellow)",
	};
	const pills = signalTypes
		.map((t) => {
			const r = db
				.select({ signal: analysisResults.signal })
				.from(analysisResults)
				.where(eq(analysisResults.type, t))
				.orderBy(desc(analysisResults.date))
				.limit(1)
				.all()[0];
			if (!r) return "";
			const dotColor = signalDots[r.signal] ?? "var(--muted)";
			return `<span class="meta-pill"><span class="meta-dot" style="background:${dotColor}"></span>${signalLabels[t] ?? t}: <strong>${r.signal}</strong></span>`;
		})
		.join("");

	// ── Nav between reports ──
	const prevRow = db
		.select({ id: generatedReports.id })
		.from(generatedReports)
		.where(sql`${generatedReports.id} < ${id}`)
		.orderBy(desc(generatedReports.id))
		.limit(1)
		.all()[0];
	const nextRow = db
		.select({ id: generatedReports.id })
		.from(generatedReports)
		.where(sql`${generatedReports.id} > ${id}`)
		.orderBy(generatedReports.id)
		.limit(1)
		.all()[0];

	return page(
		`日报 ${row.date}`,
		`
		<div style="display:flex;align-items:center;gap:12px;margin-top:16px;flex-wrap:wrap">
			<h1 style="font-size:22px;margin:0">📋 ${row.date}</h1>
			${modelBadge}
			<span style="color:var(--muted);font-size:13px">⏰ ${row.createdAt.substring(0, 19)} UTC</span>
		</div>
		<div class="meta-bar">${pills}</div>
		${totalCard}
		<div class="report-content">${mdToHtml(row.content)}</div>
		<div class="report-nav">
			${prevRow ? `<a href="/report/${prevRow.id}">← 上一篇</a>` : "<span></span>"}
			<a href="/">返回列表</a>
			${nextRow ? `<a href="/report/${nextRow.id}">下一篇 →</a>` : "<span></span>"}
		</div>`,
		renderNav("report"),
	);
}

function handleLatest(): string {
	const db = getDb();
	const row = db
		.select({ id: generatedReports.id })
		.from(generatedReports)
		.where(eq(generatedReports.reportType, "daily"))
		.orderBy(desc(generatedReports.id))
		.limit(1)
		.all()[0];
	if (!row) return page("无日报", '<p class="text-muted">暂无日报数据</p>', renderNav("latest"));
	return handleReport(row.id) ?? page("无日报", '<p class="text-muted">报告不存在</p>', renderNav("latest"));
}

// ─── HTTP Server ────────────────────────────────────

const server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
	const path = url.pathname;

	try {
		let html: string | null = null;

		if (path === "/" || path === "/index.html") {
			html = handleList();
		} else if (path === "/latest") {
			html = handleLatest();
		} else if (path.startsWith("/report/")) {
			const id = Number.parseInt(path.split("/")[2], 10);
			if (!Number.isNaN(id)) {
				html = handleReport(id);
			}
		} else if (path.endsWith(".html")) {
			try {
				const filePath = join(DASHBOARD_DIR, path.replace(/^\//, ""));
				const content = readFileSync(filePath, "utf-8");
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(content);
				return;
			} catch {
				// fall through
			}
		}

		if (html) {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(html);
		} else {
			res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
			res.end(page("404", "<h1>404 Not Found</h1>", renderNav("")));
		}
	} catch (err) {
		console.error("Request error:", err);
		res.writeHead(500, { "Content-Type": "text/plain" });
		res.end("Internal Server Error");
	}
});

server.listen(PORT, "0.0.0.0", () => {
	console.log(`Dashboard running at http://0.0.0.0:${PORT}/`);
	console.log(`External: http://149.28.17.145:${PORT}/`);
});
