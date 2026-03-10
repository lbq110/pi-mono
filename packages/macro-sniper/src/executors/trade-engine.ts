import { getAlpacaClient } from "../broker/alpaca.js";
import type { Db } from "../db/client.js";
import { orders, positions, tradeLog } from "../db/schema.js";
import { createChildLogger } from "../logger.js";
import { isInStopLossCooldown } from "./risk-manager.js";
import { scoreAllInstruments } from "./signal-scorer.js";
import type { InstrumentScore, OrderOutcome, TradeDecision, TradedSymbol, TradeExecutionResult } from "./types.js";

const log = createChildLogger("executor");

// Map from our symbol names to Alpaca symbol names
const ALPACA_SYMBOLS: Record<TradedSymbol, string> = {
	SPY: "SPY",
	QQQ: "QQQ",
	IWM: "IWM",
	BTCUSD: "BTCUSD",
};

// ─── Position sync ────────────────────────────────

interface CurrentPosition {
	direction: "long" | "flat";
	qty: number;
	marketValue: number;
}

async function getCurrentPositions(): Promise<Map<TradedSymbol, CurrentPosition>> {
	const client = getAlpacaClient();
	const alpacaPositions = await client.getPositions();

	const map = new Map<TradedSymbol, CurrentPosition>();
	// Initialize all as flat
	for (const sym of ["SPY", "QQQ", "IWM", "BTCUSD"] as TradedSymbol[]) {
		map.set(sym, { direction: "flat", qty: 0, marketValue: 0 });
	}

	for (const p of alpacaPositions) {
		const sym = Object.entries(ALPACA_SYMBOLS).find(([, v]) => v === p.symbol)?.[0] as TradedSymbol | undefined;
		if (sym) {
			map.set(sym, {
				direction: "long",
				qty: Number.parseFloat(p.qty),
				marketValue: Number.parseFloat(p.market_value),
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

		if (current.direction === "flat" && target === "long") {
			action = "buy";
			reason = `score=${score.finalScore.toFixed(1)}, entering long at $${targetNotional}`;
		} else if (current.direction === "long" && target === "flat") {
			action = "sell";
			const veto = score.creditVeto ? "credit_veto" : score.btcSyncVeto ? "btc_sync_veto" : "score_below_threshold";
			reason = `${veto}, closing position`;
		} else if (current.direction === "long" && target === "long") {
			// Check if size needs adjustment (>20% difference)
			const sizeDiff = Math.abs(targetNotional - current.marketValue) / current.marketValue;
			if (sizeDiff > 0.2) {
				action = targetNotional > current.marketValue ? "resize_up" : "resize_down";
				reason = `score=${score.finalScore.toFixed(1)}, resize ${current.marketValue.toFixed(0)} → ${targetNotional.toFixed(0)}`;
			} else {
				action = "hold";
				reason = `score=${score.finalScore.toFixed(1)}, position size within 20% tolerance`;
			}
		} else {
			// both flat
			action = "hold";
			reason = `score=${score.finalScore.toFixed(1)}, remaining flat`;
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
	if (
		isEquity &&
		!marketOpen &&
		(decision.action === "buy" || decision.action === "resize_up" || decision.action === "resize_down")
	) {
		return {
			symbol: decision.symbol,
			side: "buy",
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
	if (decision.action === "buy" || decision.action === "resize_up") {
		if (isInStopLossCooldown(db, decision.symbol)) {
			log.info({ symbol: decision.symbol }, "Buy skipped: L1 stop-loss cooldown active");
			return {
				symbol: decision.symbol,
				side: "buy",
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

	for (const sym of ["SPY", "QQQ", "IWM", "BTCUSD"] as TradedSymbol[]) {
		const alpacaSym = ALPACA_SYMBOLS[sym];
		const p = alpacaPositions.find((ap) => ap.symbol === alpacaSym);

		if (p) {
			db.insert(positions)
				.values({
					symbol: sym,
					direction: "long",
					quantity: Number.parseFloat(p.qty),
					avgCost: Number.parseFloat(p.avg_entry_price),
					currentPrice: Number.parseFloat(p.current_price),
					unrealizedPnl: Number.parseFloat(p.unrealized_pl),
					updatedAt: now,
				})
				.onConflictDoUpdate({
					target: [positions.symbol],
					set: {
						direction: "long",
						quantity: Number.parseFloat(p.qty),
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

	// Score all instruments
	const allScores = scoreAllInstruments(db);
	const { SPY, QQQ, IWM, BTCUSD } = allScores;

	// Get current positions
	const currentPositions = await getCurrentPositions();

	// Generate decisions
	const decisions = makeDecisions({ SPY, QQQ, IWM, BTCUSD }, currentPositions);

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

	const submitted = orderOutcomes.filter((o) => o.status === "submitted").length;
	const failed = orderOutcomes.filter((o) => o.status === "failed").length;
	const summary = `${submitted} orders submitted, ${failed} failed, ${skippedSymbols.length} skipped. Bias=${allScores.marketBias}(${allScores.marketBiasConfidence}), Inflation=${allScores.inflationRegime.regime}`;

	log.info({ submitted, failed, skipped: skippedSymbols.length, summary }, "Trade engine complete");

	return { date, marketOpen, decisions, orders: orderOutcomes, skippedSymbols, summary };
}

/**
 * Preview scores without executing trades (dry run).
 */
export function previewScores(db: Db): ReturnType<typeof scoreAllInstruments> {
	return scoreAllInstruments(db);
}
