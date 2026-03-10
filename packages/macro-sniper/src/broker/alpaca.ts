import { loadConfig } from "../config.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("broker");

// ─── Types ────────────────────────────────────────

export interface AlpacaAccount {
	buying_power: string;
	cash: string;
	portfolio_value: string;
	equity: string;
	status: string;
}

export interface AlpacaPosition {
	symbol: string;
	qty: string;
	avg_entry_price: string;
	current_price: string;
	unrealized_pl: string;
	unrealized_plpc: string;
	side: string;
	market_value: string;
}

export interface AlpacaOrder {
	id: string;
	symbol: string;
	side: string;
	qty: string;
	filled_qty: string;
	filled_avg_price: string | null;
	status: string;
	order_type: string;
	created_at: string;
	filled_at: string | null;
}

export interface AlpacaAsset {
	symbol: string;
	tradable: boolean;
	fractionable: boolean;
	class: string;
}

// ─── Client ───────────────────────────────────────

export class AlpacaClient {
	private readonly baseUrl: string;
	private readonly headers: Record<string, string>;

	constructor() {
		const config = loadConfig();
		if (!config.ALPACA_API_KEY || !config.ALPACA_API_SECRET) {
			throw new Error("ALPACA_API_KEY and ALPACA_API_SECRET are required");
		}
		this.baseUrl = config.ALPACA_BASE_URL;
		this.headers = {
			"APCA-API-KEY-ID": config.ALPACA_API_KEY,
			"APCA-API-SECRET-KEY": config.ALPACA_API_SECRET,
			"Content-Type": "application/json",
		};
	}

	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const url = `${this.baseUrl}${path}`;
		const resp = await fetch(url, {
			method,
			headers: this.headers,
			body: body ? JSON.stringify(body) : undefined,
		});

		if (!resp.ok) {
			const text = await resp.text();
			throw new Error(`Alpaca API ${method} ${path} → ${resp.status}: ${text}`);
		}

		// 204 No Content
		if (resp.status === 204) return undefined as T;
		return resp.json() as Promise<T>;
	}

	// ─── Account ─────────────────────────────────

	async getAccount(): Promise<AlpacaAccount> {
		return this.request<AlpacaAccount>("GET", "/account");
	}

	// ─── Positions ───────────────────────────────

	async getPositions(): Promise<AlpacaPosition[]> {
		return this.request<AlpacaPosition[]>("GET", "/positions");
	}

	async getPosition(symbol: string): Promise<AlpacaPosition | null> {
		try {
			return await this.request<AlpacaPosition>("GET", `/positions/${symbol}`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("404")) return null;
			throw err;
		}
	}

	async closePosition(symbol: string): Promise<AlpacaOrder | null> {
		try {
			return await this.request<AlpacaOrder>("DELETE", `/positions/${symbol}`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("404")) return null;
			throw err;
		}
	}

	async closeAllPositions(): Promise<void> {
		await this.request("DELETE", "/positions?cancel_orders=true");
	}

	// ─── Orders ──────────────────────────────────

	async placeMarketOrder(symbol: string, side: "buy" | "sell", notional?: number, qty?: number): Promise<AlpacaOrder> {
		const body: Record<string, unknown> = {
			symbol,
			side,
			type: "market",
			time_in_force: symbol === "BTCUSD" ? "gtc" : "day",
		};

		// Use notional (dollar amount) if provided, else qty
		if (notional !== undefined) {
			body.notional = notional.toFixed(2);
		} else if (qty !== undefined) {
			body.qty = qty.toString();
		} else {
			throw new Error("Either notional or qty must be provided");
		}

		return this.request<AlpacaOrder>("POST", "/orders", body);
	}

	async getOrders(status = "all", limit = 50): Promise<AlpacaOrder[]> {
		return this.request<AlpacaOrder[]>("GET", `/orders?status=${status}&limit=${limit}&direction=desc`);
	}

	async getOrder(orderId: string): Promise<AlpacaOrder> {
		return this.request<AlpacaOrder>("GET", `/orders/${orderId}`);
	}

	async cancelOrder(orderId: string): Promise<void> {
		await this.request("DELETE", `/orders/${orderId}`);
	}

	async cancelAllOrders(): Promise<void> {
		await this.request("DELETE", "/orders");
	}

	// ─── Assets ──────────────────────────────────

	async getAsset(symbol: string): Promise<AlpacaAsset> {
		return this.request<AlpacaAsset>("GET", `/assets/${symbol}`);
	}

	// ─── Clock ───────────────────────────────────

	async isTradingOpen(): Promise<boolean> {
		const clock = await this.request<{ is_open: boolean; next_open: string; next_close: string }>("GET", "/clock");
		return clock.is_open;
	}
}

// ─── Singleton ────────────────────────────────────

let _client: AlpacaClient | null = null;

export function getAlpacaClient(): AlpacaClient {
	if (!_client) _client = new AlpacaClient();
	return _client;
}

// ─── Portfolio helpers ────────────────────────────

export interface PortfolioSummary {
	equity: number;
	cash: number;
	buyingPower: number;
	totalUnrealizedPnl: number;
	positions: {
		symbol: string;
		direction: "long" | "short" | "flat";
		qty: number;
		avgCost: number;
		currentPrice: number;
		marketValue: number;
		unrealizedPnl: number;
		unrealizedPnlPct: number;
	}[];
}

export async function getPortfolioSummary(): Promise<PortfolioSummary> {
	const client = getAlpacaClient();
	const [account, positions] = await Promise.all([client.getAccount(), client.getPositions()]);

	const totalUnrealizedPnl = positions.reduce((sum, p) => sum + Number.parseFloat(p.unrealized_pl), 0);

	return {
		equity: Number.parseFloat(account.equity),
		cash: Number.parseFloat(account.cash),
		buyingPower: Number.parseFloat(account.buying_power),
		totalUnrealizedPnl,
		positions: positions.map((p) => ({
			symbol: p.symbol,
			direction: p.side === "long" ? "long" : p.side === "short" ? "short" : "flat",
			qty: Number.parseFloat(p.qty),
			avgCost: Number.parseFloat(p.avg_entry_price),
			currentPrice: Number.parseFloat(p.current_price),
			marketValue: Number.parseFloat(p.market_value),
			unrealizedPnl: Number.parseFloat(p.unrealized_pl),
			unrealizedPnlPct: Number.parseFloat(p.unrealized_plpc) * 100,
		})),
	};
}

export function logOrderPlaced(symbol: string, side: string, notional: number | undefined, orderId: string): void {
	log.info({ symbol, side, notional, orderId }, "Order placed");
}
