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
	consecutive_breach_days: z.number(),
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
	btc_price: z.number(),
	etf_flow_7d: z.number(),
	etf_flow_score: z.number(),
	oi_change_7d: z.number(),
	oi_change_score: z.number(),
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
	dgs2: z.number().nullable(),
	dgs10: z.number().nullable(),
	rate_support_score: z.number(),
	term_premium_10y: z.number().nullable(),
	vix: z.number().nullable(),
	risk_premium_score: z.number(),
	bei_5y: z.number().nullable(),
	bei_10y: z.number().nullable(),
	convenience_yield_score: z.number(),
	yield_decomposition: z.object({
		nominal_10y: z.number().nullable(),
		real_rate_est: z.number().nullable(),
		inflation_expectation: z.number().nullable(),
		term_premium: z.number().nullable(),
		driver: z.enum(["real_rate", "inflation", "term_premium", "unknown"]),
	}),
	hedge_efficiency_score: z.number(),
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

// ─── Analysis Result Types ───────────────────────

export type AnalysisType =
	| "liquidity_signal"
	| "yield_curve"
	| "credit_risk"
	| "sentiment_signal"
	| "usd_model"
	| "market_bias";

export const analysisMetadataSchemas: Record<AnalysisType, z.ZodType> = {
	liquidity_signal: liquiditySignalMetadataSchema,
	yield_curve: yieldCurveSignalMetadataSchema,
	credit_risk: creditRiskSignalMetadataSchema,
	sentiment_signal: sentimentSignalMetadataSchema,
	usd_model: usdModelSignalMetadataSchema,
	market_bias: marketBiasMetadataSchema,
};

/** Validate metadata for a given analysis type. Throws on invalid data. */
export function validateAnalysisMetadata(type: AnalysisType, metadata: unknown): unknown {
	const schema = analysisMetadataSchemas[type];
	return schema.parse(metadata);
}

// ─── Signal Value Types ──────────────────────────

export type LiquiditySignal = "expanding" | "contracting" | "neutral";
export type YieldCurveSignal = "bear_steepener" | "bull_steepener" | "bear_flattener" | "bull_flattener" | "neutral";
export type CreditRiskSignal = "risk_on" | "risk_off" | "risk_off_confirmed";
export type SentimentSignal = "extreme_fear" | "fear" | "neutral" | "greed" | "extreme_greed";
