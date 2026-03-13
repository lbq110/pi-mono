// ─── Stale Data Thresholds ───────────────────────

/** Stale detection thresholds per data source frequency */
export const STALE_THRESHOLDS = {
	/** Weekly data (WALCL / WTREGEN): >9 days without new data = stale */
	weekly: 9,
	/** Daily FRED data (SOFR / IORB / EFFR / DGS* / VIXCLS): >3 days (incl. weekends) */
	dailyFred: 3,
	/** Daily market data (HYG / LQD / IEF / MOVE / Fear & Greed): >3 days */
	dailyMarket: 3,
	/** High-frequency data (BTC price / OI): >1 hour */
	highFrequency: 1, // unit: hours
};

// ─── A. Liquidity Signal Thresholds ──────────────

/** Net liquidity 7-day change threshold (unit: hundred million USD) */
export const LIQUIDITY_EXPANDING_THRESHOLD = 500;
export const LIQUIDITY_CONTRACTING_THRESHOLD = -500;

/** SOFR-IORB spread warning threshold (unit: bps) */
export const SOFR_IORB_TIGHT_THRESHOLD = 5;

// ─── A2. Funding Stress (SRF + SOFR) Thresholds ─

/** SRF daily take-up elevated threshold ($ billion) */
export const SRF_ELEVATED_THRESHOLD = 5;
/** SRF daily take-up spike/severe threshold ($ billion) */
export const SRF_SPIKE_THRESHOLD = 20;

/** SOFR − IORB spread: above 0 = SOFR exceeds IORB, funding pressure */
export const SOFR_IORB_POSITIVE_THRESHOLD = 0; // bps
// SOFR_IORB_TIGHT_THRESHOLD already defined in A1 (5 bps)

/** SOFR 99th percentile − IORB: tail stress (bps) */
export const SOFR99_IORB_THRESHOLD = 8;

// ─── B. Yield Curve Shape Thresholds ─────────────

/** Minimum effective move for single side (unit: bps) */
export const CURVE_MOVE_THRESHOLD = 3;
/** Minimum effective spread between long/short end (unit: bps) */
export const CURVE_SPREAD_THRESHOLD = 3;
/** Lookback window for shape determination (trading days) */
export const CURVE_LOOKBACK_DAYS = 5;

// ─── C. Credit Risk Thresholds ───────────────────

/** Breach ratio below MA: ratio < MA20 * 0.98 = breach by 2% */
export const CREDIT_BREACH_RATIO = 0.98;
/** Severe breach: ratio < MA20 * 0.96 = breach by 4%+ */
export const CREDIT_SEVERE_BREACH_RATIO = 0.96;
/** Moving average window (trading days) */
export const CREDIT_MA_WINDOW = 20;
/** Consecutive days for confirmed signal */
export const CREDIT_CONFIRM_DAYS = 2;
/** Consecutive days for severe signal */
export const CREDIT_SEVERE_CONFIRM_DAYS = 3;

/**
 * Graduated credit risk multipliers (applied to position sizing).
 *
 *   risk_on           → ×1.0  normal
 *   risk_off          → ×0.7  breach detected, not yet confirmed
 *   risk_off_confirmed→ ×0.3  confirmed (2+ days breach ≥2%)
 *   risk_off_severe   → ×0.0  severe (3+ days breach ≥4%, or both HYG+LQD breach)
 */
export const CREDIT_RISK_MULTIPLIER: Record<string, number> = {
	risk_on: 1.0,
	risk_off: 0.7,
	risk_off_confirmed: 0.3,
	risk_off_severe: 0.0,
};

// ─── D. Sentiment Signal Thresholds ──────────────

/** VIX normalization range */
export const VIX_FEAR_CEIL = 40;
export const VIX_GREED_FLOOR = 12;

/** MOVE normalization range */
export const MOVE_FEAR_CEIL = 180;
export const MOVE_GREED_FLOOR = 80;

/** Indicator weights (VIX + MOVE + Fear&Greed = 1.0) */
export const SENTIMENT_WEIGHTS = {
	vix: 0.35,
	move: 0.25,
	fearGreed: 0.4,
};

/** Sentiment bracket thresholds */
export const SENTIMENT_EXTREME_FEAR = 20;
export const SENTIMENT_FEAR = 40;
export const SENTIMENT_GREED = 60;
export const SENTIMENT_EXTREME_GREED = 80;

// ─── D2. BTC Signal Thresholds ───────────────────

