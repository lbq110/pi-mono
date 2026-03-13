import { z } from "zod";

// ─── Liquidity Signal Metadata ───────────────────

export const liquiditySignalMetadataSchema = z.object({
	net_liquidity: z.number(),
	net_liquidity_7d_change: z.number(),
	fed_total_assets: z.number(),
	tga: z.number(),
	on_rrp: z.number(),
	sofr: z.number(),
	iorb: z.number(),
	sofr_iorb_spread_bps: z.number(),
	funding_tight: z.boolean(),
	stale: z.boolean().default(false),
	stale_sources: z.array(z.string()).default([]),
});

export type LiquiditySignalMetadata = z.infer<typeof liquiditySignalMetadataSchema>;

// ─── Yield Curve Signal Metadata ─────────────────

export const yieldCurveSignalMetadataSchema = z.object({
	dgs2: z.number(),
	dgs10: z.number(),
	dgs20: z.number(),
	dgs30: z.number(),
	spread_10s2s: z.number(),
	delta_5d_2y_bps: z.number(),
	delta_5d_10y_bps: z.number(),
	stale: z.boolean().default(false),
	stale_sources: z.array(z.string()).default([]),
});

export type YieldCurveSignalMetadata = z.infer<typeof yieldCurveSignalMetadataSchema>;

// ─── Credit Risk Signal Metadata ─────────────────

export const creditRiskSignalMetadataSchema = z.object({
	hyg_ief_ratio: z.number(),
	hyg_ief_ma20: z.number(),
	lqd_ief_ratio: z.number(),
	lqd_ief_ma20: z.number(),
	hyg_breach: z.boolean(),
	lqd_breach: z.boolean(),
	hyg_breach_pct: z.number(), // how far below MA20 (e.g. -0.025 = 2.5%)
	lqd_breach_pct: z.number(),
	consecutive_breach_days: z.number(),
	both_breach: z.boolean(), // HYG AND LQD both in breach
	credit_multiplier: z.number(), // graduated: 1.0 / 0.7 / 0.3 / 0.0
	stale: z.boolean().default(false),
	stale_sources: z.array(z.string()).default([]),
});

export type CreditRiskSignalMetadata = z.infer<typeof creditRiskSignalMetadataSchema>;

// ─── Sentiment Signal Metadata ───────────────────

export const sentimentSignalMetadataSchema = z.object({
	vix: z.number(),
	vix_score: z.number(),
	move: z.number(),
	move_score: z.number(),
	fear_greed_index: z.number(),
	fear_greed_score: z.number(),
	composite_score: z.number(),
	stale: z.boolean().default(false),
	stale_sources: z.array(z.string()).default([]),
});

export type SentimentSignalMetadata = z.infer<typeof sentimentSignalMetadataSchema>;

// ─── Market Bias (composite signal) ──────────────

export const marketBiasMetadataSchema = z.object({
	overall_bias: z.enum(["risk_on", "risk_off", "neutral", "conflicted"]),
	confidence: z.enum(["high", "medium", "low"]),
	signals: z.object({
		liquidity: z.string(),
		curve: z.string(),
		credit: z.string(),
		sentiment: z.string(),
		btc: z.string().optional(),
		correlation: z.string().optional(),
	}),
	conflicts: z.array(z.string()),
	tags: z.array(z.string()),
});

export type MarketBiasMetadata = z.infer<typeof marketBiasMetadataSchema>;

// ─── USD Model Signal Metadata ───────────────────

export const usdModelSignalMetadataSchema = z.object({
	dxy: z.number().nullable(),
	dxy_change_pct: z.number().nullable(),
	fed_funds_rate: z.number().nullable(),
	ecb_rate: z.number().nullable(),
	boj_rate: z.number().nullable(),
	sonia_rate: z.number().nullable(),
	fed_ecb_diff: z.number().nullable(),
	fed_boj_diff: z.number().nullable(),
	dgs2: z.number().nullable(),
	dgs10: z.number().nullable(),
	real_rate_10y: z.number().nullable(),
	rate_support_score: z.number(),
	term_premium_10y: z.number().nullable(),
	vix: z.number().nullable(),
	risk_premium_score: z.number(),
	gold_price: z.number().nullable(),
	gold_change_pct: z.number().nullable(),
	sofr_iorb_spread_bps: z.number().nullable(),
	convenience_yield_score: z.number(),
	yield_decomposition: z.object({
		nominal_10y: z.number().nullable(),
		real_rate_est: z.number().nullable(),
		inflation_expectation: z.number().nullable(),
		term_premium: z.number().nullable(),
		driver: z.enum(["real_rate", "inflation", "term_premium", "unknown"]),
	}),
	sofr_rate: z.number().nullable(),
	eur_str_rate: z.number().nullable(),
	cip_basis_proxy: z.number().nullable(),
	hedging_cost_score: z.number().nullable(),
	cftc_noncomm_net: z.number().nullable(),
	cftc_noncomm_net_change: z.number().nullable(),
	eur_asset_mgr_net: z.number().nullable(),
	eur_asset_mgr_net_change: z.number().nullable(),
	jpy_asset_mgr_net: z.number().nullable(),
	jpy_asset_mgr_net_change: z.number().nullable(),
	dxy_rate_divergence: z.number().nullable(),
	hedge_transmission_score: z.number(),
	eurusd: z.number().nullable(),
	usdjpy: z.number().nullable(),
	usdcny: z.number().nullable(),
	usdmxn: z.number().nullable(),
	global_relative_score: z.number(),
	composite_score: z.number(),
	fx_pairs: z.record(z.string(), z.number()),
	stale: z.boolean(),
	stale_sources: z.array(z.string()),
});

export type UsdModelSignalMetadata = z.infer<typeof usdModelSignalMetadataSchema>;

