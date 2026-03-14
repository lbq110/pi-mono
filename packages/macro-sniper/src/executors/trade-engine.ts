import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getAlpacaClient } from "../broker/alpaca.js";
import { loadConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { orders, positions, positionTrades, tradeLog } from "../db/schema.js";
import { createChildLogger } from "../logger.js";
import { postToSlack } from "../notifications/slack.js";
import { isInStopLossCooldown, updateDrawdownTier, updateHighWaterMarks } from "./risk-manager.js";
import { scoreAllInstruments } from "./signal-scorer.js";
import type { InstrumentScore, OrderOutcome, TradeDecision, TradedSymbol, TradeExecutionResult } from "./types.js";

const log = createChildLogger("executor");

// Map from our symbol names to Alpaca symbol names
const ALPACA_SYMBOLS: Record<TradedSymbol, string> = {
	SPY: "SPY",
	QQQ: "QQQ",
	IWM: "IWM",
	BTCUSD: "BTCUSD",
	UUP: "UUP",
};

// ─── Position sync ────────────────────────────────

interface CurrentPosition {
	direction: "long" | "short" | "flat";
	qty: number;
	marketValue: number;
}

async function getCurrentPositions(): Promise<Map<TradedSymbol, CurrentPosition>> {
	const client = getAlpacaClient();
	const alpacaPositions = await client.getPositions();

	const map = new Map<TradedSymbol, CurrentPosition>();
	// Initialize all as flat
	for (const sym of ["SPY", "QQQ", "IWM", "BTCUSD", "UUP"] as TradedSymbol[]) {
		map.set(sym, { direction: "flat", qty: 0, marketValue: 0 });
	}

	for (const p of alpacaPositions) {
		const sym = Object.entries(ALPACA_SYMBOLS).find(([, v]) => v === p.symbol)?.[0] as TradedSymbol | undefined;
		if (sym) {
			const direction: "long" | "short" = p.side === "short" ? "short" : "long";
			map.set(sym, {
				direction,
				qty: Math.abs(Number.parseFloat(p.qty)),
				marketValue: Math.abs(Number.parseFloat(p.market_value)),
			});
		}
	}

	return map;
}

// ─── Decision generation ──────────────────────────

function makeDecisions(
	scores: Record<TradedSymbol, InstrumentScore>,
	currentPositions: Map<TradedSymbol, CurrentPosition>,
): TradeDecision[] {
	const decisions: TradeDecision[] = [];

	for (const [sym, score] of Object.entries(scores) as [TradedSymbol, InstrumentScore][]) {
		const current = currentPositions.get(sym) ?? { direction: "flat", qty: 0, marketValue: 0 };
		const target = score.direction;
		const targetNotional = score.notionalFinal;

		let action: TradeDecision["action"];
		let reason: string;

		const veto = score.creditVeto ? "credit_veto" : score.btcSyncVeto ? "btc_sync_veto" : "score_below_threshold";

		if (current.direction === "flat") {
			if (target === "long") {
				action = "buy";
				reason = `score=${score.finalScore.toFixed(1)}, entering long at $${targetNotional}`;
			} else if (target === "short") {
				action = "short";
				reason = `score=${score.finalScore.toFixed(1)}, entering short at $${targetNotional}`;
			} else {
				action = "hold";
				reason = `score=${score.finalScore.toFixed(1)}, remaining flat`;
			}
		} else if (current.direction === "long") {
			if (target === "flat") {
				action = "sell";
				reason = `${veto}, closing long position`;
			} else if (target === "short") {
				// Flip: close long first; short opens next cycle
				action = "sell";
				reason = `score=${score.finalScore.toFixed(1)}, USD flipped bearish — closing long (will short next cycle)`;
			} else {
				// target === "long": resize check
				const sizeDiff = Math.abs(targetNotional - current.marketValue) / current.marketValue;
				if (sizeDiff > 0.2) {
					action = targetNotional > current.marketValue ? "resize_up" : "resize_down";
					reason = `score=${score.finalScore.toFixed(1)}, resize ${current.marketValue.toFixed(0)} → ${targetNotional.toFixed(0)}`;
				} else {
					action = "hold";
					reason = `score=${score.finalScore.toFixed(1)}, position size within 20% tolerance`;
				}
			}
		} else {
			// current === "short"
			if (target === "flat") {
				action = "cover";
				reason = `${veto}, covering short position`;
			} else if (target === "long") {
				// Flip: close short first; long opens next cycle
				action = "cover";
				reason = `score=${score.finalScore.toFixed(1)}, USD flipped bullish — covering short (will buy next cycle)`;
			} else {
				// target === "short": resize check
				const sizeDiff = Math.abs(targetNotional - current.marketValue) / current.marketValue;
				if (sizeDiff > 0.2) {
					action = "resize_short";
					reason = `score=${score.finalScore.toFixed(1)}, resize short ${current.marketValue.toFixed(0)} → ${targetNotional.toFixed(0)}`;
				} else {
					action = "hold";
					reason = `score=${score.finalScore.toFixed(1)}, short size within 20% tolerance`;
				}
			}
		}

		decisions.push({
			symbol: sym,
			currentDirection: current.direction,
			targetDirection: target,
			currentQty: current.qty,
			currentMarketValue: current.marketValue,
			targetNotional,
			action,
			score,
			reason,
		});
	}

	return decisions;
}

// ─── Order execution ──────────────────────────────

async function executeDecision(db: Db, decision: TradeDecision, marketOpen: boolean): Promise<OrderOutcome> {
	const client = getAlpacaClient();
	const alpacaSym = ALPACA_SYMBOLS[decision.symbol as TradedSymbol];
	const now = new Date().toISOString();

	// US equities only when market is open; BTC always tradeable
	const isEquity = decision.symbol !== "BTCUSD";
	const requiresMarketOpen =
		decision.action === "buy" ||
		decision.action === "sell" ||
		decision.action === "resize_up" ||
		decision.action === "resize_down" ||
		decision.action === "short" ||
		decision.action === "cover" ||
		decision.action === "resize_short";

	if (isEquity && !marketOpen && requiresMarketOpen) {
		return {
			symbol: decision.symbol,
			side:
				decision.action === "short" ||
				decision.action === "cover" ||
				decision.action === "resize_short" ||
				decision.action === "sell"
					? "sell"
					: "buy",
			notional: decision.targetNotional,
			qty: undefined,
			alpacaOrderId: null,
			status: "skipped",
			error: "Market closed",
		};
	}

	if (decision.action === "hold") {
		return {
			symbol: decision.symbol,
			side: "buy",
			notional: undefined,
			qty: undefined,
			alpacaOrderId: null,
			status: "skipped",
		};
	}

	// L1 stop-loss cooldown: block re-entry for 24h after a stop-loss event
	if (
		decision.action === "buy" ||
		decision.action === "resize_up" ||
		decision.action === "short" ||
		decision.action === "resize_short"
	) {
		if (isInStopLossCooldown(db, decision.symbol)) {
			log.info({ symbol: decision.symbol }, "Entry skipped: L1 stop-loss cooldown active");
			return {
				symbol: decision.symbol,
				side: decision.action === "short" ? "sell" : "buy",
				notional: decision.targetNotional,
				qty: undefined,
				alpacaOrderId: null,
				status: "skipped",
				error: "L1 stop-loss cooldown active (24h)",
			};
		}
	}

	// Record order intent in DB
	const signalSnapshot = JSON.stringify(decision.score.evidence);

	try {
		if (decision.action === "buy" || decision.action === "resize_up") {
			const order = await client.placeMarketOrder(alpacaSym, "buy", decision.targetNotional);

			// Write to orders table
			db.insert(orders)
				.values({
					alpacaOrderId: order.id,
					symbol: decision.symbol,
					side: "buy",
					quantity: Number.parseFloat(order.qty) || 0, // 0 placeholder for notional orders (filled later)
					status: "submitted",
					signalSnapshot,
					createdAt: now,
				})
				.run();

			log.info(
				{ symbol: decision.symbol, notional: decision.targetNotional, orderId: order.id },
				"Buy order placed",
			);

			return {
				symbol: decision.symbol,
				side: "buy",
				notional: decision.targetNotional,
				qty: undefined,
				alpacaOrderId: order.id,
				status: "submitted",
			};
		}

		if (decision.action === "sell" || decision.action === "resize_down") {
			const order = await client.closePosition(alpacaSym);
			if (!order) {
				return {
					symbol: decision.symbol,
					side: "sell",
					notional: undefined,
					qty: undefined,
					alpacaOrderId: null,
					status: "skipped",
					error: "No position to close",
				};
			}

			const qty = Number.parseFloat(order.qty);
			const price = order.filled_avg_price ? Number.parseFloat(order.filled_avg_price) : 0;

			const [dbOrder] = db
				.insert(orders)
				.values({
					alpacaOrderId: order.id,
					symbol: decision.symbol,
					side: "sell",
					quantity: qty,
					status: "submitted",
					signalSnapshot,
					createdAt: now,
				})
				.returning()
				.all();

			if (dbOrder && price > 0) {
				db.insert(tradeLog)
					.values({
						orderId: dbOrder.id,
						symbol: decision.symbol,
						side: "sell",
						quantity: qty,
						price,
						pnlRealized: 0,
						createdAt: now,
					})
					.run();
			}

			log.info({ symbol: decision.symbol, qty, orderId: order.id }, "Sell order placed");

			return {
				symbol: decision.symbol,
				side: "sell",
				notional: undefined,
				qty,
				alpacaOrderId: order.id,
				status: "submitted",
			};
		}

		// ── Short: open new short position (UUP) ──────────
		if (decision.action === "short") {
			const order = await client.placeMarketOrder(alpacaSym, "sell", decision.targetNotional);

			db.insert(orders)
				.values({
					alpacaOrderId: order.id,
					symbol: decision.symbol,
					side: "sell",
					quantity: 0,
					status: "submitted",
					signalSnapshot,
					createdAt: now,
				})
				.run();

			log.info(
				{ symbol: decision.symbol, notional: decision.targetNotional, orderId: order.id },
				"Short order placed",
			);

			return {
				symbol: decision.symbol,
				side: "sell",
				notional: decision.targetNotional,
				qty: undefined,
				alpacaOrderId: order.id,
				status: "submitted",
			};
		}

		// ── Cover: close existing short position ──────────
		if (decision.action === "cover") {
			const order = await client.closePosition(alpacaSym);
			if (!order) {
				return {
					symbol: decision.symbol,
					side: "buy",
					notional: undefined,
					qty: undefined,
					alpacaOrderId: null,
					status: "skipped",
					error: "No short position to cover",
				};
			}

			const qty = Math.abs(Number.parseFloat(order.qty));
			const price = order.filled_avg_price ? Number.parseFloat(order.filled_avg_price) : 0;

			const [dbOrder] = db
				.insert(orders)
				.values({
					alpacaOrderId: order.id,
					symbol: decision.symbol,
					side: "buy",
					quantity: qty,
					status: "submitted",
					signalSnapshot,
					createdAt: now,
				})
				.returning()
				.all();

			if (dbOrder && price > 0) {
				db.insert(tradeLog)
					.values({
						orderId: dbOrder.id,
						symbol: decision.symbol,
						side: "buy",
						quantity: qty,
						price,
						pnlRealized: 0,
						createdAt: now,
					})
					.run();
			}

			log.info({ symbol: decision.symbol, qty, orderId: order.id }, "Cover order placed");

			return {
				symbol: decision.symbol,
				side: "buy",
				notional: undefined,
				qty,
				alpacaOrderId: order.id,
				status: "submitted",
			};
		}

		// ── Resize short: close then re-short at new notional ──
		if (decision.action === "resize_short") {
			await client.closePosition(alpacaSym);
			const order = await client.placeMarketOrder(alpacaSym, "sell", decision.targetNotional);

			db.insert(orders)
				.values({
					alpacaOrderId: order.id,
					symbol: decision.symbol,
					side: "sell",
					quantity: 0,
					status: "submitted",
					signalSnapshot,
					createdAt: now,
				})
				.run();

			log.info(
				{ symbol: decision.symbol, notional: decision.targetNotional, orderId: order.id },
				"Resize short order placed",
			);

			return {
				symbol: decision.symbol,
				side: "sell",
				notional: decision.targetNotional,
				qty: undefined,
				alpacaOrderId: order.id,
				status: "submitted",
			};
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log.error({ symbol: decision.symbol, action: decision.action, error: message }, "Order execution failed");
		return {
			symbol: decision.symbol,
			side: decision.action === "sell" ? "sell" : "buy",
			notional: decision.targetNotional,
			qty: undefined,
			alpacaOrderId: null,
			status: "failed",
			error: message,
		};
	}

	return {
		symbol: decision.symbol,
		side: "buy",
		notional: undefined,
		qty: undefined,
		alpacaOrderId: null,
		status: "skipped",
	};
}

// ─── Position change tracking ─────────────────────

interface PositionChange {
	symbol: string;
	changeType: "open" | "close" | "resize" | "flip";
	prevDirection: string;
	newDirection: string;
	prevQty: number;
	newQty: number;
	prevAvgCost: number;
	avgCost: number;
	currentPrice: number;
	pnl: number;
	openedAt: string | null; // previous position's openedAt (for holdingDuration calc on close)
}

/** Map PositionChange.changeType to positionTrades.operationType */
function mapOperationType(changeType: PositionChange["changeType"]): string {
	switch (changeType) {
		case "open":
			return "open";
		case "close":
			return "close";
		case "resize":
			return "reduce"; // resize detected by syncPositionsToDb is always qty change
		case "flip":
			return "flip";
	}
}

/** Record a position trade into the position_trades table */
export function recordPositionTrade(
	db: Db,
	opts: {
		change: PositionChange;
		trigger: string;
		signalScore?: number | null;
		signalSnapshot?: unknown;
		tradeGroup?: string | null;
		alpacaOrderId?: string | null;
	},
): void {
	const { change, trigger, signalScore, signalSnapshot, tradeGroup, alpacaOrderId } = opts;
	const now = new Date().toISOString();

	const operationType = mapOperationType(change.changeType);

	// Determine side
	const side =
		change.changeType === "close"
			? change.prevDirection === "long"
				? "sell"
				: "buy"
			: change.newDirection === "long"
				? "buy"
				: change.newDirection === "short"
					? "sell"
					: change.prevDirection === "long"
						? "sell"
						: "buy";

	// Determine trade quantity and price
	let tradeQty: number;
	let tradePrice: number;

	if (change.changeType === "open" || change.changeType === "flip") {
		tradeQty = change.newQty;
		tradePrice = change.avgCost; // new position's avg entry
	} else if (change.changeType === "close") {
		tradeQty = change.prevQty;
		tradePrice = change.currentPrice; // last known price (close price)
	} else {
		// resize
		tradeQty = Math.abs(change.newQty - change.prevQty);
		tradePrice = change.currentPrice;
	}

	// Compute realized PnL for closing operations
	let realizedPnl: number | null = null;
	let realizedPnlPct: number | null = null;
	if (change.changeType === "close" || change.changeType === "flip") {
		const costBasis = change.prevAvgCost;
		const closePrice = change.currentPrice;
		const closedQty = change.prevQty;
		if (change.prevDirection === "long") {
			realizedPnl = (closePrice - costBasis) * closedQty;
		} else {
			realizedPnl = (costBasis - closePrice) * closedQty;
		}
		realizedPnlPct = costBasis > 0 ? realizedPnl / (costBasis * closedQty) : null;
	} else if (change.changeType === "resize" && change.newQty < change.prevQty) {
		// Partial close
		const reducedQty = change.prevQty - change.newQty;
		if (change.prevDirection === "long") {
			realizedPnl = (change.currentPrice - change.prevAvgCost) * reducedQty;
		} else {
			realizedPnl = (change.prevAvgCost - change.currentPrice) * reducedQty;
		}
		realizedPnlPct = change.prevAvgCost > 0 ? realizedPnl / (change.prevAvgCost * reducedQty) : null;
	}

	// Compute holding duration
	let holdingDuration: number | null = null;
	if ((change.changeType === "close" || change.changeType === "flip") && change.openedAt) {
		holdingDuration = Math.round((Date.now() - new Date(change.openedAt).getTime()) / 1000);
	}

	db.insert(positionTrades)
		.values({
			symbol: change.symbol,
			operationType,
			side,
			direction: change.newDirection,
			quantity: tradeQty,
			price: tradePrice,
			notional: tradeQty * tradePrice,
			prevDirection: change.prevDirection,
			prevQuantity: change.prevQty,
			prevAvgCost: change.prevAvgCost,
			newQuantity: change.newQty,
			newAvgCost: change.avgCost,
			realizedPnl,
			realizedPnlPct,
			holdingDuration,
			trigger,
			signalScore: signalScore ?? null,
			signalSnapshot: signalSnapshot ?? null,
			tradeGroup: tradeGroup ?? null,
			alpacaOrderId: alpacaOrderId ?? null,
			createdAt: now,
		})
		.run();
}

/** Sync local positions table with Alpaca actuals, track changes, and set openedAt */
async function syncPositionsToDb(db: Db): Promise<PositionChange[]> {
	const client = getAlpacaClient();
	const alpacaPositions = await client.getPositions();
	const now = new Date().toISOString();
	const changes: PositionChange[] = [];

	for (const sym of ["SPY", "QQQ", "IWM", "BTCUSD", "UUP"] as TradedSymbol[]) {
		const alpacaSym = ALPACA_SYMBOLS[sym];
		const p = alpacaPositions.find((ap) => ap.symbol === alpacaSym);

		// Read previous state
		const prev = db.select().from(positions).where(eq(positions.symbol, sym)).all()[0];
		const prevDirection = prev?.direction ?? "flat";
		const prevQty = prev?.quantity ?? 0;

		const prevAvgCost = prev?.avgCost ?? 0;
		const prevOpenedAt = prev?.openedAt ?? null;

		if (p) {
			const direction: "long" | "short" = p.side === "short" ? "short" : "long";
			const qty = Math.abs(Number.parseFloat(p.qty));
			const avgCost = Number.parseFloat(p.avg_entry_price);
			const currentPrice = Number.parseFloat(p.current_price);
			const unrealizedPnl = Number.parseFloat(p.unrealized_pl);

			// Determine if openedAt should be set/kept
			let openedAt = prev?.openedAt ?? null;
			if (prevDirection === "flat" || prevDirection !== direction) {
				// New position or direction flip → set openedAt
				openedAt = now;
			}

			db.insert(positions)
				.values({
					symbol: sym,
					direction,
					quantity: qty,
					avgCost,
					currentPrice,
					unrealizedPnl,
					openedAt,
					updatedAt: now,
				})
				.onConflictDoUpdate({
					target: [positions.symbol],
					set: {
						direction,
						quantity: qty,
						avgCost,
						currentPrice,
						unrealizedPnl,
						openedAt,
						updatedAt: now,
					},
				})
				.run();

			// Detect change type
			if (prevDirection === "flat") {
				changes.push({
					symbol: sym,
					changeType: "open",
					prevDirection,
					newDirection: direction,
					prevQty,
					newQty: qty,
					prevAvgCost,
					avgCost,
					currentPrice,
					pnl: unrealizedPnl,
					openedAt: prevOpenedAt,
				});
			} else if (prevDirection !== direction) {
				changes.push({
					symbol: sym,
					changeType: "flip",
					prevDirection,
					newDirection: direction,
					prevQty,
					newQty: qty,
					prevAvgCost,
					avgCost,
					currentPrice,
					pnl: unrealizedPnl,
					openedAt: prevOpenedAt,
				});
			} else if (Math.abs(qty - prevQty) / Math.max(prevQty, 0.001) > 0.1) {
				changes.push({
					symbol: sym,
					changeType: "resize",
					prevDirection,
					newDirection: direction,
					prevQty,
					newQty: qty,
					prevAvgCost,
					avgCost,
					currentPrice,
					pnl: unrealizedPnl,
					openedAt: prevOpenedAt,
				});
			}
		} else {
			// Mark as flat, clear openedAt
			if (prevDirection !== "flat") {
				changes.push({
					symbol: sym,
					changeType: "close",
					prevDirection,
					newDirection: "flat",
					prevQty,
					newQty: 0,
					prevAvgCost,
					avgCost: prev?.avgCost ?? 0,
					currentPrice: prev?.currentPrice ?? 0,
					pnl: prev?.unrealizedPnl ?? 0,
					openedAt: prevOpenedAt,
				});
			}

			db.insert(positions)
				.values({
					symbol: sym,
					direction: "flat",
					quantity: 0,
					avgCost: 0,
					currentPrice: 0,
					unrealizedPnl: 0,
					openedAt: null,
					updatedAt: now,
				})
				.onConflictDoUpdate({
					target: [positions.symbol],
					set: {
						direction: "flat",
						quantity: 0,
						currentPrice: 0,
						unrealizedPnl: 0,
						openedAt: null,
						updatedAt: now,
					},
				})
				.run();
		}
	}

	return changes;
}

/** Send Slack notification for position changes */
async function notifyPositionChanges(changes: PositionChange[]): Promise<void> {
	if (changes.length === 0) return;

	const config = loadConfig();
	if (!config.SLACK_BOT_TOKEN || !config.SLACK_CHANNEL_ID) return;

	const lines: string[] = ["*仓位变动通知*\n"];
	for (const c of changes) {
		const icon =
			c.changeType === "open" ? "🟢" : c.changeType === "close" ? "🔴" : c.changeType === "flip" ? "🔄" : "📐";
		const label =
			c.changeType === "open"
				? "建仓"
				: c.changeType === "close"
					? "平仓"
					: c.changeType === "flip"
						? "翻转"
						: "调仓";

		let detail: string;
		if (c.changeType === "open") {
			detail = `${c.newDirection} ${c.newQty.toFixed(4)} @ $${c.avgCost.toFixed(2)}`;
		} else if (c.changeType === "close") {
			detail = `${c.prevDirection} ${c.prevQty.toFixed(4)} → flat, PnL $${c.pnl.toFixed(2)}`;
		} else if (c.changeType === "flip") {
			detail = `${c.prevDirection} → ${c.newDirection} ${c.newQty.toFixed(4)} @ $${c.avgCost.toFixed(2)}`;
		} else {
			const qtyChange = c.newQty - c.prevQty;
			detail = `${c.newDirection} ${c.prevQty.toFixed(4)} → ${c.newQty.toFixed(4)} (${qtyChange >= 0 ? "+" : ""}${qtyChange.toFixed(4)})`;
		}

		lines.push(`${icon} *${c.symbol}* ${label}: ${detail}`);
	}

	const msg = lines.join("\n");
	try {
		await postToSlack(msg, { botToken: config.SLACK_BOT_TOKEN, channelId: config.SLACK_CHANNEL_ID });
		log.info({ changes: changes.length }, "Position change notification sent to Slack");
	} catch (err) {
		log.error(
			{ error: err instanceof Error ? err.message : String(err) },
			"Failed to send position change notification",
		);
	}
}

// ─── Main entry point ─────────────────────────────

/**
 * Run the trade cycle for specified instruments (or all if no filter):
 * 1. Score all instruments from analysis_results
 * 2. Compare vs current Alpaca positions
 * 3. Execute necessary orders (only for filtered symbols)
 * 4. Sync positions to local DB
 * 5. Return execution summary
 *
 * @param symbolFilter - If provided, only execute trades for these symbols.
 *                       Other symbols will be scored but skipped for execution.
 *                       Use ["BTCUSD"] for hourly BTC-only runs.
 */
export async function runTradeEngine(db: Db, symbolFilter?: TradedSymbol[]): Promise<TradeExecutionResult> {
	const now = new Date().toISOString();
	const date = now.split("T")[0];
	const filterSet = symbolFilter ? new Set(symbolFilter) : null;

	log.info({ date, symbolFilter: symbolFilter ?? "all" }, "Running trade engine");

	// Check market status
	const client = getAlpacaClient();
	const marketOpen = await client.isTradingOpen();
	log.info({ marketOpen }, "Market status checked");

	// Get account equity for ATR position sizing
	let equity = 100000;
	try {
		const account = await client.getAccount();
		equity = Number.parseFloat(account.equity);
	} catch {
		log.warn("Failed to fetch account equity, using default $100,000");
	}

	// Score all instruments (with ATR, correlation, drawdown, Kelly adjustments)
	const allScores = scoreAllInstruments(db, equity);
	const { SPY, QQQ, IWM, BTCUSD, UUP } = allScores;

	// Get current positions
	const currentPositions = await getCurrentPositions();

	// Generate decisions for all instruments
	const allDecisions = makeDecisions({ SPY, QQQ, IWM, BTCUSD, UUP }, currentPositions);

	// Execute orders — only for filtered symbols
	const orderOutcomes: OrderOutcome[] = [];
	const skippedSymbols: string[] = [];
	const executedDecisions: TradeDecision[] = [];

	for (const decision of allDecisions) {
		// Skip symbols not in filter
		if (filterSet && !filterSet.has(decision.symbol as TradedSymbol)) {
			continue;
		}
		executedDecisions.push(decision);

		const outcome = await executeDecision(db, decision, marketOpen);
		orderOutcomes.push(outcome);
		if (outcome.status === "skipped") {
			skippedSymbols.push(`${decision.symbol}(${outcome.error ?? decision.action})`);
		}
	}

	// Sync positions table and detect changes
	const positionChanges = await syncPositionsToDb(db);

	// Record position trades and notify
	if (positionChanges.length > 0) {
		log.info({ changes: positionChanges.map((c) => `${c.symbol}:${c.changeType}`) }, "Position changes detected");

		// Determine trigger based on symbol filter
		const trigger = filterSet
			? filterSet.has("BTCUSD") && filterSet.size === 1
				? "hourly_btc"
				: "daily_pipeline"
			: "daily_pipeline";

		// Build lookup maps from decisions/outcomes for signal scores and order IDs
		const decisionMap = new Map(executedDecisions.map((d) => [d.symbol, d]));
		const outcomeMap = new Map(orderOutcomes.map((o) => [o.symbol, o]));

		// Group flip operations (close + open share same tradeGroup)
		const flipGroup = new Map<string, string>();
		for (const c of positionChanges) {
			if (c.changeType === "flip") {
				flipGroup.set(c.symbol, randomUUID());
			}
		}

		for (const change of positionChanges) {
			const decision = decisionMap.get(change.symbol);
			const outcome = outcomeMap.get(change.symbol);
			recordPositionTrade(db, {
				change,
				trigger,
				signalScore: decision?.score.finalScore ?? null,
				signalSnapshot: decision?.score.evidence ?? null,
				tradeGroup: flipGroup.get(change.symbol) ?? null,
				alpacaOrderId: outcome?.alpacaOrderId ?? null,
			});
		}

		notifyPositionChanges(positionChanges).catch((err) =>
			log.error({ error: err instanceof Error ? err.message : String(err) }, "Position change notification failed"),
		);
	}

	// Update trailing stop high water marks
	updateHighWaterMarks(db);

	// Update drawdown tier based on current equity
	try {
		const account = await client.getAccount();
		const equity = Number.parseFloat(account.equity);
		const { riskLevel, drawdownPct, changed } = updateDrawdownTier(db, equity);
		if (changed) {
			log.warn({ riskLevel, drawdownPct: (drawdownPct * 100).toFixed(2) }, "Portfolio drawdown tier changed");
		}
	} catch (err) {
		log.error({ error: err instanceof Error ? err.message : String(err) }, "Failed to update drawdown tier");
	}

	const submitted = orderOutcomes.filter((o) => o.status === "submitted").length;
	const failed = orderOutcomes.filter((o) => o.status === "failed").length;
	const filterLabel = filterSet ? `[${[...filterSet].join(",")}]` : "all";
	const summary = `${filterLabel}: ${submitted} orders submitted, ${failed} failed, ${skippedSymbols.length} skipped. Bias=${allScores.marketBias}(${allScores.marketBiasConfidence}), Inflation=${allScores.inflationRegime.regime}, Risk=${allScores.riskLevel}`;

	log.info({ submitted, failed, skipped: skippedSymbols.length, summary }, "Trade engine complete");

	return { date, marketOpen, decisions: executedDecisions, orders: orderOutcomes, skippedSymbols, summary };
}

/**
 * Preview scores without executing trades (dry run).
 */
export function previewScores(db: Db): ReturnType<typeof scoreAllInstruments> {
	return scoreAllInstruments(db);
}
