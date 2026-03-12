// ─── Inflation Regime ─────────────────────────────

export interface InflationRegime {
	regime: "hot" | "warm" | "cool";
	bei10y: number; // T10YIE value
	gld5dMomentum: number; // GLD 5-day return %
	gld20dTrend: number; // GLD 20-day return %
}

// ─── Sub-Score (per signal source) ───────────────

export interface SubScore {
	rawValue: number; // original signal value
	normalized: number; // mapped to [-1, 1]
	weight: number; // assigned weight for this instrument
	contribution: number; // normalized × weight × 100
	note: string; // human-readable explanation
}

// ─── Per-Instrument Score ─────────────────────────

export type TradedSymbol = "SPY" | "QQQ" | "IWM" | "BTCUSD" | "UUP";

export interface InstrumentScore {
	symbol: TradedSymbol;
	baseScore: number; // weighted sum × 100, before modifiers
	finalScore: number; // after BTC equity modifier (or USD direct mapping)
	direction: "long" | "short" | "flat"; // "short" only for UUP
	sizeMultiplier: number; // 0 | 0.5 | 0.75 | 1.0
	notionalTarget: number; // equity × POSITION_MAX_PCT (20%), then ATR-adjusted
	notionalFinal: number; // notionalTarget × sizeMultiplier
	creditVeto: boolean; // credit_risk = risk_off_confirmed
	btcSyncVeto: boolean; // BTC: synchronized + risk_off
	inflationRegime: InflationRegime;
	evidence: {
		liquidity: SubScore;
		yieldCurve: SubScore;
		sentiment: SubScore;
		usdModel: SubScore;
		btcSignal?: SubScore; // BTC only
		corrRegime?: SubScore; // BTC only
		btcEquityModifier: number; // +5 / -10 / 0 for equities
		rotationNote: string; // yield × inflation rotation detail
		conflictNote: string | null; // set if market_bias = conflicted
		corrRegimeNote: string | null; // correlation regime annotation
	};
}

// ─── Trade Decision ───────────────────────────────

export type TradeAction =
	| "buy" // open long
	| "sell" // close long
	| "hold" // no change
	| "resize_up" // increase long
	| "resize_down" // reduce long (close + rebuy)
	| "short" // open short (UUP only)
	| "cover" // close short
	| "resize_short"; // adjust short size (close + re-short)

export interface TradeDecision {
	symbol: string;
	currentDirection: "long" | "short" | "flat";
	targetDirection: "long" | "short" | "flat";
	currentQty: number;
	currentMarketValue: number;
	targetNotional: number;
	action: TradeAction;
	score: InstrumentScore;
	reason: string;
}

// ─── Trade Execution Result ───────────────────────

export interface OrderOutcome {
	symbol: string;
	side: "buy" | "sell";
	notional: number | undefined;
	qty: number | undefined;
	alpacaOrderId: string | null;
	status: "filled" | "submitted" | "skipped" | "failed";
	error?: string;
}

export interface TradeExecutionResult {
	date: string;
	marketOpen: boolean;
	decisions: TradeDecision[];
	orders: OrderOutcome[];
	skippedSymbols: string[];
	summary: string;
}

// ─── Legacy placeholders (kept for compatibility) ─

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
