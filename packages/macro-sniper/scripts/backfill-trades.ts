#!/usr/bin/env tsx
/**
 * Backfill position_trades table from Alpaca order history.
 *
 * Fetches all filled orders, reconstructs position state transitions,
 * and inserts records into the position_trades table.
 *
 * Usage: node --env-file=.env --import tsx scripts/backfill-trades.ts
 */

import { loadConfig } from "../src/config.js";
import { closeDb, getDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { positionTrades } from "../src/db/schema.js";

runMigrations();

interface AlpacaOrderRaw {
	id: string;
	symbol: string;
	side: string;
	qty: string;
	filled_qty: string;
	filled_avg_price: string | null;
	status: string;
	created_at: string;
	filled_at: string | null;
	notional: string | null;
}

const config = loadConfig();

async function fetchAllFilledOrders(): Promise<AlpacaOrderRaw[]> {
	const headers: Record<string, string> = {
		"APCA-API-KEY-ID": config.ALPACA_API_KEY!,
		"APCA-API-SECRET-KEY": config.ALPACA_API_SECRET!,
	};

	// Fetch all orders (up to 500)
	const resp = await fetch(
		`${config.ALPACA_BASE_URL}/orders?status=all&limit=500&direction=asc`,
		{ headers },
	);
	if (!resp.ok) throw new Error(`Alpaca API error: ${resp.status} ${await resp.text()}`);
	const raw: AlpacaOrderRaw[] = await resp.json();

	// Deduplicate by order ID
	const seen = new Set<string>();
	const deduped = raw.filter((o) => {
		if (seen.has(o.id)) return false;
		seen.add(o.id);
		return true;
	});

	// Only filled orders
	return deduped.filter((o) => o.status === "filled");
}

interface PositionState {
	direction: "long" | "short" | "flat";
	qty: number;
	avgCost: number;
	openedAt: string | null;
}

function main() {
	return fetchAllFilledOrders().then((filledOrders) => {
		const db = getDb();

		// Check if already backfilled
		const existing = db.select({ id: positionTrades.id }).from(positionTrades).limit(1).all();
		if (existing.length > 0) {
			console.log("position_trades already has data. Skipping backfill.");
			console.log("To re-run, manually DELETE FROM position_trades first.");
			closeDb();
			return;
		}

		console.log(`Fetched ${filledOrders.length} filled orders from Alpaca`);

		// Sort by filled_at ascending
		filledOrders.sort((a, b) => (a.filled_at ?? "").localeCompare(b.filled_at ?? ""));

		// Track position state per symbol
		const state: Record<string, PositionState> = {};
		const getState = (sym: string): PositionState =>
			state[sym] ?? { direction: "flat", qty: 0, avgCost: 0, openedAt: null };

		// Normalize symbol: BTC/USD -> BTCUSD
		const normSym = (s: string) => s.replace("/", "");

		let insertCount = 0;

		for (const order of filledOrders) {
			const symbol = normSym(order.symbol);
			const price = Number(order.filled_avg_price ?? 0);
			const qty = Number(order.filled_qty ?? order.qty ?? 0);
			const side = order.side as "buy" | "sell";
			const filledAt = order.filled_at ?? order.created_at;

			if (price === 0 || qty === 0) continue;

			const prev = getState(symbol);
			const prevDirection = prev.direction;
			const prevQty = prev.qty;
			const prevAvgCost = prev.avgCost;
			const prevOpenedAt = prev.openedAt;

			let operationType: string;
			let newDirection: "long" | "short" | "flat";
			let newQty: number;
			let newAvgCost: number;
			let realizedPnl: number | null = null;
			let realizedPnlPct: number | null = null;
			let holdingDuration: number | null = null;

			if (side === "buy") {
				if (prevDirection === "flat") {
					// New long position
					operationType = "open";
					newDirection = "long";
					newQty = qty;
					newAvgCost = price;
				} else if (prevDirection === "long") {
					// Adding to long
					operationType = "add";
					newDirection = "long";
					const totalCost = prevAvgCost * prevQty + price * qty;
					newQty = prevQty + qty;
					newAvgCost = newQty > 0 ? totalCost / newQty : 0;
				} else {
					// prevDirection === "short" — covering short
					if (qty >= prevQty - 0.0001) {
						// Full cover
						operationType = "close";
						newDirection = "flat";
						newQty = 0;
						newAvgCost = 0;
						realizedPnl = (prevAvgCost - price) * prevQty;
						realizedPnlPct = prevAvgCost > 0 ? realizedPnl / (prevAvgCost * prevQty) : null;
					} else {
						// Partial cover
						operationType = "reduce";
						newDirection = "short";
						newQty = prevQty - qty;
						newAvgCost = prevAvgCost;
						realizedPnl = (prevAvgCost - price) * qty;
						realizedPnlPct = prevAvgCost > 0 ? realizedPnl / (prevAvgCost * qty) : null;
					}
				}
			} else {
				// side === "sell"
				if (prevDirection === "flat") {
					// New short position
					operationType = "open";
					newDirection = "short";
					newQty = qty;
					newAvgCost = price;
				} else if (prevDirection === "short") {
					// Adding to short
					operationType = "add";
					newDirection = "short";
					const totalCost = prevAvgCost * prevQty + price * qty;
					newQty = prevQty + qty;
					newAvgCost = newQty > 0 ? totalCost / newQty : 0;
				} else {
					// prevDirection === "long" — closing long
					if (qty >= prevQty - 0.0001) {
						// Full close
						operationType = "close";
						newDirection = "flat";
						newQty = 0;
						newAvgCost = 0;
						realizedPnl = (price - prevAvgCost) * prevQty;
						realizedPnlPct = prevAvgCost > 0 ? realizedPnl / (prevAvgCost * prevQty) : null;
					} else {
						// Partial close
						operationType = "reduce";
						newDirection = "long";
						newQty = prevQty - qty;
						newAvgCost = prevAvgCost;
						realizedPnl = (price - prevAvgCost) * qty;
						realizedPnlPct = prevAvgCost > 0 ? realizedPnl / (prevAvgCost * qty) : null;
					}
				}
			}

			// Compute holding duration for close operations
			if ((operationType === "close" || operationType === "reduce") && prevOpenedAt) {
				holdingDuration = Math.round(
					(new Date(filledAt).getTime() - new Date(prevOpenedAt).getTime()) / 1000,
				);
			}

			// Determine trigger heuristic from time patterns
			let trigger = "daily_pipeline";
			const hour = new Date(filledAt).getUTCHours();
			const minute = new Date(filledAt).getUTCMinutes();
			if (symbol === "BTCUSD" && !(hour === 12 && minute <= 10)) {
				// BTC orders outside of 08:00 ET (12:00 UTC) window are hourly
				if (hour !== 12) trigger = "hourly_btc";
			}

			// Tiny residual positions (< 0.001) → treat as flat
			if (newQty < 0.001) {
				newDirection = "flat";
				newQty = 0;
				newAvgCost = 0;
			}

			const notional = price * qty;

			db.insert(positionTrades)
				.values({
					symbol,
					operationType,
					side,
					direction: newDirection,
					quantity: qty,
					price,
					notional,
					prevDirection,
					prevQuantity: prevQty,
					prevAvgCost,
					newQuantity: newQty,
					newAvgCost,
					realizedPnl,
					realizedPnlPct,
					holdingDuration,
					trigger,
					signalScore: null,
					signalSnapshot: null,
					tradeGroup: null,
					alpacaOrderId: order.id,
					createdAt: filledAt,
				})
				.run();

			insertCount++;

			// Update state
			state[symbol] = {
				direction: newDirection,
				qty: newQty,
				avgCost: newAvgCost,
				openedAt:
					operationType === "open"
						? filledAt
						: operationType === "close"
							? null
							: prevOpenedAt,
			};
		}

		console.log(`Inserted ${insertCount} records into position_trades`);

		// Show final reconstructed state
		console.log("\nReconstructed final state:");
		for (const [sym, s] of Object.entries(state)) {
			if (s.qty > 0.001) {
				console.log(`  ${sym.padEnd(8)} ${s.direction}  qty=${s.qty.toFixed(4)}  avgCost=$${s.avgCost.toFixed(2)}  opened=${s.openedAt?.substring(0, 19) ?? "n/a"}`);
			}
		}

		closeDb();
	});
}

main().catch((err) => {
	console.error("Backfill failed:", err);
	process.exit(1);
});
