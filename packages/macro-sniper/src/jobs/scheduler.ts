import cron from "node-cron";
import {
	collectCreditSpreads,
	collectLiquidity,
	collectSentiment,
	collectUsdModelData,
	collectYields,
} from "../collectors/index.js";
import { loadConfig } from "../config.js";
import { getDb } from "../db/client.js";
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
		const content = await generateDailyReport(db, today, streamText, config.LLM_MODEL_FAST);
		finishJobRun(db, reportRunId, "success");

		// Step 4: Notify (Slack direct > Mom fallback)
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

	// Daily full pipeline at 06:00 ET
	scheduledTasks.push(
		cron.schedule(
			"0 6 * * *",
			async () => {
				log.info("Running scheduled full pipeline (06:00 ET)");
				await runFullPipeline(streamText);
			},
			{ timezone },
		),
	);

	// Liquidity collection at 08:00 ET
	scheduledTasks.push(
		cron.schedule(
			"0 8 * * *",
			async () => {
				const config = loadConfig();
				const db = getDb();
				await collectLiquidity(db, config.FRED_API_KEY);
			},
			{ timezone },
		),
	);

	// Yield collection at 17:30 ET
	scheduledTasks.push(
		cron.schedule(
			"30 17 * * *",
			async () => {
				const config = loadConfig();
				const db = getDb();
				await collectYields(db, config.FRED_API_KEY);
			},
			{ timezone },
		),
	);

	// Credit spread collection at 17:45 ET
	scheduledTasks.push(
		cron.schedule(
			"45 17 * * *",
			async () => {
				const db = getDb();
				await collectCreditSpreads(db);
			},
			{ timezone },
		),
	);

	// Sentiment collection every hour
	scheduledTasks.push(
		cron.schedule(
			"0 * * * *",
			async () => {
				const config = loadConfig();
				const db = getDb();
				await collectSentiment(db, {
					fredApiKey: config.FRED_API_KEY,
				});
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
