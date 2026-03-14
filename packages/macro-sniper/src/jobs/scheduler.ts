import cron from "node-cron";
import { formatGapReminder } from "../analyzers/factor-analysis.js";
import {
	collectCreditSpreads,
	collectEconomicCalendar,
	collectHourlyPrices,
	collectLiquidity,
	collectMacroEvents,
	collectSentiment,
	collectSrfUsage,
	collectTreasuryAuctions,
	collectUsdModelData,
	collectYields,
	hasTodayHighImpactEvent,
} from "../collectors/index.js";
import { loadConfig } from "../config.js";
import { getDb } from "../db/client.js";
import { checkPendingPredictions } from "../executors/accuracy-tracker.js";
import { checkBtcCrashLinkage, checkStopLoss } from "../executors/risk-manager.js";
import { runTradeEngine } from "../executors/trade-engine.js";
import { createChildLogger } from "../logger.js";
import { notifyViaMom } from "../notifications/mom-events.js";
import { postToSlack } from "../notifications/slack.js";
import { generateDailyReport } from "../reporters/pipeline.js";
import { runAnalysisPipeline } from "./pipeline.js";
import { finishJobRun, startJobRun } from "./run-tracker.js";

const log = createChildLogger("job");

/** Track all scheduled cron tasks for cleanup. */
const scheduledTasks: cron.ScheduledTask[] = [];

/**
 * Run the full daily pipeline: collect → analyze → report → notify.
 * Used by both the scheduler and the `macro-sniper run` CLI command.
 */
