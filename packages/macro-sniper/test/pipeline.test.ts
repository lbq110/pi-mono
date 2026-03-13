import { beforeEach, describe, expect, it } from "vitest";
import { analyzeCreditRisk } from "../src/analyzers/credit-risk.js";
import { analyzeLiquiditySignal } from "../src/analyzers/liquidity-signal.js";
import { analyzeSentimentSignal } from "../src/analyzers/sentiment-signal.js";
import { analyzeYieldCurve } from "../src/analyzers/yield-curve.js";
import type { Db } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { runAnalysisPipeline } from "../src/jobs/pipeline.js";
import { generateDailyReport } from "../src/reporters/pipeline.js";
import {
	createTestDb,
	seedAuctions,
	seedCredit,
	seedHourlyPrices,
	seedLiquidity,
	seedSentiment,
	seedYields,
	TODAY,
} from "./helpers.js";

describe("analyzers", () => {
	let db: Db;

	beforeEach(() => {
		db = createTestDb();
	});

	it("liquidity signal: computes and writes to analysis_results", () => {
		seedLiquidity(db);
		analyzeLiquiditySignal(db, TODAY);

		const rows = db.select().from(schema.analysisResults).all();
		expect(rows.length).toBe(1);
		expect(rows[0].type).toBe("liquidity_signal");
		expect(["expanding", "contracting", "neutral"]).toContain(rows[0].signal);

		const meta = typeof rows[0].metadata === "string" ? JSON.parse(rows[0].metadata) : rows[0].metadata;
		expect(meta).toHaveProperty("net_liquidity");
		expect(meta).toHaveProperty("sofr_iorb_spread_bps");
		expect(meta).toHaveProperty("funding_tight");
	});

	it("yield curve: computes and writes to analysis_results", () => {
		seedYields(db);
		analyzeYieldCurve(db, TODAY);

		const rows = db.select().from(schema.analysisResults).all();
		expect(rows.length).toBe(1);
		expect(rows[0].type).toBe("yield_curve");
		expect(["bear_steepener", "bull_steepener", "bear_flattener", "bull_flattener", "neutral"]).toContain(
			rows[0].signal,
		);

		const meta = typeof rows[0].metadata === "string" ? JSON.parse(rows[0].metadata) : rows[0].metadata;
		expect(meta).toHaveProperty("dgs2");
		expect(meta).toHaveProperty("dgs10");
		expect(meta).toHaveProperty("delta_5d_2y_bps");
		expect(meta).toHaveProperty("delta_5d_10y_bps");
	});

	it("credit risk: computes and writes to analysis_results", () => {
		seedCredit(db);
		analyzeCreditRisk(db, TODAY);

		const rows = db.select().from(schema.analysisResults).all();
		expect(rows.length).toBe(1);
		expect(rows[0].type).toBe("credit_risk");
		expect(["risk_on", "risk_off", "risk_off_confirmed", "risk_off_severe"]).toContain(rows[0].signal);

		const meta = typeof rows[0].metadata === "string" ? JSON.parse(rows[0].metadata) : rows[0].metadata;
		expect(meta).toHaveProperty("hyg_ief_ratio");
		expect(meta).toHaveProperty("hyg_ief_ma20");
	});

	it("sentiment signal: computes and writes to analysis_results", () => {
		seedSentiment(db);
		analyzeSentimentSignal(db, TODAY);

		const rows = db.select().from(schema.analysisResults).all();
		expect(rows.length).toBe(1);
		expect(rows[0].type).toBe("sentiment_signal");
		expect(["extreme_fear", "fear", "neutral", "greed", "extreme_greed"]).toContain(rows[0].signal);

		const meta = typeof rows[0].metadata === "string" ? JSON.parse(rows[0].metadata) : rows[0].metadata;
		expect(meta).toHaveProperty("composite_score");
		expect(meta.composite_score).toBeGreaterThanOrEqual(0);
		expect(meta.composite_score).toBeLessThanOrEqual(100);
	});
});

describe("full analysis pipeline", () => {
	it("produces all 10 analysis results including auction_health and funding_stress", () => {
		const db = createTestDb();
		seedLiquidity(db);
		seedYields(db);
		seedCredit(db);
		seedSentiment(db);
		seedHourlyPrices(db);
		seedAuctions(db);

		runAnalysisPipeline(db, TODAY);

		const rows = db.select().from(schema.analysisResults).all();
		const types = rows.map((r) => r.type).sort();
		expect(types).toEqual([
			"auction_health",
			"btc_signal",
			"correlation_matrix",
			"credit_risk",
			"funding_stress",
			"liquidity_signal",
			"market_bias",
			"sentiment_signal",
			"usd_model",
			"yield_curve",
		]);

		const bias = rows.find((r) => r.type === "market_bias");
		expect(bias).toBeDefined();
		const meta = typeof bias!.metadata === "string" ? JSON.parse(bias!.metadata) : bias!.metadata;
		expect(meta).toHaveProperty("overall_bias");
		expect(meta).toHaveProperty("confidence");
		expect(meta).toHaveProperty("signals");
		expect(meta).toHaveProperty("conflicts");
		expect(meta).toHaveProperty("tags");
	});
});

describe("report generation (mock LLM)", () => {
	it("reads analysis_results from DB, calls LLM, writes report to DB", async () => {
		const db = createTestDb();
		seedLiquidity(db);
		seedYields(db);
		seedCredit(db);
		seedSentiment(db);
		seedHourlyPrices(db);

		runAnalysisPipeline(db, TODAY);

		const mockStreamText = async (prompt: string, _model: string): Promise<string> => {
			expect(prompt).toContain("流动性");
			expect(prompt).toContain(TODAY);
			return "# 每日投研日报\n\n测试报告内容。";
		};

		const content = await generateDailyReport(db, TODAY, mockStreamText, "claude-sonnet-4-6");

		expect(content).toContain("每日投研日报");
		expect(content).toContain("测试报告内容");

		const reports = db.select().from(schema.generatedReports).all();
		expect(reports.length).toBe(1);
		expect(reports[0].date).toBe(TODAY);
		expect(reports[0].reportType).toBe("daily");
		expect(reports[0].model).toBe("claude-sonnet-4-6");
		expect(reports[0].content).toContain("测试报告内容");
	});
});

describe("upsert idempotency", () => {
	it("running analyzers twice overwrites, does not duplicate", () => {
		const db = createTestDb();
		seedLiquidity(db);

		analyzeLiquiditySignal(db, TODAY);
		analyzeLiquiditySignal(db, TODAY);

		const rows = db.select().from(schema.analysisResults).all();
		expect(rows.length).toBe(1);
	});
});
