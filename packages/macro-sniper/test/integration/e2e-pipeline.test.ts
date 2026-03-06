import { describe, expect, it } from "vitest";
import * as schema from "../../src/db/schema.js";
import { runAnalysisPipeline } from "../../src/jobs/pipeline.js";
import { finishJobRun, getRecentJobRuns, startJobRun } from "../../src/jobs/run-tracker.js";
import { generateDailyReport } from "../../src/reporters/pipeline.js";
import {
	createTestDb,
	seedCredit,
	seedCreditBreach,
	seedLiquidity,
	seedSentiment,
	seedSentimentExtremeFear,
	seedYields,
	TODAY,
} from "../helpers.js";

describe("end-to-end pipeline", () => {
	it("full pipeline: seed → analyze → report → verify DB", async () => {
		const db = createTestDb();

		// Step 1: Seed raw data (simulates collectors writing to DB)
		seedLiquidity(db);
		seedYields(db);
		seedCredit(db);
		seedSentiment(db);

		// Step 2: Run analysis pipeline (reads raw data from DB, writes signals to DB)
		runAnalysisPipeline(db, TODAY);

		// Verify all 6 analysis results exist
		const analysisRows = db.select().from(schema.analysisResults).all();
		const types = analysisRows.map((r) => r.type).sort();
		expect(types).toEqual([
			"credit_risk",
			"liquidity_signal",
			"market_bias",
			"sentiment_signal",
			"usd_model",
			"yield_curve",
		]);

		// Step 3: Generate report (reads signals from DB, calls mock LLM, writes report to DB)
		const mockLlm = async (prompt: string, _model: string): Promise<string> => {
			// Verify prompt contains signal data
			expect(prompt).toContain("流动性");
			expect(prompt).toContain(TODAY);
			return "# Mock Daily Report\n\nThis is a test report with all signals.";
		};

		const content = await generateDailyReport(db, TODAY, mockLlm, "test-model");

		// Step 4: Verify report in DB
		const reports = db.select().from(schema.generatedReports).all();
		expect(reports).toHaveLength(1);
		expect(reports[0].date).toBe(TODAY);
		expect(reports[0].reportType).toBe("daily");
		expect(reports[0].model).toBe("test-model");
		expect(reports[0].content).toContain("Mock Daily Report");
		expect(content).toBe(reports[0].content);
	});

	it("pipeline with credit risk_off_confirmed triggers veto in market bias", async () => {
		const db = createTestDb();

		seedLiquidity(db);
		seedYields(db);
		seedCreditBreach(db); // HYG breach for consecutive days
		seedSentiment(db);

		runAnalysisPipeline(db, TODAY);

		const bias = db
			.select()
			.from(schema.analysisResults)
			.all()
			.find((r) => r.type === "market_bias");
		expect(bias).toBeDefined();

		const meta = typeof bias!.metadata === "string" ? JSON.parse(bias!.metadata) : bias!.metadata;
		expect(meta.overall_bias).toBe("risk_off");
		expect(meta.confidence).toBe("high");
		expect(meta.signals.credit).toBe("risk_off_confirmed");
	});

	it("pipeline with extreme fear + expanding liquidity tags contrarian opportunity", async () => {
		const db = createTestDb();

		// Expanding liquidity: WALCL jumps +600B in latest week
		// All series need matching dates so rolling change can align
		const commonDates = ["2025-02-20", "2025-02-27", "2025-03-05"];
		const walclValues = [7000000, 7000000, 7600000];
		const wtregenValues = [800000, 800000, 800000];
		const rrpValues = [90000, 90000, 90000];
		for (let i = 0; i < commonDates.length; i++) {
			db.insert(schema.liquiditySnapshots)
				.values({
					dataDate: commonDates[i],
					fetchedAt: "2025-03-05T00:00:00Z",
					seriesId: "WALCL",
					value: walclValues[i],
				})
				.run();
			db.insert(schema.liquiditySnapshots)
				.values({
					dataDate: commonDates[i],
					fetchedAt: "2025-03-05T00:00:00Z",
					seriesId: "WTREGEN",
					value: wtregenValues[i],
				})
				.run();
			db.insert(schema.liquiditySnapshots)
				.values({
					dataDate: commonDates[i],
					fetchedAt: "2025-03-05T00:00:00Z",
					seriesId: "RRPONTSYD",
					value: rrpValues[i],
				})
				.run();
		}
		for (const [sid, val] of [
			["SOFR", 5.33],
			["IORB", 5.4],
		] as [string, number][]) {
			for (const date of commonDates) {
				db.insert(schema.liquiditySnapshots)
					.values({ dataDate: date, fetchedAt: "2025-03-05T00:00:00Z", seriesId: sid, value: val })
					.run();
			}
		}

		seedYields(db);
		seedCredit(db);
		seedSentimentExtremeFear(db);

		runAnalysisPipeline(db, TODAY);

		const bias = db
			.select()
			.from(schema.analysisResults)
			.all()
			.find((r) => r.type === "market_bias");
		const meta = typeof bias!.metadata === "string" ? JSON.parse(bias!.metadata) : bias!.metadata;
		expect(meta.tags).toContain("超跌反弹机会");
	});

	it("multiple reports on same date append, not overwrite", async () => {
		const db = createTestDb();
		seedLiquidity(db);
		seedYields(db);
		seedCredit(db);
		seedSentiment(db);
		runAnalysisPipeline(db, TODAY);

		const mockLlm = async () => "Report v1";
		await generateDailyReport(db, TODAY, mockLlm, "model-a");

		const mockLlm2 = async () => "Report v2";
		await generateDailyReport(db, TODAY, mockLlm2, "model-b");

		const reports = db.select().from(schema.generatedReports).all();
		expect(reports).toHaveLength(2);
	});
});

describe("job run tracker", () => {
	it("records start, finish, and duration", () => {
		const db = createTestDb();

		const runId = startJobRun(db, "test-job");
		expect(runId).toBeGreaterThan(0);

		finishJobRun(db, runId, "success");

		const runs = getRecentJobRuns(db, "test-job", 5);
		expect(runs).toHaveLength(1);
		expect(runs[0].job).toBe("test-job");
		expect(runs[0].status).toBe("success");
		expect(runs[0].durationMs).toBeGreaterThanOrEqual(0);
		expect(runs[0].finishedAt).toBeTruthy();
	});

	it("records error status and message", () => {
		const db = createTestDb();

		const runId = startJobRun(db, "failing-job");
		finishJobRun(db, runId, "error", "Something went wrong");

		const runs = getRecentJobRuns(db, "failing-job", 5);
		expect(runs).toHaveLength(1);
		expect(runs[0].status).toBe("error");
		expect(runs[0].error).toBe("Something went wrong");
	});
});
