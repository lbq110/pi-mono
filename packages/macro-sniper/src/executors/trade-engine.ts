import { getAlpacaClient } from "../broker/alpaca.js";
import type { Db } from "../db/client.js";
import { orders, positions, tradeLog } from "../db/schema.js";
import { createChildLogger } from "../logger.js";
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

/** Sync local positions table with Alpaca actuals */
async function syncPositionsToDb(db: Db): Promise<void> {
	const client = getAlpacaClient();
	const alpacaPositions = await client.getPositions();
	const now = new Date().toISOString();

	for (const sym of ["SPY", "QQQ", "IWM", "BTCUSD", "UUP"] as TradedSymbol[]) {
		const alpacaSym = ALPACA_SYMBOLS[sym];
		const p = alpacaPositions.find((ap) => ap.symbol === alpacaSym);

		if (p) {
			const direction: "long" | "short" = p.side === "short" ? "short" : "long";
			db.insert(positions)
				.values({
					symbol: sym,
					direction,
					quantity: Math.abs(Number.parseFloat(p.qty)),
					avgCost: Number.parseFloat(p.avg_entry_price),
					currentPrice: Number.parseFloat(p.current_price),
					unrealizedPnl: Number.parseFloat(p.unrealized_pl),
					updatedAt: now,
				})
				.onConflictDoUpdate({
					target: [positions.symbol],
					set: {
						direction,
						quantity: Math.abs(Number.parseFloat(p.qty)),
						avgCost: Number.parseFloat(p.avg_entry_price),
						currentPrice: Number.parseFloat(p.current_price),
						unrealizedPnl: Number.parseFloat(p.unrealized_pl),
						updatedAt: now,
					},
				})
				.run();
		} else {
			// Mark as flat
			db.insert(positions)
				.values({
					symbol: sym,
					direction: "flat",
					quantity: 0,
					avgCost: 0,
					currentPrice: 0,
					unrealizedPnl: 0,
					updatedAt: now,
				})
				.onConflictDoUpdate({
					target: [positions.symbol],
					set: { direction: "flat", quantity: 0, currentPrice: 0, unrealizedPnl: 0, updatedAt: now },
				})
				.run();
		}
	}
}

// ─── Main entry point ─────────────────────────────

/**
 * Run the full trade cycle:
 * 1. Score all instruments from analysis_results
 * 2. Compare vs current Alpaca positions
 * 3. Execute necessary orders
 * 4. Sync positions to local DB
 * 5. Return execution summary
 */
export async function runTradeEngine(db: Db): Promise<TradeExecutionResult> {
	const now = new Date().toISOString();
	const date = now.split("T")[0];

	log.info({ date }, "Running trade engine");

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

	// Generate decisions
	const decisions = makeDecisions({ SPY, QQQ, IWM, BTCUSD, UUP }, currentPositions);

	// Execute orders
	const orderOutcomes: OrderOutcome[] = [];
	const skippedSymbols: string[] = [];

	for (const decision of decisions) {
		const outcome = await executeDecision(db, decision, marketOpen);
		orderOutcomes.push(outcome);
		if (outcome.status === "skipped") {
			skippedSymbols.push(`${decision.symbol}(${outcome.error ?? decision.action})`);
		}
	}

	// Sync positions table
	await syncPositionsToDb(db);

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
	const summary = `${submitted} orders submitted, ${failed} failed, ${skippedSymbols.length} skipped. Bias=${allScores.marketBias}(${allScores.marketBiasConfidence}), Inflation=${allScores.inflationRegime.regime}, Risk=${allScores.riskLevel}`;

	log.info({ submitted, failed, skipped: skippedSymbols.length, summary }, "Trade engine complete");

	return { date, marketOpen, decisions, orders: orderOutcomes, skippedSymbols, summary };
}

/**
 * Preview scores without executing trades (dry run).
 */
export function previewScores(db: Db): ReturnType<typeof scoreAllInstruments> {
	return scoreAllInstruments(db);
}
