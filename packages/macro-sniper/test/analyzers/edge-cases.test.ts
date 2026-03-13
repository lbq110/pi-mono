import { beforeEach, describe, expect, it } from "vitest";
import { analyzeCreditRisk } from "../../src/analyzers/credit-risk.js";
import { analyzeLiquiditySignal } from "../../src/analyzers/liquidity-signal.js";
import { analyzeSentimentSignal } from "../../src/analyzers/sentiment-signal.js";
import { analyzeYieldCurve } from "../../src/analyzers/yield-curve.js";
import type { Db } from "../../src/db/client.js";
import * as schema from "../../src/db/schema.js";
import { createTestDb, seedCreditBreach, seedLiquidity, seedSentimentExtremeFear, TODAY } from "../helpers.js";

describe("analyzer edge cases", () => {
	let db: Db;

	beforeEach(() => {
		db = createTestDb();
	});

	it("liquidity: skips when DB has no data", () => {
		analyzeLiquiditySignal(db, TODAY);
		const rows = db.select().from(schema.analysisResults).all();
		expect(rows).toHaveLength(0);
	});

	it("yield curve: skips when insufficient data points", () => {
		// Only 2 data points, need 6
		db.insert(schema.yieldSnapshots)
			.values({ dataDate: "2025-03-04", fetchedAt: "2025-03-05T00:00:00Z", seriesId: "DGS2", value: 4.2 })
			.run();
		db.insert(schema.yieldSnapshots)
			.values({ dataDate: "2025-03-05", fetchedAt: "2025-03-05T00:00:00Z", seriesId: "DGS2", value: 4.3 })
			.run();
		db.insert(schema.yieldSnapshots)
			.values({ dataDate: "2025-03-04", fetchedAt: "2025-03-05T00:00:00Z", seriesId: "DGS10", value: 4.5 })
			.run();
		db.insert(schema.yieldSnapshots)
			.values({ dataDate: "2025-03-05", fetchedAt: "2025-03-05T00:00:00Z", seriesId: "DGS10", value: 4.6 })
			.run();

		analyzeYieldCurve(db, TODAY);
		const rows = db.select().from(schema.analysisResults).all();
		expect(rows).toHaveLength(0);
	});

	it("credit risk: skips when DB has insufficient data for MA20", () => {
		// Only 5 days, need 20
		for (let i = 0; i < 5; i++) {
			const date = `2025-03-0${i + 1}`;
			db.insert(schema.creditSnapshots)
				.values({ dataDate: date, fetchedAt: "2025-03-05T00:00:00Z", symbol: "HYG", price: 80 })
				.run();
			db.insert(schema.creditSnapshots)
				.values({ dataDate: date, fetchedAt: "2025-03-05T00:00:00Z", symbol: "IEF", price: 96 })
				.run();
		}

		analyzeCreditRisk(db, TODAY);
		const rows = db.select().from(schema.analysisResults).all();
		expect(rows).toHaveLength(0);
	});

	it("credit risk: detects risk_off_severe on consecutive severe breach", () => {
		seedCreditBreach(db); // HYG drops to 76 → -4.9% below MA20, 3 consecutive days → severe
		analyzeCreditRisk(db, TODAY);

		const rows = db.select().from(schema.analysisResults).all();
		expect(rows).toHaveLength(1);
		expect(rows[0].signal).toBe("risk_off_severe");

		const meta = typeof rows[0].metadata === "string" ? JSON.parse(rows[0].metadata) : rows[0].metadata;
		expect(meta.hyg_breach).toBe(true);
		expect(meta.credit_multiplier).toBe(0.0);
		expect(meta.consecutive_breach_days).toBeGreaterThanOrEqual(2);
	});

	it("sentiment: skips when VIX is missing", () => {
		// Only Fear & Greed, no VIX
		db.insert(schema.sentimentSnapshots)
			.values({
				dataDate: TODAY,
				fetchedAt: "2025-03-05T00:00:00Z",
				source: "alternative_me",
				metric: "fear_greed",
				value: 50,
			})
			.run();

		analyzeSentimentSignal(db, TODAY);
		const rows = db.select().from(schema.analysisResults).all();
		expect(rows).toHaveLength(0);
	});

	it("sentiment: extreme fear produces score < 20", () => {
		seedSentimentExtremeFear(db);
		analyzeSentimentSignal(db, TODAY);

		const rows = db.select().from(schema.analysisResults).all();
		expect(rows).toHaveLength(1);
		expect(rows[0].signal).toBe("extreme_fear");

		const meta = typeof rows[0].metadata === "string" ? JSON.parse(rows[0].metadata) : rows[0].metadata;
		expect(meta.composite_score).toBeLessThan(20);
	});

	it("upsert: different dates do not conflict", () => {
		seedLiquidity(db);
		analyzeLiquiditySignal(db, "2025-03-04");
		analyzeLiquiditySignal(db, "2025-03-05");

		const rows = db.select().from(schema.analysisResults).all();
		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.date).sort()).toEqual(["2025-03-04", "2025-03-05"]);
	});

	it("upsert: same date overwrites cleanly", () => {
		seedLiquidity(db);
		analyzeLiquiditySignal(db, TODAY);
		analyzeLiquiditySignal(db, TODAY);

		const rows = db.select().from(schema.analysisResults).all();
		expect(rows).toHaveLength(1);
	});

	it("yield curve: detects bull_steepener when short end drops faster", () => {
		// 2Y drops 10bps, 10Y flat
		const dates = ["2025-02-25", "2025-02-26", "2025-02-27", "2025-02-28", "2025-03-04", "2025-03-05"];
		const dgs2 = [4.3, 4.28, 4.26, 4.24, 4.22, 4.2];
		const dgs10 = [4.5, 4.5, 4.5, 4.5, 4.5, 4.5];

		for (let i = 0; i < dates.length; i++) {
			db.insert(schema.yieldSnapshots)
				.values({ dataDate: dates[i], fetchedAt: "2025-03-05T00:00:00Z", seriesId: "DGS2", value: dgs2[i] })
				.run();
			db.insert(schema.yieldSnapshots)
				.values({ dataDate: dates[i], fetchedAt: "2025-03-05T00:00:00Z", seriesId: "DGS10", value: dgs10[i] })
				.run();
		}
		db.insert(schema.yieldSnapshots)
			.values({ dataDate: TODAY, fetchedAt: "2025-03-05T00:00:00Z", seriesId: "T10Y2Y", value: 0.3 })
			.run();

		analyzeYieldCurve(db, TODAY);
		const rows = db.select().from(schema.analysisResults).all();
		expect(rows).toHaveLength(1);
		expect(rows[0].signal).toBe("bull_steepener");
	});
});
