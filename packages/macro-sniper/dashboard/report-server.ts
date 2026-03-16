#!/usr/bin/env tsx
/**
 * Daily Report Web Server
 * Serves generated reports as rendered HTML pages.
 * 
 * Usage: node --env-file=.env --import tsx dashboard/report-server.ts
 * Access: http://149.28.17.145:9091/
 */

import { createServer } from "node:http";
import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { generatedReports, positions, positionTrades, analysisResults } from "../src/db/schema.js";

runMigrations();

const PORT = 9091;

// ─── Markdown → HTML (lightweight, no external deps) ────

function mdToHtml(md: string): string {
	let html = md
		// Escape HTML
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		// Bold: **text** or __text__
		.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
		.replace(/__(.+?)__/g, "<strong>$1</strong>")
		// Italic: *text* or _text_
		.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>")
		// Headers
		.replace(/^#{4}\s+(.+)$/gm, '<h4>$1</h4>')
		.replace(/^#{3}\s+(.+)$/gm, '<h3>$1</h3>')
		.replace(/^#{2}\s+(.+)$/gm, '<h2>$1</h2>')
		.replace(/^#{1}\s+(.+)$/gm, '<h1>$1</h1>')
		// Horizontal rule
		.replace(/^---+$/gm, '<hr>')
		// List items
		.replace(/^\*\s+(.+)$/gm, '<li>$1</li>')
		.replace(/^-\s+(.+)$/gm, '<li>$1</li>')
		// Wrap consecutive <li> in <ul>
		.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>')
		// Line breaks for paragraphs
		.replace(/\n\n/g, '</p><p>')
		.replace(/\n/g, '<br>');

	return `<p>${html}</p>`;
}

// ─── Page Templates ─────────────────────────────────

const CSS = `
:root { --bg: #0d1117; --surface: #161b22; --border: #30363d; --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff; --green: #3fb950; --red: #f85149; --yellow: #d29922; }
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; font-size: 15px; line-height: 1.7; }
.container { max-width: 900px; margin: 0 auto; padding: 20px; }
nav { background: var(--surface); border-bottom: 1px solid var(--border); padding: 12px 20px; position: sticky; top: 0; z-index: 100; display: flex; align-items: center; gap: 16px; }
nav a { color: var(--accent); text-decoration: none; font-weight: 600; }
nav a:hover { text-decoration: underline; }
nav .title { font-size: 18px; font-weight: 700; color: var(--text); }
nav .sep { color: var(--border); }
.report-content { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 32px; margin: 20px 0; }
.report-content h1 { font-size: 24px; margin: 24px 0 12px; color: var(--text); border-bottom: 2px solid var(--border); padding-bottom: 8px; }
.report-content h1:first-child { margin-top: 0; }
.report-content h2 { font-size: 20px; color: var(--accent); margin: 20px 0 10px; }
.report-content h3 { font-size: 17px; color: var(--yellow); margin: 16px 0 8px; }
.report-content h4 { font-size: 15px; color: var(--muted); margin: 12px 0 6px; }
.report-content p { margin: 8px 0; }
.report-content strong { color: #fff; }
.report-content em { color: var(--yellow); font-style: italic; }
.report-content hr { border: none; border-top: 1px solid var(--border); margin: 24px 0; }
.report-content ul { margin: 8px 0 8px 20px; }
.report-content li { margin: 4px 0; }
.report-content li::marker { color: var(--accent); }
.meta { display: flex; gap: 16px; flex-wrap: wrap; color: var(--muted); font-size: 13px; margin-bottom: 16px; }
.meta-item { background: rgba(48,54,61,0.5); padding: 4px 12px; border-radius: 16px; }
.report-list { list-style: none; }
.report-list li { border-bottom: 1px solid var(--border); }
.report-list a { display: flex; justify-content: space-between; align-items: center; padding: 14px 16px; color: var(--text); text-decoration: none; transition: background 0.2s; }
.report-list a:hover { background: rgba(88,166,255,0.08); }
.report-date { font-size: 18px; font-weight: 700; }
.report-info { display: flex; gap: 12px; align-items: center; color: var(--muted); font-size: 13px; }
.badge { padding: 2px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; }
.badge-claude { background: rgba(188,140,255,0.15); color: #bc8cff; }
.badge-gemini { background: rgba(57,211,83,0.15); color: #39d353; }
.positions-bar { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin: 16px 0; }
.pos-card { background: rgba(48,54,61,0.5); border-radius: 8px; padding: 12px; font-size: 13px; }
.pos-sym { font-weight: 700; font-size: 15px; }
.pos-pnl { font-weight: 600; }
.text-green { color: var(--green); } .text-red { color: var(--red); }
footer { text-align: center; color: var(--muted); font-size: 12px; padding: 20px; }
`;

function renderNav(current: string): string {
	return `<nav>
		<span class="title">📋 Macro Sniper</span>
		<span class="sep">|</span>
		<a href="/" ${current === 'list' ? 'style="color:var(--text)"' : ''}>日报列表</a>
		<a href="/latest" ${current === 'latest' ? 'style="color:var(--text)"' : ''}>最新日报</a>
		<a href="/usd-model-live.html">USD看板</a>
	</nav>`;
}

function renderPage(title: string, body: string, nav: string): string {
	return `<!DOCTYPE html><html lang="zh-CN"><head>
		<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
		<title>${title} — Macro Sniper</title>
		<style>${CSS}</style>
	</head><body>${nav}<div class="container">${body}</div>
	<footer>Macro Sniper Daily Report System · Data updates at 08:00 ET</footer>
	</body></html>`;
}

// ─── Route Handlers ─────────────────────────────────

function handleList(): string {
	const db = getDb();

	// Get one report per date (latest id)
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

	// Dedupe: keep latest per date
	const seen = new Set<string>();
	const unique = rows.filter(r => {
		if (seen.has(r.date)) return false;
		seen.add(r.date);
		return true;
	});

	const listItems = unique.map(r => {
		const modelBadge = r.model.includes("claude")
			? '<span class="badge badge-claude">Claude</span>'
			: '<span class="badge badge-gemini">Gemini</span>';
		const time = r.createdAt.substring(11, 16) + " UTC";
		const size = (r.len / 1024).toFixed(1) + " KB";
		return `<li><a href="/report/${r.id}">
			<span class="report-date">${r.date}</span>
			<span class="report-info">${modelBadge}<span>${time}</span><span>${size}</span></span>
		</a></li>`;
	}).join("");

	return renderPage("日报列表", `
		<h1 style="margin: 20px 0 12px; font-size: 22px;">📋 宏观投研日报</h1>
		<p style="color: var(--muted); margin-bottom: 16px;">共 ${unique.length} 份日报 · 每日 08:00 ET 自动生成</p>
		<div style="background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden;">
			<ul class="report-list">${listItems}</ul>
		</div>
	`, renderNav("list"));
}

function handleReport(id: number): string | null {
	const db = getDb();
	const row = db.select().from(generatedReports).where(eq(generatedReports.id, id)).limit(1).all()[0];
	if (!row) return null;

	const modelBadge = row.model.includes("claude")
		? '<span class="badge badge-claude">Claude Opus</span>'
		: '<span class="badge badge-gemini">Gemini Flash</span>';

	// Get positions at report time
	const posRows = db.select().from(positions).all();
	const posHtml = posRows
		.filter(p => p.direction !== "flat" && p.quantity > 0)
		.map(p => {
			const pnlPct = p.avgCost > 0 ? (p.unrealizedPnl / (p.avgCost * p.quantity) * 100) : 0;
			const pnlClass = p.unrealizedPnl >= 0 ? "text-green" : "text-red";
			const sign = p.unrealizedPnl >= 0 ? "+" : "";
			return `<div class="pos-card">
				<div class="pos-sym">${p.symbol} <span style="color:var(--muted);font-size:12px">${p.direction}</span></div>
				<div>数量: ${p.quantity.toFixed(4)} · 成本: $${p.avgCost.toFixed(2)}</div>
				<div class="pos-pnl ${pnlClass}">${sign}$${p.unrealizedPnl.toFixed(2)} (${sign}${pnlPct.toFixed(2)}%)</div>
			</div>`;
		}).join("");

	// Get latest signals
	const signalTypes = ["market_bias", "liquidity_signal", "yield_curve", "credit_risk", "sentiment_signal", "btc_signal"];
	const signalBadges = signalTypes.map(t => {
		const r = db.select({ signal: analysisResults.signal }).from(analysisResults)
			.where(eq(analysisResults.type, t)).orderBy(desc(analysisResults.date)).limit(1).all()[0];
		if (!r) return "";
		const labels: Record<string, string> = {
			market_bias: "偏向", liquidity_signal: "流动性", yield_curve: "曲线",
			credit_risk: "信用", sentiment_signal: "情绪", btc_signal: "BTC"
		};
		return `<span class="meta-item">${labels[t] ?? t}: ${r.signal}</span>`;
	}).join("");

	// Navigation between reports
	const prevRow = db.select({ id: generatedReports.id }).from(generatedReports)
		.where(sql`${generatedReports.id} < ${id}`).orderBy(desc(generatedReports.id)).limit(1).all()[0];
	const nextRow = db.select({ id: generatedReports.id }).from(generatedReports)
		.where(sql`${generatedReports.id} > ${id}`).orderBy(generatedReports.id).limit(1).all()[0];
	const navLinks = `<div style="display:flex;justify-content:space-between;margin:20px 0;">
		${prevRow ? `<a href="/report/${prevRow.id}" style="color:var(--accent)">← 上一篇</a>` : '<span></span>'}
		${nextRow ? `<a href="/report/${nextRow.id}" style="color:var(--accent)">下一篇 →</a>` : '<span></span>'}
	</div>`;

	return renderPage(`日报 ${row.date}`, `
		<div class="meta" style="margin-top: 16px;">
			<span class="meta-item">📅 ${row.date}</span>
			${modelBadge}
			<span class="meta-item">⏰ ${row.createdAt.substring(0, 19)} UTC</span>
			${signalBadges}
		</div>
		${posHtml ? `<div class="positions-bar">${posHtml}</div>` : ''}
		<div class="report-content">${mdToHtml(row.content)}</div>
		${navLinks}
	`, renderNav("report"));
}

function handleLatest(): string {
	const db = getDb();
	const row = db.select({ id: generatedReports.id }).from(generatedReports)
		.where(eq(generatedReports.reportType, "daily"))
		.orderBy(desc(generatedReports.id)).limit(1).all()[0];
	if (!row) return renderPage("无日报", "<p>暂无日报数据</p>", renderNav("latest"));
	return handleReport(row.id) ?? renderPage("无日报", "<p>报告不存在</p>", renderNav("latest"));
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
			const id = parseInt(path.split("/")[2], 10);
			if (!isNaN(id)) {
				html = handleReport(id);
			}
		}

		if (html) {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(html);
		} else {
			res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
			res.end(renderPage("404", "<h1>404 Not Found</h1>", renderNav("")));
		}
	} catch (err) {
		console.error("Request error:", err);
		res.writeHead(500, { "Content-Type": "text/plain" });
		res.end("Internal Server Error");
	}
});

server.listen(PORT, "0.0.0.0", () => {
	console.log(`Report server running at http://0.0.0.0:${PORT}/`);
	console.log(`External: http://149.28.17.145:${PORT}/`);
});
