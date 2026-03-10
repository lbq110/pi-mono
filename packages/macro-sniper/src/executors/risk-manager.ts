import { and, desc, eq, gte } from "drizzle-orm";
import { getAlpacaClient } from "../broker/alpaca.js";
import { loadConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { riskEvents } from "../db/schema.js";
import { createChildLogger } from "../logger.js";
import { postToSlack } from "../notifications/slack.js";

const log = createChildLogger("executor");

// ─── L1 Thresholds ───────────────────────────────

/** Single-position stop-loss threshold: -8% unrealized P&L */
export const STOP_LOSS_THRESHOLD = -0.08;

/** Cool-down duration after stop-loss: 24 hours */
const COOLDOWN_HOURS = 24;

// ─── Cooldown check (used by trade-engine) ────────

/**
 * Returns true if the symbol is currently within a stop-loss cooldown window.
 * The trade engine calls this before placing a buy order.
 */
export function isInStopLossCooldown(db: Db, symbol: string): boolean {
	const now = new Date().toISOString();
	const rows = db
		.select({ id: riskEvents.id })
		.from(riskEvents)
		.where(
			and(
				eq(riskEvents.symbol, symbol),
				eq(riskEvents.eventType, "stop_loss_l1"),
				gte(riskEvents.cooldownUntil, now),
			),
		)
		.limit(1)
		.all();
	return rows.length > 0;
}

/**
 * Get the most recent stop-loss event for a symbol, if any.
 */
export function getLastStopLossEvent(
	db: Db,
	symbol: string,
): {
	triggerValue: number;
	createdAt: string;
	cooldownUntil: string | null;
} | null {
	const rows = db
		.select({
			triggerValue: riskEvents.triggerValue,
			createdAt: riskEvents.createdAt,
			cooldownUntil: riskEvents.cooldownUntil,
		})
		.from(riskEvents)
		.where(and(eq(riskEvents.symbol, symbol), eq(riskEvents.eventType, "stop_loss_l1")))
		.orderBy(desc(riskEvents.createdAt))
		.limit(1)
		.all();
	return rows.length > 0 ? rows[0] : null;
}

// ─── Slack alert ──────────────────────────────────

async function sendStopLossAlert(
	config: ReturnType<typeof loadConfig>,
	symbol: string,
	pnlPct: number,
	pnlAbs: number,
	qty: number,
	price: number,
	cooldownUntil: string,
): Promise<void> {
	if (!config.SLACK_BOT_TOKEN || !config.SLACK_CHANNEL_ID) return;

	const now = new Date().toLocaleString("zh-CN", { timeZone: "America/New_York", hour12: false });
	const pnlSign = pnlAbs >= 0 ? "+" : "";
	const cooldownDate = new Date(cooldownUntil).toLocaleString("zh-CN", {
		timeZone: "America/New_York",
		hour12: false,
		month: "numeric",
		day: "numeric",
		hour: "numeric",
		minute: "numeric",
	});

	const text = [
		`🚨 *[L1 单仓止损触发]* ${symbol}`,
		``,
		`*未实现亏损：* ${(pnlPct * 100).toFixed(2)}%（阈值 ${(STOP_LOSS_THRESHOLD * 100).toFixed(0)}%）`,
		`*绝对亏损：* ${pnlSign}$${pnlAbs.toFixed(2)}`,
		`*平仓价：* $${price.toFixed(2)}　*数量：* ${qty.toFixed(4)}`,
		`*触发时间：* ${now} ET`,
		`*冷却到期：* ${cooldownDate} ET（24h 内不再入场此标的）`,
	].join("\n");

	await postToSlack(text, {
		botToken: config.SLACK_BOT_TOKEN,
		channelId: config.SLACK_CHANNEL_ID,
	});
}

// ─── L1 Main checker ─────────────────────────────

export interface StopLossResult {
	triggered: boolean;
	events: {
		symbol: string;
		pnlPct: number;
		pnlAbs: number;
		qty: number;
		price: number;
		closed: boolean;
		error?: string;
	}[];
}

/**
 * L1 Stop-Loss Check: runs hourly.
 *
 * For each open position:
 *   - If unrealized_plpc < -8%: close immediately, record event, send Slack alert
 *   - Set 24-hour cooldown to prevent immediate re-entry
 *
 * Returns summary of triggered events.
 */
export async function checkStopLoss(db: Db): Promise<StopLossResult> {
	const config = loadConfig();
	const client = getAlpacaClient();
	const now = new Date().toISOString();

	// Alpaca returns unrealized_plpc as a decimal (e.g. -0.092 = -9.2%)
	const alpacaPositions = await client.getPositions();

	const result: StopLossResult = { triggered: false, events: [] };

	for (const position of alpacaPositions) {
		const pnlPct = Number.parseFloat(position.unrealized_plpc);
		const pnlAbs = Number.parseFloat(position.unrealized_pl);
		const qty = Number.parseFloat(position.qty);
		const currentPrice = Number.parseFloat(position.current_price);
		const symbol = position.symbol;

		if (pnlPct >= STOP_LOSS_THRESHOLD) continue; // no breach

		log.warn({ symbol, pnlPct: (pnlPct * 100).toFixed(2) }, "L1 stop-loss threshold breached, closing position");
		result.triggered = true;

		try {
			// Close the position
			const order = await client.closePosition(symbol);
			const filledPrice = order?.filled_avg_price ? Number.parseFloat(order.filled_avg_price) : currentPrice;

			// Compute cooldown: now + 24 hours
			const cooldownUntil = new Date(Date.now() + COOLDOWN_HOURS * 60 * 60 * 1000).toISOString();

			// Record risk event
			db.insert(riskEvents)
				.values({
					eventType: "stop_loss_l1",
					symbol,
					triggerValue: pnlPct,
					threshold: STOP_LOSS_THRESHOLD,
					action: "closed_position",
					qtyAtClose: qty,
					priceAtClose: filledPrice,
					pnlAtClose: pnlAbs,
					cooldownUntil,
					createdAt: now,
				})
				.run();

			log.info({ symbol, pnlPct: (pnlPct * 100).toFixed(2), filledPrice, cooldownUntil }, "L1 stop-loss executed");

			// Slack alert (non-fatal if fails)
			try {
				await sendStopLossAlert(config, symbol, pnlPct, pnlAbs, qty, filledPrice, cooldownUntil);
			} catch (alertErr) {
				log.warn(
					{ error: alertErr instanceof Error ? alertErr.message : String(alertErr) },
					"Stop-loss Slack alert failed (non-fatal)",
				);
			}

			result.events.push({ symbol, pnlPct, pnlAbs, qty, price: filledPrice, closed: true });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log.error({ symbol, error: message }, "L1 stop-loss: failed to close position");
			result.events.push({ symbol, pnlPct, pnlAbs, qty, price: currentPrice, closed: false, error: message });
		}
	}

	if (!result.triggered) {
		log.info({ positions: alpacaPositions.length }, "L1 stop-loss check: no breaches");
	}

	return result;
}
