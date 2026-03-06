#!/usr/bin/env node

import { Command } from "commander";
import { desc, eq } from "drizzle-orm";
import { analyzeLiquiditySignal } from "./analyzers/liquidity-signal.js";
import { analyzeUsdModel } from "./analyzers/usd-model.js";
import {
	collectCreditSpreads,
	collectLiquidity,
	collectSentiment,
	collectUsdModelData,
	collectYields,
} from "./collectors/index.js";
import { loadConfig } from "./config.js";
import { closeDb, getDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { analysisResults, generatedReports } from "./db/schema.js";
import { runAnalysisPipeline } from "./jobs/pipeline.js";
import { getRecentJobRuns } from "./jobs/run-tracker.js";
import { runFullPipeline, startScheduler, stopScheduler } from "./jobs/scheduler.js";
import { streamText } from "./llm.js";
import { createChildLogger, logger } from "./logger.js";
import { generateDailyReport } from "./reporters/pipeline.js";

const log = createChildLogger("cli");

const program = new Command();

program
	.name("macro-sniper")
	.description("Macro liquidity, bond market, and crypto sentiment analysis CLI")
	.version("0.52.10");

// ─── Database init (auto-migrate) ────────────────

function initDb() {
	const config = loadConfig();
	runMigrations(config.DATABASE_PATH);
	return getDb(config.DATABASE_PATH);
}

// ─── collect commands ────────────────────────────

const collect = program.command("collect").description("Collect data from external sources");

collect
	.command("liquidity")
	.description("Collect liquidity data from FRED")
	.action(async () => {
		const config = loadConfig();
		const db = initDb();
		await collectLiquidity(db, config.FRED_API_KEY);
		closeDb();
	});

collect
	.command("bonds")
	.description("Collect bond yield and credit spread data")
	.action(async () => {
		const config = loadConfig();
		const db = initDb();
		await collectYields(db, config.FRED_API_KEY);
		await collectCreditSpreads(db);
		closeDb();
	});

collect
	.command("sentiment")
	.description("Collect sentiment data")
	.action(async () => {
		const config = loadConfig();
		const db = initDb();
		await collectSentiment(db, {
			fredApiKey: config.FRED_API_KEY,
		});
		closeDb();
	});

collect
	.command("fx")
	.description("Collect FX rates and USD model data (DXY, pairs, term premium, BEI)")
	.action(async () => {
		const config = loadConfig();
		const db = initDb();
		await collectUsdModelData(db, config.FRED_API_KEY);
		closeDb();
	});

collect
	.command("all")
	.description("Collect all data sources")
	.action(async () => {
		const config = loadConfig();
		const db = initDb();
		await collectLiquidity(db, config.FRED_API_KEY);
		await collectYields(db, config.FRED_API_KEY);
		await collectCreditSpreads(db);
		await collectSentiment(db, {
			fredApiKey: config.FRED_API_KEY,
		});
		await collectUsdModelData(db, config.FRED_API_KEY);
		closeDb();
	});

// ─── analyze commands ────────────────────────────

const analyze = program.command("analyze").description("Run analysis engines");

analyze
	.command("all")
	.description("Run all analysis engines")
	.action(() => {
		const db = initDb();
		const today = new Date().toISOString().split("T")[0];
		runAnalysisPipeline(db, today);
		closeDb();
	});

analyze
	.command("liquidity")
	.description("Analyze liquidity signal only")
	.action(() => {
		const db = initDb();
		const today = new Date().toISOString().split("T")[0];
		analyzeLiquiditySignal(db, today);
		closeDb();
	});

analyze
	.command("usd")
	.description("Analyze USD model only")
	.action(() => {
		const db = initDb();
		const today = new Date().toISOString().split("T")[0];
		analyzeUsdModel(db, today);
		closeDb();
	});

// Default: analyze all
analyze.action(() => {
	const db = initDb();
	const today = new Date().toISOString().split("T")[0];
	runAnalysisPipeline(db, today);
	closeDb();
});

// ─── data query commands ─────────────────────────

program
	.command("liquidity")
	.description("View latest liquidity data and signal")
	.action(() => {
		const db = initDb();
		const rows = db
			.select()
			.from(analysisResults)
			.where(eq(analysisResults.type, "liquidity_signal"))
			.orderBy(desc(analysisResults.createdAt))
			.limit(1)
			.all();

		if (rows.length === 0) {
			console.log("No liquidity analysis found. Run: macro-sniper collect liquidity && macro-sniper analyze");
		} else {
			const row = rows[0];
			console.log(`Date: ${row.date}`);
			console.log(`Signal: ${row.signal}`);
			console.log("Metadata:", JSON.stringify(row.metadata, null, 2));
		}
		closeDb();
	});

program
	.command("bonds")
	.description("View bond market data")
	.command("regime")
	.description("View current yield curve regime")
	.action(() => {
		const db = initDb();
		const rows = db
			.select()
			.from(analysisResults)
			.where(eq(analysisResults.type, "yield_curve"))
			.orderBy(desc(analysisResults.createdAt))
			.limit(1)
			.all();

		if (rows.length === 0) {
			console.log("No yield curve analysis found. Run: macro-sniper collect bonds && macro-sniper analyze");
		} else {
			const row = rows[0];
			console.log(`Date: ${row.date}`);
			console.log(`Curve Regime: ${row.signal}`);
			console.log("Metadata:", JSON.stringify(row.metadata, null, 2));
		}
		closeDb();
	});

program
	.command("sentiment")
	.description("View latest sentiment data")
	.action(() => {
		const db = initDb();
		const rows = db
			.select()
			.from(analysisResults)
			.where(eq(analysisResults.type, "sentiment_signal"))
			.orderBy(desc(analysisResults.createdAt))
			.limit(1)
			.all();

		if (rows.length === 0) {
			console.log("No sentiment analysis found. Run: macro-sniper collect sentiment && macro-sniper analyze");
		} else {
			const row = rows[0];
			console.log(`Date: ${row.date}`);
			console.log(`Signal: ${row.signal}`);
			console.log("Metadata:", JSON.stringify(row.metadata, null, 2));
		}
		closeDb();
	});

program
	.command("usd")
	.description("View latest USD model analysis")
	.action(() => {
		const db = initDb();
		const rows = db
			.select()
			.from(analysisResults)
			.where(eq(analysisResults.type, "usd_model"))
			.orderBy(desc(analysisResults.createdAt))
			.limit(1)
			.all();

		if (rows.length === 0) {
			console.log("No USD model analysis found. Run: macro-sniper collect fx && macro-sniper analyze usd");
		} else {
			const row = rows[0];
			console.log(`Date: ${row.date}`);
			console.log(`Signal: ${row.signal}`);
			console.log("Metadata:", JSON.stringify(row.metadata, null, 2));
		}
		closeDb();
	});

// ─── report commands ─────────────────────────────

const report = program.command("report").description("Daily report operations");

report
	.command("today")
	.description("View today's report")
	.action(() => {
		logger.level = "silent";
		const db = initDb();
		const today = new Date().toISOString().split("T")[0];
		const rows = db
			.select()
			.from(generatedReports)
			.where(eq(generatedReports.date, today))
			.orderBy(desc(generatedReports.createdAt))
			.limit(1)
			.all();

		if (rows.length === 0) {
			console.log("No report found for today. Run: macro-sniper report generate");
		} else {
			console.log(rows[0].content);
		}
		closeDb();
	});

report
	.command("generate")
	.description("Generate daily report now")
	.action(async () => {
		const config = loadConfig();
		const db = initDb();
		const today = new Date().toISOString().split("T")[0];
		const content = await generateDailyReport(db, today, streamText, config.LLM_MODEL_FAST);
		console.log(content);
		closeDb();
	});

// ─── run (full pipeline) ─────────────────────────

program
	.command("run")
	.description("Run full pipeline: collect → analyze → report → notify")
	.action(async () => {
		initDb();
		await runFullPipeline(streamText);
		closeDb();
	});

// ─── jobs commands ───────────────────────────────

const jobs = program.command("jobs").description("Cron job management");

jobs
	.command("start")
	.description("Start cron scheduler (foreground)")
	.action(() => {
		initDb();
		startScheduler(streamText);
		log.info("Scheduler running. Press Ctrl+C to stop.");

		// Keep process alive
		process.on("SIGINT", () => {
			stopScheduler();
			closeDb();
			process.exit(0);
		});
		process.on("SIGTERM", () => {
			stopScheduler();
			closeDb();
			process.exit(0);
		});
	});

jobs
	.command("status")
	.description("View recent job runs")
	.action(() => {
		const db = initDb();
		for (const jobName of ["collect", "analyze", "report", "notify"]) {
			const runs = getRecentJobRuns(db, jobName, 5);
			if (runs.length > 0) {
				console.log(`\n── ${jobName} ──`);
				for (const run of runs) {
					const duration = run.durationMs ? `${run.durationMs}ms` : "n/a";
					console.log(`  ${run.startedAt} | ${run.status} | ${duration}${run.error ? ` | ${run.error}` : ""}`);
				}
			}
		}
		closeDb();
	});

jobs
	.command("stop")
	.description("Stop scheduler (sends SIGTERM)")
	.action(() => {
		// This command would need to find and signal the running process.
		// For now, just stop in-process.
		stopScheduler();
		console.log("Scheduler stop signal sent.");
	});

// ─── db commands ─────────────────────────────────

program
	.command("db:migrate")
	.description("Run database migrations")
	.action(() => {
		initDb();
		console.log("Database migrated successfully.");
		closeDb();
	});

// ─── Parse and execute ───────────────────────────

program.parse();
