import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { analysisResults, generatedReports, positions } from "../db/schema.js";
import { getPortfolioHWM, getRiskLevel, getRiskMultiplier } from "../executors/risk-manager.js";
import { previewScores } from "../executors/trade-engine.js";
import { createChildLogger } from "../logger.js";
import { formatReport } from "./formatter.js";
import type { PositionSummary, ReportContext, ScoreSummary } from "./prompt-template.js";
import { buildDailyReportPrompt } from "./prompt-template.js";

const log = createChildLogger("reporter");

/** Read all analysis results for a given date from DB. */
function loadAnalysisResults(db: Db, date: string): Map<string, { signal: string; metadata: Record<string, unknown> }> {
	const rows = db.select().from(analysisResults).where(eq(analysisResults.date, date)).all();

	const results = new Map<string, { signal: string; metadata: Record<string, unknown> }>();
	for (const row of rows) {
		const metadata = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
		results.set(row.type, { signal: row.signal, metadata: metadata as Record<string, unknown> });
	}
	return results;
}

/**
 * Generate a daily report by reading analysis results from DB,
 * calling LLM, and writing the report back to DB.
 *
 * @param streamText - A function that sends a prompt to the LLM and returns the generated text.
 *                     This allows callers to inject their own LLM integration (e.g., pi-ai).
 */
export async function generateDailyReport(
	db: Db,
	date: string,
	streamText: (prompt: string, model: string) => Promise<string>,
	model: string,
): Promise<string> {
	log.info({ date, model }, "Generating daily report");

	// Read all signals from DB (not from analyzers directly — fully DB-decoupled)
	const signals = loadAnalysisResults(db, date);

	// Load current positions for §8
	const posRows = db.select().from(positions).all();
	const positionSummaries: PositionSummary[] = posRows
		.filter((p) => p.direction !== "flat" && p.quantity > 0)
		.map((p) => ({
			symbol: p.symbol,
			direction: p.direction,
			quantity: p.quantity,
			avgCost: p.avgCost,
			currentPrice: p.currentPrice,
			unrealizedPnl: p.unrealizedPnl,
			pnlPct: p.avgCost > 0 ? p.unrealizedPnl / (p.avgCost * p.quantity) : 0,
			openedAt: p.openedAt,
		}));

	// Load scores for §10
	let scoreSummaries: ScoreSummary[] = [];
	let atrInfo: Record<string, { atrPct: number; stopPct: number }> = {};
	let riskLevel = "normal";
	let riskMultiplier = 1;
	let kellyFraction: number | null = null;
	let portfolioDrawdownPct = 0;

	try {
		const allScores = previewScores(db);
		const scoreEntries: ScoreSummary[] = [];
		for (const sym of ["SPY", "QQQ", "IWM", "BTCUSD", "UUP"] as const) {
			const s = allScores[sym];
			scoreEntries.push({
				symbol: s.symbol,
				score: s.finalScore,
				direction: s.direction,
				sizeMultiplier: s.sizeMultiplier,
				notionalFinal: s.notionalFinal,
				creditVeto: s.creditVeto,
				creditMultiplier: s.creditMultiplier,
				corrPenalty: s.evidence.corrRegimeNote,
			});
		}
		scoreSummaries = scoreEntries;
		atrInfo = allScores.atrInfo;
		riskLevel = allScores.riskLevel;
		riskMultiplier = allScores.riskMultiplier;
		kellyFraction = allScores.kellyFraction;
	} catch {
		log.warn("Failed to compute scores for report, continuing without");
	}

	// Risk state
	riskLevel = getRiskLevel(db);
	riskMultiplier = getRiskMultiplier(db);
	const hwm = getPortfolioHWM(db);

	// Estimate account equity from positions or default
	const totalPnl = positionSummaries.reduce((s, p) => s + p.unrealizedPnl, 0);
	const accountEquity = hwm > 0 ? hwm - hwm * portfolioDrawdownPct : 100000 + totalPnl;
	if (hwm > 0 && accountEquity > 0) {
		portfolioDrawdownPct = Math.max(0, (hwm - accountEquity) / hwm);
	}

	const ctx: ReportContext = {
		date,
		liquiditySignal: signals.get("liquidity_signal"),
		yieldCurveSignal: signals.get("yield_curve"),
		creditRiskSignal: signals.get("credit_risk"),
		sentimentSignal: signals.get("sentiment_signal"),
		marketBias: signals.get("market_bias"),
		usdModel: signals.get("usd_model"),
		btcSignal: signals.get("btc_signal"),
		correlationMatrix: signals.get("correlation_matrix"),
		positions: positionSummaries,
		scores: scoreSummaries,
		riskLevel,
		riskMultiplier,
		portfolioDrawdownPct,
		atrInfo,
		kellyFraction,
		accountEquity,
	};

	const prompt = buildDailyReportPrompt(ctx);

	// Call LLM
	const rawOutput = await streamText(prompt, model);
	const llmContent = formatReport(rawOutput);

	// Prepend fixed title (don't rely on LLM to generate it)
	const content = `# 📋 宏观投研日报：${date}\n\n${llmContent}`;

	// Write report to DB
	db.insert(generatedReports)
		.values({
			date,
			reportType: "daily",
			content,
			model,
			createdAt: new Date().toISOString(),
		})
		.run();

	log.info({ date, model, length: content.length }, "Daily report generated and saved");
	return content;
}