export async function runFullPipeline(streamText: (prompt: string, model: string) => Promise<string>): Promise<void> {
	const config = loadConfig();
	const db = getDb();
	const today = new Date().toISOString().split("T")[0];

	// Step 1: Collect
	const collectRunId = startJobRun(db, "collect");
	try {
		await collectLiquidity(db, config.FRED_API_KEY);
		await collectYields(db, config.FRED_API_KEY);
		await collectCreditSpreads(db);
		await collectSentiment(db, {
			fredApiKey: config.FRED_API_KEY,
		});
		await collectUsdModelData(db, config.FRED_API_KEY);
		await collectHourlyPrices(db);
		await collectMacroEvents(db, config.FRED_API_KEY);
		await collectEconomicCalendar(db, config.FRED_API_KEY);
		await collectTreasuryAuctions(db);
		await collectSrfUsage(db);
		finishJobRun(db, collectRunId, "success");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		finishJobRun(db, collectRunId, "error", message);
		log.error({ error: message }, "Collection step failed");
	}

	// Step 2: Analyze
	const analyzeRunId = startJobRun(db, "analyze");
	try {
		runAnalysisPipeline(db, today);
		finishJobRun(db, analyzeRunId, "success");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		finishJobRun(db, analyzeRunId, "error", message);
		log.error({ error: message }, "Analysis step failed");
	}

	// Step 3: Report
	const reportRunId = startJobRun(db, "report");
	try {
		const content = await generateDailyReport(db, today, streamText, config.LLM_MODEL_HEAVY);
		finishJobRun(db, reportRunId, "success");

		// Step 4: Trade execution
		const tradeRunId = startJobRun(db, "trade");
		try {
			const result = await runTradeEngine(db);
			finishJobRun(db, tradeRunId, "success");
			log.info({ summary: result.summary }, "Trade engine executed");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			finishJobRun(db, tradeRunId, "error", message);
			log.error({ error: message }, "Trade engine failed (non-fatal, continuing to notify)");
		}

		// Step 5: Notify (Slack direct > Mom fallback)
		const notifyRunId = startJobRun(db, "notify");
		try {
			let notified = false;

			// Slack direct push
			if (config.SLACK_BOT_TOKEN && config.SLACK_CHANNEL_ID) {
				const slackOk = await postToSlack(content, {
					botToken: config.SLACK_BOT_TOKEN,
					channelId: config.SLACK_CHANNEL_ID,
				});
				if (slackOk) notified = true;
			}

			// Mom events fallback
			if (!notified && config.MOM_EVENTS_DIR && config.MOM_CHANNEL_ID) {
				notifyViaMom(content, `daily-report-${today}`, {
					eventsDir: config.MOM_EVENTS_DIR,
					channelId: config.MOM_CHANNEL_ID,
				});
				notified = true;
			}

			if (notified) {
				finishJobRun(db, notifyRunId, "success");
			} else {
				finishJobRun(db, notifyRunId, "skipped", "No notification channel configured");
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			finishJobRun(db, notifyRunId, "error", message);
			log.error({ error: message }, "Notification step failed");
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		finishJobRun(db, reportRunId, "error", message);
		log.error({ error: message }, "Report generation step failed");
	}
}

/**
 * Start the cron scheduler for all automated jobs.
 * All times are in ET (America/New_York).
 */
export function startScheduler(streamText: (prompt: string, model: string) => Promise<string>): void {
	log.info("Starting cron scheduler (ET timezone)");

	const timezone = "America/New_York";

	// Daily full pipeline at 08:00 ET (collect → analyze → report → notify)
	scheduledTasks.push(
		cron.schedule(
			"0 8 * * *",
			() => {
				log.info("Triggered: daily full pipeline (08:00 ET)");
				runFullPipeline(streamText)
					.then(() => log.info("Daily pipeline completed successfully"))
					.catch((err) =>
						log.error({ error: err instanceof Error ? err.message : String(err) }, "Daily pipeline failed"),
					);
			},
			{ timezone },
		),
	);

	// ─── Yield + Credit: after market close ──────
	// FRED yields update ~18:00 ET; Yahoo credit ETFs settle by 16:30 ET
	scheduledTasks.push(
		cron.schedule(
			"0 18 * * 1-5",
			() => {
				const config = loadConfig();
				const db = getDb();
				collectYields(db, config.FRED_API_KEY).catch((err) =>
					log.error({ error: err instanceof Error ? err.message : String(err) }, "Yield collection failed"),
				);
				collectCreditSpreads(db).catch((err) =>
					log.error(
						{ error: err instanceof Error ? err.message : String(err) },
						"Credit spread collection failed",
					),
				);
			},
			{ timezone },
		),
	);

	// ─── Liquidity + SRF: daily 17:00 ET Mon-Fri ─
	// TGA (WTREGEN) and RRP (RRPONTSYD) update daily ~15:30-16:00 ET
	// WALCL updates weekly on Thursday ~16:30 ET
	// SRF results published after 13:45 ET operation
	// Net liquidity = WALCL - TGA - RRP changes daily via TGA/RRP
	scheduledTasks.push(
		cron.schedule(
			"0 17 * * 1-5",
			() => {
				const config = loadConfig();
				const db = getDb();
				collectLiquidity(db, config.FRED_API_KEY).catch((err) =>
					log.error({ error: err instanceof Error ? err.message : String(err) }, "Liquidity collection failed"),
				);
				collectSrfUsage(db).catch((err) =>
					log.error({ error: err instanceof Error ? err.message : String(err) }, "SRF collection failed"),
				);
			},
			{ timezone },
		),
	);

	// ─── Macro events: post-release collection ───
	// Most releases are 08:30 or 10:00 ET → collect at 08:45 and 10:15
	scheduledTasks.push(
		cron.schedule(
			"45 8 * * 1-5",
			() => {
				const config = loadConfig();
				const db = getDb();
				// Only fetch if today has events (avoid wasting FRED requests)
				if (hasTodayHighImpactEvent(db)) {
					log.info("High-impact event today — collecting macro data post 08:30 release");
					collectMacroEvents(db, config.FRED_API_KEY).catch((err) =>
						log.error(
							{ error: err instanceof Error ? err.message : String(err) },
							"Macro event collection failed",
						),
					);
				}
			},
			{ timezone },
		),
	);

	// 10:15 ET catch for 10:00 releases (ISM, Michigan Sentiment)
	scheduledTasks.push(
		cron.schedule(
			"15 10 * * 1-5",
			() => {
				const config = loadConfig();
				const db = getDb();
				if (hasTodayHighImpactEvent(db)) {
					log.info("Collecting macro data post 10:00 release");
					collectMacroEvents(db, config.FRED_API_KEY).catch((err) =>
						log.error(
							{ error: err instanceof Error ? err.message : String(err) },
							"Macro event collection failed",
						),
					);
				}
			},
			{ timezone },
		),
	);

	// FOMC: 14:15 ET (decisions at 14:00)
	scheduledTasks.push(
		cron.schedule(
			"15 14 * * 3",
			() => {
				const config = loadConfig();
				const db = getDb();
				if (hasTodayHighImpactEvent(db)) {
					log.info("FOMC decision day — collecting post 14:00 release");
					collectMacroEvents(db, config.FRED_API_KEY).catch((err) =>
						log.error({ error: err instanceof Error ? err.message : String(err) }, "FOMC collection failed"),
					);
				}
			},
			{ timezone },
		),
	);

	// ─── Treasury auctions: 13:15 ET Mon-Fri ─────
	// Note/Bond auctions close at 13:00 ET, results ~13:05
	scheduledTasks.push(
		cron.schedule(
			"15 13 * * 1-5",
			() => {
				const db = getDb();
				collectTreasuryAuctions(db).catch((err) =>
					log.error(
						{ error: err instanceof Error ? err.message : String(err) },
						"Treasury auction collection failed",
					),
				);
			},
			{ timezone },
		),
	);

	// ─── Factor gap reminder: every 3 days ───────
	// Sends factor gap analysis to Slack, highlighting easy-to-add factors
	scheduledTasks.push(
		cron.schedule(
			"0 9 */3 * *",
			() => {
				try {
					const msg = formatGapReminder();
					const config = loadConfig();
					if (config.SLACK_BOT_TOKEN && config.SLACK_CHANNEL_ID) {
						postToSlack(msg, {
							botToken: config.SLACK_BOT_TOKEN,
							channelId: config.SLACK_CHANNEL_ID,
						}).catch((err) =>
							log.error(
								{ error: err instanceof Error ? err.message : String(err) },
								"Factor gap Slack send failed",
							),
						);
					}
					log.info("Factor gap reminder sent");
				} catch (err) {
					log.error({ error: err instanceof Error ? err.message : String(err) }, "Factor gap reminder failed");
				}
			},
			{ timezone },
		),
	);

	// ─── Calendar refresh: weekly Sunday ─────────
	scheduledTasks.push(
		cron.schedule(
			"0 20 * * 0",
			() => {
				const config = loadConfig();
				const db = getDb();
				collectEconomicCalendar(db, config.FRED_API_KEY).catch((err) =>
					log.error({ error: err instanceof Error ? err.message : String(err) }, "Calendar collection failed"),
				);
			},
			{ timezone },
		),
	);

	// ─── Prediction accuracy: 09:30 ET Mon-Fri ──
	scheduledTasks.push(
		cron.schedule(
			"30 9 * * 1-5",
			() => {
				const db = getDb();
				try {
					checkPendingPredictions(db);
				} catch (err) {
					log.error(
						{ error: err instanceof Error ? err.message : String(err) },
						"Prediction accuracy check failed",
					);
				}
			},
			{ timezone },
		),
	);

	// ─── Hourly: risk checks at :00 ─────────────
	scheduledTasks.push(
		cron.schedule(
			"0 * * * *",
			() => {
				const db = getDb();
				checkStopLoss(db)
					.then((r) => {
						if (r.triggered) {
							log.warn({ events: r.events.length }, "L1 stop-loss triggered during hourly check");
						}
					})
					.catch((err) =>
						log.error({ error: err instanceof Error ? err.message : String(err) }, "L1 stop-loss check failed"),
					);
				checkBtcCrashLinkage(db)
					.then((r) => {
						if (r.triggered) {
							log.warn(
								{ btcReturn24h: r.btcReturn24h, reductions: r.reductions.length },
								"L4 BTC crash linkage triggered",
							);
						}
					})
					.catch((err) =>
						log.error({ error: err instanceof Error ? err.message : String(err) }, "L4 BTC crash check failed"),
					);
			},
			{ timezone },
		),
	);

	// ─── Hourly: BTC-only trade at :05 ──────────
	// IMPORTANT: Only execute BTC trades hourly. Equity/UUP trades happen
	// once daily at 08:00 ET via the full pipeline. Running all instruments
	// hourly caused rapid open/close churn during market hours.
	scheduledTasks.push(
		cron.schedule(
			"5 * * * *",
			() => {
				const db = getDb();
				runTradeEngine(db, ["BTCUSD"])
					.then((r) => log.info({ summary: r.summary }, "Hourly BTC trade check done"))
					.catch((err) =>
						log.error(
							{ error: err instanceof Error ? err.message : String(err) },
							"Hourly BTC trade check failed",
						),
					);
			},
			{ timezone },
		),
	);

	// ─── Hourly: real-time data at :30 ──────────
	// Hourly prices (Yahoo + Binance klines) + BTC derivatives + crypto on-chain
	// F&G index, CoinMetrics, ETF volume — all daily data, collected once at :30
	scheduledTasks.push(
		cron.schedule(
			"30 * * * *",
			() => {
				const config = loadConfig();
				const db = getDb();
				collectHourlyPrices(db).catch((err) =>
					log.error({ error: err instanceof Error ? err.message : String(err) }, "Hourly price collection failed"),
				);
				collectSentiment(db, { fredApiKey: config.FRED_API_KEY }).catch((err) =>
					log.error({ error: err instanceof Error ? err.message : String(err) }, "Sentiment collection failed"),
				);
			},
			{ timezone },
		),
	);

	log.info("Cron scheduler started with all jobs registered");
}

/** Stop all scheduled cron tasks. */
export function stopScheduler(): void {
	for (const task of scheduledTasks) {
		task.stop();
	}
	scheduledTasks.length = 0;
	log.info("Cron scheduler stopped");
}
