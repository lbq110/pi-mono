import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { analysisResults, generatedReports } from "../db/schema.js";
import { createChildLogger } from "../logger.js";
import { formatReport } from "./formatter.js";
import type { ReportContext } from "./prompt-template.js";
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

	const ctx: ReportContext = {
		date,
		liquiditySignal: signals.get("liquidity_signal"),
		yieldCurveSignal: signals.get("yield_curve"),
		creditRiskSignal: signals.get("credit_risk"),
		sentimentSignal: signals.get("sentiment_signal"),
		marketBias: signals.get("market_bias"),
		usdModel: signals.get("usd_model"),
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
