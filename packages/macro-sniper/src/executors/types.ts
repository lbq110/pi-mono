/** Placeholder types for Phase 3 trade execution. */

export interface TradeOrder {
	symbol: string;
	side: "buy" | "sell";
	quantity: number;
	type: "market" | "limit";
	limitPrice?: number;
}

export interface TradeResult {
	orderId: string;
	status: "filled" | "partial" | "rejected";
	filledQuantity: number;
	filledPrice: number;
	timestamp: string;
}