/** BTC signal pillar weights (4 pillars, sum = 1.0) */
export const BTC_SIGNAL_WEIGHTS = {
	/** Price technicals: MA7d, volume, momentum */
	technicals: 0.35,
	/** Derivatives: funding rate, long/short, OI change, taker ratio */
	derivatives: 0.4,
	/** On-chain: MVRV, exchange netflow, active addresses (T-1 lag) */
	onchain: 0.15,
	/** ETF volume-price divergence (lagging data, low weight) */
	etfFlow: 0.1,
};

/** Funding rate normalization: typical range ±0.03% (8h) */
export const FUNDING_RATE_HIGH = 0.001; // 0.1% = extreme bullish crowding
export const FUNDING_RATE_LOW = -0.001; // -0.1% = extreme bearish

/** Long/short ratio normalization: typical range 0.8-2.0 */
export const LONG_SHORT_RATIO_HIGH = 2.0;
export const LONG_SHORT_RATIO_LOW = 0.8;

/** Taker buy/sell ratio: > 1 = bullish, < 1 = bearish */
export const TAKER_RATIO_HIGH = 1.3;
export const TAKER_RATIO_LOW = 0.7;

/** OI 7-day change rate: ±10% is significant */
export const OI_CHANGE_RATE_HIGH = 0.1;
export const OI_CHANGE_RATE_LOW = -0.1;

/** MVRV: < 1.0 = undervalued, > 3.5 = overheated */
export const MVRV_UNDERVALUED = 1.0;
export const MVRV_FAIR = 2.0;
export const MVRV_OVERHEATED = 3.5;

/** Exchange netflow (BTC): positive = selling pressure, negative = accumulation */
export const EXCHANGE_NETFLOW_SELL_THRESHOLD = 500; // BTC, net inflow
export const EXCHANGE_NETFLOW_ACCUM_THRESHOLD = -500; // BTC, net outflow

/** ETF dollar volume ratio vs 20-day MA thresholds */
export const ETF_VOLUME_RATIO_HIGH = 1.3;
export const ETF_VOLUME_RATIO_LOW = 0.7;

/**
 * ETF volume-price divergence scoring.
 *
 * Raw ETF volume is already priced in. The forward-looking signal is the
 * DIVERGENCE between volume and price:
 *   - High volume + flat/falling price  → absorption / hidden demand (bullish)
 *   - High volume + rising price        → momentum confirmation (neutral — already in price)
 *   - Low volume  + rising price        → rally losing steam (bearish)
 *   - Low volume  + flat/falling price  → apathy (neutral)
 *
 * "High volume" = ETF vol ratio > ETF_DIVERGENCE_VOL_SURGE
 * "Rising price" = BTC 24h change > ETF_DIVERGENCE_PRICE_MOVE_PCT
 */
export const ETF_DIVERGENCE_VOL_SURGE = 1.2; // vol ratio threshold for "high volume"
export const ETF_DIVERGENCE_PRICE_MOVE_PCT = 1.0; // % threshold for "rising price"

// ─── F. USD Model Thresholds ─────────────────────

/** Term premium threshold: above this = risk premium pressure (bps) */
export const USD_TERM_PREMIUM_HIGH = 100;
export const USD_TERM_PREMIUM_LOW = 30;

/** VIX thresholds for π_risk scoring */
export const USD_VIX_HIGH = 30;
export const USD_VIX_LOW = 15;

/** BEI (breakeven inflation) thresholds for inflation risk */
export const USD_BEI_HIGH = 3.0;
export const USD_BEI_LOW = 1.5;

/** USD composite signal brackets */
export const USD_BULLISH_THRESHOLD = 60;
export const USD_BEARISH_THRESHOLD = 40;

/** USD model factor weights (sum = 1.0) */
export const USD_MODEL_WEIGHTS = {
	rateSupport: 0.3, // r_f: interest differential
	riskPremium: 0.25, // π_risk: policy/fiscal uncertainty
	convenienceYield: 0.15, // cy: USD safety premium
	hedgePosition: 0.1, // hedge cost & CFTC positioning
	globalRelative: 0.2, // passive strength from weak peers
};

// ─── E. Signal Priority & Composite ─────────────

/**
 * Signal priority (higher number = higher priority):
 * 1. Credit spread Risk-off — systemic risk, highest priority
 * 2. Liquidity + yield curve — macro direction
 * 3. Sentiment — contrarian reference only
 */
export const SIGNAL_PRIORITY = {
	credit: 3,
	liquidity: 2,
	curve: 2,
	sentiment: 1,
};