// ─── BTC Signal Metadata ─────────────────────────

export const btcSignalMetadataSchema = z.object({
	// Price technicals
	btc_price: z.number(),
	ma7d: z.number(),
	price_vs_ma_pct: z.number(), // (price - ma7d) / ma7d * 100
	above_ma7d: z.boolean(),
	volume_24h: z.number(), // USDT volume
	volume_ma7d: z.number(), // 7-day average daily volume
	volume_ratio: z.number(), // volume_24h / volume_ma7d
	volume_expanding: z.boolean(), // volume_ratio > 1.2
	change_pct_24h: z.number(),
	sharp_drop_alert: z.boolean(), // change_pct_24h < -5%
	daily_closes: z.array(z.number()), // last 7 daily closes (oldest first)
	technicals_score: z.number(), // 0-100 pillar score

	// Derivatives
	funding_rate: z.number().nullable(),
	long_short_ratio: z.number().nullable(),
	taker_buy_sell_ratio: z.number().nullable(),
	oi_change_7d: z.number().nullable(), // 7d change rate (not absolute)
	oi_current: z.number().nullable(), // current OI in USD
	derivatives_score: z.number(), // 0-100 pillar score

	// On-chain
	mvrv: z.number().nullable(),
	net_exchange_flow: z.number().nullable(), // positive = selling pressure
	active_addresses: z.number().nullable(),
	onchain_score: z.number(), // 0-100 pillar score

	// ETF volume-price divergence
	etf_dollar_volume: z.number().nullable(), // combined IBIT+FBTC+ARKB+GBTC daily $ vol
	etf_volume_ratio: z.number().nullable(), // vs 20d average
	etf_divergence_type: z.enum(["absorption", "momentum_confirm", "weak_rally", "apathy", "no_data"]),
	etf_flow_score: z.number(), // 0-100 divergence-based score

	// Composite
	composite_score: z.number(), // 0-100 weighted composite
	equity_score_modifier: z.number(), // +5 bullish, -10 sharp drop, 0 neutral
	stale: z.boolean(),
	stale_sources: z.array(z.string()).default([]),
});

export type BtcSignalMetadata = z.infer<typeof btcSignalMetadataSchema>;

// ─── Correlation Matrix Metadata ─────────────────

// Correlation symbol constants (used for documentation only; actual logic in correlation.ts)

export const correlationMatrixMetadataSchema = z.object({
	// Flat map of pair correlations, e.g. "SPY_BTCUSD": 0.72
	window_7d_hourly: z.record(z.string(), z.number()),
	window_30d_daily: z.record(z.string(), z.number()),
	btc_spy_7d: z.number().nullable(),
	btc_spy_30d: z.number().nullable(),
	regime_7d: z.enum(["synchronized", "independent", "neutral"]),
	regime_30d: z.enum(["synchronized", "independent", "neutral"]),
	data_points_7d: z.number(), // aligned candles used
	data_points_30d: z.number(), // aligned days used
	stale: z.boolean(),
});

export type CorrelationMatrixMetadata = z.infer<typeof correlationMatrixMetadataSchema>;

// ─── Analysis Result Types ───────────────────────

export type AnalysisType =
	| "liquidity_signal"
	| "yield_curve"
	| "credit_risk"
	| "sentiment_signal"
	| "usd_model"
	| "market_bias"
	| "btc_signal"
	| "correlation_matrix"
	| "auction_health";

const auctionHealthMetadataSchema = z.object({
	auctions: z.array(
		z.object({
			term: z.string(),
			auctionDate: z.string(),
			healthScore: z.number(),
			bidToCover: z.number().nullable(),
			bidToCoverDelta: z.number().nullable(),
			indirectPct: z.number().nullable(),
			dealerPct: z.number().nullable(),
			tailBps: z.number().nullable(),
			wiProxy: z.number().nullable(),
			highYield: z.number().nullable(),
		}),
	),
	aggregate_health: z.number(),
	short_end_health: z.number(),
	long_end_health: z.number(),
	term_premium_signal: z.number(),
	avg_tail_bps: z.number().nullable(),
	stale: z.boolean(),
});

export type AuctionHealthMetadata = z.infer<typeof auctionHealthMetadataSchema>;

export const analysisMetadataSchemas: Record<AnalysisType, z.ZodType> = {
	liquidity_signal: liquiditySignalMetadataSchema,
	yield_curve: yieldCurveSignalMetadataSchema,
	credit_risk: creditRiskSignalMetadataSchema,
	sentiment_signal: sentimentSignalMetadataSchema,
	usd_model: usdModelSignalMetadataSchema,
	market_bias: marketBiasMetadataSchema,
	btc_signal: btcSignalMetadataSchema,
	correlation_matrix: correlationMatrixMetadataSchema,
	auction_health: auctionHealthMetadataSchema,
};

/** Validate metadata for a given analysis type. Throws on invalid data. */
export function validateAnalysisMetadata(type: AnalysisType, metadata: unknown): unknown {
	const schema = analysisMetadataSchemas[type];
	return schema.parse(metadata);
}

// ─── Signal Value Types ──────────────────────────

export type LiquiditySignal = "expanding" | "contracting" | "neutral";
export type YieldCurveSignal = "bear_steepener" | "bull_steepener" | "bear_flattener" | "bull_flattener" | "neutral";
export type CreditRiskSignal = "risk_on" | "risk_off" | "risk_off_confirmed" | "risk_off_severe";
export type SentimentSignal = "extreme_fear" | "fear" | "neutral" | "greed" | "extreme_greed";
export type BtcSignal = "bullish" | "bearish_alert" | "neutral";
export type CorrelationRegime = "synchronized" | "independent" | "neutral";
