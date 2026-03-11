#!/usr/bin/env node

import { Command } from "commander";
import { desc, eq } from "drizzle-orm";
import { analyzeBtcSignal } from "./analyzers/btc-signal.js";
import { computeCorrelationMatrix } from "./analyzers/correlation.js";
import { analyzeLiquiditySignal } from "./analyzers/liquidity-signal.js";
import { analyzeUsdModel } from "./analyzers/usd-model.js";
import {
	collectCreditSpreads,
	collectHourlyPrices,
	collectLiquidity,
	collectSentiment,
	collectUsdModelData,
	collectYields,
} from "./collectors/index.js";
import { loadConfig } from "./config.js";
import { closeDb, getDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { analysisResults, generatedReports } from "./db/schema.js";
import {
	checkPendingPredictions,
	createPredictionSnapshot,
	formatAccuracyReport,
} from "./executors/accuracy-tracker.js";
import {
	checkStopLoss,
	getLastStopLossEvent,
	getPortfolioHWM,
	getRiskLevel,
	getRiskMultiplier,
	isInStopLossCooldown,
	STOP_LOSS_THRESHOLD,
} from "./executors/risk-manager.js";
import { previewScores, runTradeEngine } from "./executors/trade-engine.js";
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
	.command("hourly")
	.description("Collect hourly OHLCV data (SPY/QQQ/IWM/DXY/BTC) + BTC 24h stats")
	.action(async () => {
		const db = initDb();
		await collectHourlyPrices(db);
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
		await collectSentiment(db, { fredApiKey: config.FRED_API_KEY });
		await collectUsdModelData(db, config.FRED_API_KEY);
		await collectHourlyPrices(db);
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

analyze
	.command("btc")
	.description("Analyze BTC signal (MA7d, volume, sharp drop alert)")
	.action(() => {
		const db = initDb();
		const today = new Date().toISOString().split("T")[0];
		analyzeBtcSignal(db, today);
		closeDb();
	});

analyze
	.command("correlation")
	.description("Compute rolling correlation matrix (7d hourly + 30d daily)")
	.action(() => {
		const db = initDb();
		const today = new Date().toISOString().split("T")[0];
		computeCorrelationMatrix(db, today);
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

// ─── trade commands ──────────────────────────────

const trade = program.command("trade").description("Paper trading execution");

trade
	.command("preview")
	.description("Preview signal scores without executing trades")
	.action(() => {
		const db = initDb();
		const scores = previewScores(db);
		const {
			SPY,
			QQQ,
			IWM,
			BTCUSD,
			UUP,
			inflationRegime,
			marketBias,
			marketBiasConfidence,
			riskLevel,
			riskMultiplier,
			atrInfo,
			kellyFraction,
		} = scores;
		console.log(`\n── Market Context ──`);
		console.log(`  Bias:      ${marketBias} (${marketBiasConfidence})`);
		console.log(
			`  Inflation: ${inflationRegime.regime} | BEI10y=${inflationRegime.bei10y.toFixed(2)}% | GLD5d=${inflationRegime.gld5dMomentum.toFixed(2)}% | GLD20d=${inflationRegime.gld20dTrend.toFixed(2)}%`,
		);
		console.log(`  Risk:      ${riskLevel} (×${riskMultiplier})`);
		if (kellyFraction !== null) console.log(`  Kelly:     1/4 f* = ${(kellyFraction * 100).toFixed(1)}%`);
		console.log(`\n── ATR (14d) ──`);
		for (const [sym, info] of Object.entries(atrInfo)) {
			console.log(`  ${sym.padEnd(8)} ATR=${info.atrPct.toFixed(2)}%  stop=${info.stopPct.toFixed(2)}%`);
		}
		console.log(`\n── Instrument Scores ──`);
		for (const s of [SPY, QQQ, IWM, BTCUSD, UUP]) {
			const veto = s.creditVeto ? " [CREDIT_VETO]" : s.btcSyncVeto ? " [BTC_SYNC_VETO]" : "";
			console.log(
				`  ${s.symbol.padEnd(8)} score=${s.finalScore.toFixed(1).padStart(7)}  ${s.direction.padEnd(5)}  ${(s.sizeMultiplier * 100).toFixed(0).padStart(3)}%  $${s.notionalFinal.toFixed(0).padStart(6)}${veto}`,
			);
			console.log(
				`           liq=${s.evidence.liquidity.contribution.toFixed(1)} curve=${s.evidence.yieldCurve.contribution.toFixed(1)} sent=${s.evidence.sentiment.contribution.toFixed(1)} usd=${s.evidence.usdModel.contribution.toFixed(1)} btcmod=${s.evidence.btcEquityModifier}`,
			);
			if (s.evidence.rotationNote !== "n/a for BTC") console.log(`           rotation: ${s.evidence.rotationNote}`);
			if (s.evidence.conflictNote) console.log(`           conflict: ${s.evidence.conflictNote}`);
			if (s.evidence.corrRegimeNote) console.log(`           corr: ${s.evidence.corrRegimeNote}`);
		}
		closeDb();
	});

trade
	.command("run")
	.description("Execute trades based on current signals")
	.action(async () => {
		const db = initDb();
		const result = await runTradeEngine(db);
		console.log(`\n── Trade Execution ──`);
		console.log(`  Market open: ${result.marketOpen}`);
		console.log(`  ${result.summary}`);
		console.log(`\n── Decisions ──`);
		for (const d of result.decisions) {
			console.log(
				`  ${d.symbol.padEnd(8)} ${d.action.padEnd(12)} ${d.currentDirection} → ${d.targetDirection}  $${d.targetNotional.toFixed(0)}`,
			);
			console.log(`           ${d.reason}`);
		}
		console.log(`\n── Orders ──`);
		for (const o of result.orders) {
			if (o.status !== "skipped") {
				console.log(
					`  ${o.symbol.padEnd(8)} ${o.side}  status=${o.status}  orderId=${o.alpacaOrderId ?? "n/a"}${o.error ? `  error=${o.error}` : ""}`,
				);
			}
		}
		closeDb();
	});

// ─── risk commands ────────────────────────────────

const risk = program.command("risk").description("Risk management (L1 stop-loss)");

risk
	.command("check")
	.description("Manually run L1 stop-loss check on all open positions")
	.action(async () => {
		const db = initDb();
		const result = await checkStopLoss(db);
		if (!result.triggered) {
			console.log(`No stop-loss breaches (threshold: ${(STOP_LOSS_THRESHOLD * 100).toFixed(0)}%).`);
		} else {
			console.log(`\n── L1 Stop-Loss Events ──`);
			for (const e of result.events) {
				const pct = (e.pnlPct * 100).toFixed(2);
				console.log(
					`  ${e.symbol.padEnd(8)} pnl=${pct}%  qty=${e.qty.toFixed(4)}  price=$${e.price.toFixed(2)}  closed=${e.closed}${e.error ? `  error=${e.error}` : ""}`,
				);
			}
		}
		closeDb();
	});

risk
	.command("status")
	.description("Show risk event history and current cooldown status")
	.action(() => {
		const db = initDb();
		const symbols = ["SPY", "QQQ", "IWM", "BTCUSD", "UUP"];
		console.log(`\n── Risk Status (L1 threshold: ${(STOP_LOSS_THRESHOLD * 100).toFixed(0)}%) ──`);
		for (const sym of symbols) {
			const inCooldown = isInStopLossCooldown(db, sym);
			const lastEvent = getLastStopLossEvent(db, sym);
			if (lastEvent) {
				const pct = (lastEvent.triggerValue * 100).toFixed(2);
				const cooldownStr =
					inCooldown && lastEvent.cooldownUntil
						? `cooldown until ${new Date(lastEvent.cooldownUntil).toLocaleString("zh-CN", { timeZone: "America/New_York", hour12: false })}`
						: "no cooldown";
				console.log(
					`  ${sym.padEnd(8)} last stop-loss: ${pct}% on ${lastEvent.createdAt.slice(0, 16)}  ${cooldownStr}`,
				);
			} else {
				console.log(`  ${sym.padEnd(8)} no stop-loss events`);
			}
		}

		// Drawdown tier info
		const riskLevel = getRiskLevel(db);
		const riskMult = getRiskMultiplier(db);
		const hwm = getPortfolioHWM(db);
		console.log(`\n── Drawdown Tier ──`);
		console.log(`  Level:      ${riskLevel} (multiplier: ${riskMult})`);
		console.log(`  Portfolio HWM: $${hwm.toFixed(2)}`);
		closeDb();
	});

// ─── accuracy commands ────────────────────────────

const accuracy = program.command("accuracy").description("Prediction accuracy tracking");

accuracy
	.command("report")
	.description("Show prediction accuracy report with optimization hints")
	.action(() => {
		const db = initDb();
		console.log(formatAccuracyReport(db));
		closeDb();
	});

accuracy
	.command("check")
	.description("Manually trigger T+5 accuracy evaluation for pending predictions")
	.action(() => {
		const db = initDb();
		checkPendingPredictions(db);
		console.log("Accuracy check complete.");
		closeDb();
	});

accuracy
	.command("snapshot")
	.description("Manually create a prediction snapshot for today")
	.action(() => {
		const db = initDb();
		const today = new Date().toISOString().split("T")[0];
		createPredictionSnapshot(db, today);
		console.log(`Snapshot created for ${today}.`);
		closeDb();
	});

// ─── portfolio commands ───────────────────────────

const portfolio = program.command("portfolio").description("Paper trading portfolio management");

portfolio
	.command("status")
	.description("Show current positions and account summary")
	.action(async () => {
		const { getPortfolioSummary } = await import("./broker/alpaca.js");
		const summary = await getPortfolioSummary();
		console.log("\n── Account ──");
		console.log(`  Equity:        $${summary.equity.toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
		console.log(`  Cash:          $${summary.cash.toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
		console.log(`  Buying Power:  $${summary.buyingPower.toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
		const pnlSign = summary.totalUnrealizedPnl >= 0 ? "+" : "";
		console.log(`  Unrealized P&L: ${pnlSign}$${summary.totalUnrealizedPnl.toFixed(2)}`);

		if (summary.positions.length === 0) {
			console.log("\n── Positions: none ──");
		} else {
			console.log("\n── Positions ──");
			for (const p of summary.positions) {
				const pnlSign = p.unrealizedPnl >= 0 ? "+" : "";
				console.log(
					`  ${p.symbol.padEnd(8)} ${p.direction.padEnd(6)} qty=${p.qty.toFixed(4).padStart(10)}` +
						`  cost=$${p.avgCost.toFixed(2)}  now=$${p.currentPrice.toFixed(2)}` +
						`  P&L: ${pnlSign}$${p.unrealizedPnl.toFixed(2)} (${pnlSign}${p.unrealizedPnlPct.toFixed(2)}%)`,
				);
			}
		}
	});

portfolio
	.command("orders")
	.description("Show recent orders")
	.action(async () => {
		const { getAlpacaClient } = await import("./broker/alpaca.js");
		const client = getAlpacaClient();
		const orders = await client.getOrders("all", 20);
		console.log("\n── Recent Orders (last 20) ──");
		if (orders.length === 0) {
			console.log("  No orders found.");
		} else {
			for (const o of orders) {
				const price = o.filled_avg_price ? `@$${Number.parseFloat(o.filled_avg_price).toFixed(2)}` : "";
				console.log(
					`  ${o.created_at.slice(0, 19)}  ${o.symbol.padEnd(8)}  ${o.side.padEnd(5)}  qty=${o.qty.padStart(8)}  ${o.status.padEnd(10)}  ${price}`,
				);
			}
		}
	});

portfolio
	.command("reset")
	.description("Close all positions and cancel all orders")
	.action(async () => {
		const { getAlpacaClient } = await import("./broker/alpaca.js");
		const client = getAlpacaClient();
		await client.cancelAllOrders();
		await client.closeAllPositions();
		console.log("All positions closed and orders cancelled.");
	});

// ─── Parse and execute ───────────────────────────

program.parse();
