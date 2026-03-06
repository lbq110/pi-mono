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
/** Moving average window (trading days) */
export const CREDIT_MA_WINDOW = 20;
/** Consecutive confirmation days */
export const CREDIT_CONFIRM_DAYS = 2;

// ─── D. Sentiment Signal Thresholds ──────────────

/** VIX normalization range */
export const VIX_FEAR_CEIL = 40;
export const VIX_GREED_FLOOR = 12;

/** MOVE normalization range */
export const MOVE_FEAR_CEIL = 180;
export const MOVE_GREED_FLOOR = 80;

/** BTC ETF 7-day cumulative net inflow normalization (unit: hundred million USD) */
export const ETF_FLOW_UPPER = 5;
export const ETF_FLOW_LOWER = -5;

/** BTC OI 7-day change rate normalization */
export const OI_CHANGE_UPPER = 0.1;
export const OI_CHANGE_LOWER = -0.1;

/** Indicator weights */
export const SENTIMENT_WEIGHTS = {
	vix: 0.25,
	move: 0.15,
	fearGreed: 0.2,
	etfFlow: 0.2,
	oiChange: 0.2,
};

/** Sentiment bracket thresholds */
export const SENTIMENT_EXTREME_FEAR = 20;
export const SENTIMENT_FEAR = 40;
export const SENTIMENT_GREED = 60;
export const SENTIMENT_EXTREME_GREED = 80;

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
	hedgeEfficiency: 0.1, // hedge transmission
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
