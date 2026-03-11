import { and, desc, eq, gte } from "drizzle-orm";
import { ATR_MULTIPLIER, computeATR } from "../analyzers/atr.js";
import { getAlpacaClient } from "../broker/alpaca.js";
import { loadConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { positions, riskEvents, riskState } from "../db/schema.js";
import { createChildLogger } from "../logger.js";
import { postToSlack } from "../notifications/slack.js";

const log = createChildLogger("executor");

// ─── L1 Constants ────────────────────────────────

/** Fallback stop-loss threshold (used when ATR data unavailable) */
export const STOP_LOSS_THRESHOLD = -0.08;

/** Cool-down duration after stop-loss: 24 hours */
const COOLDOWN_HOURS = 24;

// ─── Drawdown Tier Constants ─────────────────────

/** Portfolio drawdown tiers */
export const DRAWDOWN_CAUTION = 0.05; // 5% → risk budget halved
export const DRAWDOWN_WARNING = 0.1; // 10% → risk budget quartered
export const DRAWDOWN_HALT = 0.15; // 15% → full stop

/** Recovery: consecutive profitable trades to advance one tier */
const RECOVERY_STREAK = 3;
/** Double retreat: consecutive losses after tier upgrade → drop back */
const DOUBLE_RETREAT_LOSSES = 2;

export type RiskLevel = "normal" | "caution" | "warning" | "halt";

// ─── Cooldown check (used by trade-engine) ────────

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

export interface RiskEventRow {
	id: number;
	eventType: string;
	symbol: string;
	triggerValue: number;
	threshold: number;
	action: string;
	qtyAtClose: number | null;
	priceAtClose: number | null;
	pnlAtClose: number | null;
	cooldownUntil: string | null;
	createdAt: string;
}

export function getLastStopLossEvent(db: Db, symbol: string): RiskEventRow | null {
	const rows = db
		.select()
		.from(riskEvents)
		.where(and(eq(riskEvents.symbol, symbol), eq(riskEvents.eventType, "stop_loss_l1")))
		.orderBy(desc(riskEvents.createdAt))
		.limit(1)
		.all();
	return (rows[0] as RiskEventRow | undefined) ?? null;
}

// ─── High Water Mark tracking ─────────────────────

/**
 * Update high_water_mark for all open positions.
 * Called after position sync — tracks the highest price seen since open.
 */
export function updateHighWaterMarks(db: Db): void {
	const rows = db.select().from(positions).all();

	for (const pos of rows) {
		if (pos.direction === "flat" || pos.quantity === 0) continue;

		const currentHwm = pos.highWaterMark ?? 0;
		const currentPrice = pos.currentPrice;

		if (pos.direction === "long" && currentPrice > currentHwm) {
			db.update(positions).set({ highWaterMark: currentPrice }).where(eq(positions.symbol, pos.symbol)).run();
		} else if (pos.direction === "short" && (currentHwm === 0 || currentPrice < currentHwm)) {
			// For shorts, HWM tracks the lowest price (best for short)
			db.update(positions).set({ highWaterMark: currentPrice }).where(eq(positions.symbol, pos.symbol)).run();
		}
	}
}

// ─── Trailing Stop (Chandelier) ───────────────────

/**
 * Compute the trailing stop price for a position.
 *
 * Long:  stop = max(avgCost, highWaterMark - K × ATR)
 * Short: stop = min(avgCost, highWaterMark + K × ATR)  (HWM = lowest price for short)
 *
 * If ATR unavailable, falls back to fixed -8% from entry.
 */
function computeTrailingStop(
	direction: "long" | "short",
	avgCost: number,
	highWaterMark: number | null,
	atrAbsolute: number | null,
): { stopPrice: number; method: "trailing_atr" | "breakeven" | "fallback_fixed" } {
	const hwm = highWaterMark ?? avgCost;
	const stopDistance = atrAbsolute !== null ? ATR_MULTIPLIER * atrAbsolute : null;

	if (direction === "long") {
		if (stopDistance !== null) {
			// Chandelier: max(entry, hwm - K×ATR) → ensures at least breakeven once profitable
			const chandelierStop = hwm - stopDistance;
			const stop = Math.max(avgCost, chandelierStop);
			const method = stop === avgCost ? "breakeven" : "trailing_atr";
			return { stopPrice: stop, method };
		}
		// Fallback: fixed -8%
		return { stopPrice: avgCost * (1 + STOP_LOSS_THRESHOLD), method: "fallback_fixed" };
	}

	// Short: stop goes UP
	if (stopDistance !== null) {
		const chandelierStop = hwm + stopDistance; // hwm = lowest price
		const stop = Math.min(avgCost, chandelierStop);
		const method = stop === avgCost ? "breakeven" : "trailing_atr";
		return { stopPrice: stop, method };
	}
	return { stopPrice: avgCost * (1 - STOP_LOSS_THRESHOLD), method: "fallback_fixed" };
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
	method: string,
): Promise<void> {
	if (!config.SLACK_BOT_TOKEN || !config.SLACK_CHANNEL_ID) return;

	const now = new Date().toLocaleString("zh-CN", { timeZone: "America/New_York", hour12: false });
	const cooldownDate = new Date(cooldownUntil).toLocaleString("zh-CN", {
		timeZone: "America/New_York",
		hour12: false,
		month: "numeric",
		day: "numeric",
		hour: "numeric",
		minute: "numeric",
	});

	const text = [
		`🚨 *[L1 移动止损触发]* ${symbol}`,
		``,
		`*止损方式：* ${method}`,
		`*未实现亏损：* ${(pnlPct * 100).toFixed(2)}%`,
		`*绝对亏损：* $${pnlAbs.toFixed(2)}`,
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
		method: string;
		error?: string;
	}[];
}

/**
 * L1 Stop-Loss Check: runs hourly.
 *
 * For each open position:
 *   - Compute trailing stop using ATR (or fallback to fixed -8%)
 *   - If current price breaches stop: close immediately, record event, send alert
 *   - Set 24-hour cooldown to prevent immediate re-entry
 */
export async function checkStopLoss(db: Db): Promise<StopLossResult> {
	const config = loadConfig();
	const client = getAlpacaClient();
	const now = new Date().toISOString();

	const alpacaPositions = await client.getPositions();
	const result: StopLossResult = { triggered: false, events: [] };

	for (const position of alpacaPositions) {
		const qty = Math.abs(Number.parseFloat(position.qty));
		const currentPrice = Number.parseFloat(position.current_price);
		const avgEntry = Number.parseFloat(position.avg_entry_price);
		const pnlAbs = Number.parseFloat(position.unrealized_pl);
		const pnlPct = Number.parseFloat(position.unrealized_plpc);
		const symbol = position.symbol;
		const direction: "long" | "short" = position.side === "short" ? "short" : "long";

		// Get HWM from our local positions table
		const localPos = db
			.select({ highWaterMark: positions.highWaterMark })
			.from(positions)
			.where(eq(positions.symbol, symbol))
			.limit(1)
			.all();
		const hwm = localPos[0]?.highWaterMark ?? null;

		// Get ATR for this symbol
		const atrResult = computeATR(db, symbol);
		const atrAbsolute = atrResult?.atr ?? null;

		// Compute trailing stop
		const { stopPrice, method } = computeTrailingStop(direction, avgEntry, hwm, atrAbsolute);

		// Check breach
		let breached = false;
		if (direction === "long" && currentPrice <= stopPrice) {
			breached = true;
		} else if (direction === "short" && currentPrice >= stopPrice) {
			breached = true;
		}

		if (!breached) continue;

		log.warn(
			{
				symbol,
				direction,
				currentPrice,
				stopPrice: stopPrice.toFixed(2),
				hwm,
				atr: atrAbsolute?.toFixed(2) ?? "n/a",
				method,
				pnlPct: (pnlPct * 100).toFixed(2),
			},
			"L1 trailing stop breached, closing position",
		);
		result.triggered = true;

		try {
			const order = await client.closePosition(symbol);
			const filledPrice = order?.filled_avg_price ? Number.parseFloat(order.filled_avg_price) : currentPrice;
			const cooldownUntil = new Date(Date.now() + COOLDOWN_HOURS * 60 * 60 * 1000).toISOString();

			db.insert(riskEvents)
				.values({
					eventType: "stop_loss_l1",
					symbol,
					triggerValue: pnlPct,
					threshold: (stopPrice - avgEntry) / avgEntry, // actual stop distance as fraction
					action: "closed_position",
					qtyAtClose: qty,
					priceAtClose: filledPrice,
					pnlAtClose: pnlAbs,
					cooldownUntil,
					createdAt: now,
				})
				.run();

			// Reset HWM in positions table
			db.update(positions)
				.set({ highWaterMark: null, direction: "flat", quantity: 0 })
				.where(eq(positions.symbol, symbol))
				.run();

			log.info({ symbol, method, filledPrice, cooldownUntil }, "L1 trailing stop executed");

			try {
				await sendStopLossAlert(config, symbol, pnlPct, pnlAbs, qty, filledPrice, cooldownUntil, method);
			} catch (alertErr) {
				log.warn(
					{ error: alertErr instanceof Error ? alertErr.message : String(alertErr) },
					"Stop-loss Slack alert failed (non-fatal)",
				);
			}

			result.events.push({ symbol, pnlPct, pnlAbs, qty, price: filledPrice, closed: true, method });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log.error({ symbol, error: message }, "L1 trailing stop: failed to close position");
			result.events.push({
				symbol,
				pnlPct,
				pnlAbs,
				qty,
				price: currentPrice,
				closed: false,
				method,
				error: message,
			});
		}
	}

	if (!result.triggered) {
		log.info({ positions: alpacaPositions.length }, "L1 trailing stop check: no breaches");
	}

	return result;
}

// ─── Drawdown Tier Management ─────────────────────

function getRiskStateValue(db: Db, key: string): string | null {
	const rows = db.select({ value: riskState.value }).from(riskState).where(eq(riskState.key, key)).limit(1).all();
	return rows[0]?.value ?? null;
}

function setRiskStateValue(db: Db, key: string, value: string): void {
	db.insert(riskState)
		.values({ key, value, updatedAt: new Date().toISOString() })
		.onConflictDoUpdate({
			target: [riskState.key],
			set: { value, updatedAt: new Date().toISOString() },
		})
		.run();
}

/** Get current portfolio risk level */
export function getRiskLevel(db: Db): RiskLevel {
	return (getRiskStateValue(db, "risk_level") as RiskLevel) ?? "normal";
}

/** Get risk multiplier based on current drawdown tier */
export function getRiskMultiplier(db: Db): number {
	const level = getRiskLevel(db);
	switch (level) {
		case "normal":
			return 1.0;
		case "caution":
			return 0.5;
		case "warning":
			return 0.25;
		case "halt":
			return 0;
	}
}

/** Get portfolio high water mark (equity peak) */
export function getPortfolioHWM(db: Db): number {
	const val = getRiskStateValue(db, "portfolio_hwm");
	return val ? Number.parseFloat(val) : 0;
}

/**
 * Update drawdown tier based on current equity vs HWM.
 * Called after position sync / trade execution.
 *
 * Returns the new risk level and drawdown percentage.
 */
export function updateDrawdownTier(
	db: Db,
	currentEquity: number,
): { riskLevel: RiskLevel; drawdownPct: number; changed: boolean } {
	const now = new Date().toISOString();
	let hwm = getPortfolioHWM(db);

	// Update HWM if new peak
	if (currentEquity > hwm) {
		hwm = currentEquity;
		setRiskStateValue(db, "portfolio_hwm", hwm.toString());
	}

	// Initialize HWM on first run
	if (hwm === 0) {
		hwm = currentEquity;
		setRiskStateValue(db, "portfolio_hwm", hwm.toString());
	}

	const drawdownPct = hwm > 0 ? (hwm - currentEquity) / hwm : 0;
	const previousLevel = getRiskLevel(db);

	let newLevel: RiskLevel;
	if (drawdownPct >= DRAWDOWN_HALT) {
		newLevel = "halt";
	} else if (drawdownPct >= DRAWDOWN_WARNING) {
		newLevel = "warning";
	} else if (drawdownPct >= DRAWDOWN_CAUTION) {
		newLevel = "caution";
	} else {
		newLevel = "normal";
	}

	// Only downgrade automatically (tighten risk); recovery requires explicit check
	// If new level is worse than previous, apply it
	const levelOrder: Record<RiskLevel, number> = { normal: 0, caution: 1, warning: 2, halt: 3 };
	if (levelOrder[newLevel] > levelOrder[previousLevel]) {
		setRiskStateValue(db, "risk_level", newLevel);
		setRiskStateValue(db, "tier_downgrade_at", now);
		// Reset recovery tracking
		setRiskStateValue(db, "consecutive_wins", "0");
		setRiskStateValue(db, "losses_after_upgrade", "0");

		log.warn(
			{ previousLevel, newLevel, drawdownPct: (drawdownPct * 100).toFixed(2), hwm, currentEquity },
			"Risk level downgraded",
		);

		return { riskLevel: newLevel, drawdownPct, changed: true };
	}

	return { riskLevel: previousLevel, drawdownPct, changed: false };
}

/**
 * Record a trade outcome for recovery tracking.
 * Called after each completed trade.
 */
export function recordTradeOutcome(db: Db, profitable: boolean): void {
	const currentLevel = getRiskLevel(db);
	if (currentLevel === "normal") return; // nothing to track

	if (profitable) {
		const wins = Number.parseInt(getRiskStateValue(db, "consecutive_wins") ?? "0", 10) + 1;
		setRiskStateValue(db, "consecutive_wins", wins.toString());
		setRiskStateValue(db, "losses_after_upgrade", "0"); // reset double-retreat counter
	} else {
		setRiskStateValue(db, "consecutive_wins", "0");
		// Track losses after last upgrade for double-retreat
		const lossesAfterUpgrade = Number.parseInt(getRiskStateValue(db, "losses_after_upgrade") ?? "0", 10) + 1;
		setRiskStateValue(db, "losses_after_upgrade", lossesAfterUpgrade.toString());
	}
}

/**
 * Check if risk level should be recovered (upgraded).
 * Implements staged recovery + double-retreat logic.
 *
 * Recovery conditions:
 *   - From halt → warning: RECOVERY_STREAK consecutive wins
 *   - From warning → caution: RECOVERY_STREAK consecutive wins
 *   - From caution → normal: win rate > RECOVERY_WIN_RATE over last RECOVERY_WINDOW trades AND equity rising
 *
 * Double retreat:
 *   - After upgrading, if DOUBLE_RETREAT_LOSSES consecutive losses → drop back to previous level
 */
export function checkRecovery(db: Db, currentEquity: number): { recovered: boolean; newLevel: RiskLevel } {
	const currentLevel = getRiskLevel(db);
	if (currentLevel === "normal") return { recovered: false, newLevel: "normal" };

	const consecutiveWins = Number.parseInt(getRiskStateValue(db, "consecutive_wins") ?? "0", 10);
	const lossesAfterUpgrade = Number.parseInt(getRiskStateValue(db, "losses_after_upgrade") ?? "0", 10);
	const hwm = getPortfolioHWM(db);
	const drawdown = hwm > 0 ? (hwm - currentEquity) / hwm : 0;

	// Double retreat: if just upgraded but hit consecutive losses, drop back
	if (lossesAfterUpgrade >= DOUBLE_RETREAT_LOSSES) {
		const levelOrder: RiskLevel[] = ["normal", "caution", "warning", "halt"];
		const idx = levelOrder.indexOf(currentLevel);
		if (idx < levelOrder.length - 1) {
			const retreatLevel = levelOrder[idx + 1];
			setRiskStateValue(db, "risk_level", retreatLevel);
			setRiskStateValue(db, "consecutive_wins", "0");
			setRiskStateValue(db, "losses_after_upgrade", "0");
			log.warn({ from: currentLevel, to: retreatLevel }, "Double retreat triggered");
			return { recovered: false, newLevel: retreatLevel };
		}
	}

	// Recovery check
	let targetLevel: RiskLevel | null = null;

	if (currentLevel === "halt" && consecutiveWins >= RECOVERY_STREAK) {
		targetLevel = "warning";
	} else if (currentLevel === "warning" && consecutiveWins >= RECOVERY_STREAK) {
		targetLevel = "caution";
	} else if (currentLevel === "caution" && consecutiveWins >= RECOVERY_STREAK && drawdown < DRAWDOWN_CAUTION) {
		targetLevel = "normal";
	}

	if (targetLevel) {
		setRiskStateValue(db, "risk_level", targetLevel);
		setRiskStateValue(db, "consecutive_wins", "0");
		setRiskStateValue(db, "losses_after_upgrade", "0");
		log.info({ from: currentLevel, to: targetLevel, consecutiveWins }, "Risk level recovered");
		return { recovered: true, newLevel: targetLevel };
	}

	return { recovered: false, newLevel: currentLevel };
}
