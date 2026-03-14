import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { analysisResults } from "../db/schema.js";
import type { AnalysisType } from "../types.js";

// ─── Factor Dimension Classification ─────────────

/**
 * 6 independent dimensions + 2 meta-factors.
 *
 * Each dimension answers ONE independent question about the market.
 * Signals within the same dimension are structurally correlated
 * and should not receive separate weights in the scorer.
 */
export interface FactorDimension {
	name: string;
	question: string;
	signals: AnalysisType[];
	primaryMetric: string; // metadata field name for the composite continuous value
	sharedInputs: string[]; // raw data sources shared by signals in this dimension
}

export const FACTOR_DIMENSIONS: FactorDimension[] = [
	{
		name: "liquidity_regime",
		question: "钱是在变多还是变少？",
		signals: ["liquidity_signal", "funding_stress"],
		primaryMetric: "net_liquidity_7d_change",
		sharedInputs: ["SOFR", "IORB", "SOFR99", "sofr_iorb_spread_bps"],
	},
	{
		name: "rate_expectations",
		question: "市场认为利率往哪走？",
		signals: ["yield_curve", "auction_health"],
		primaryMetric: "spread_10s2s",
		sharedInputs: ["DGS2", "DGS10", "DGS20", "DGS30"],
	},
	{
		name: "credit_conditions",
		question: "信用风险是否在被重新定价？",
		signals: ["credit_risk"],
		primaryMetric: "hyg_ief_ratio",
		sharedInputs: [],
	},
	{
		name: "risk_appetite",
		question: "市场愿意承担多少风险？",
		signals: ["sentiment_signal"],
		primaryMetric: "composite_score",
		sharedInputs: [],
	},
	{
		name: "usd_regime",
		question: "美元在走强还是走弱？",
		signals: ["usd_model"],
		primaryMetric: "composite_score",
		sharedInputs: [],
	},
	{
		name: "btc_microstructure",
		question: "BTC 自身的供需如何？",
		signals: ["btc_signal"],
		primaryMetric: "composite_score",
		sharedInputs: [],
	},
];

export const META_FACTORS: { name: string; question: string; signal: AnalysisType }[] = [
	{
		name: "cross_asset_structure",
		question: "资产之间的关系在怎么变？",
		signal: "correlation_matrix",
	},
	{
		name: "market_composite",
		question: "所有因子的加权合成",
		signal: "market_bias",
	},
];

// ─── Signal-to-Number Conversion ─────────────────

/** Convert categorical signal to numeric value [-1, +1] for correlation analysis */
const SIGNAL_NUMERIC: Record<string, number> = {
	// liquidity
	expanding: 1,
	contracting: -1,
	// yield curve
	bear_steepener: 0.8,
	bull_steepener: 0.4,
	bear_flattener: -0.4,
	bull_flattener: -0.8,
	// credit
	risk_on: 1,
	risk_off: -0.5,
	risk_off_confirmed: -0.8,
	risk_off_severe: -1,
	// sentiment
	extreme_greed: 1,
	greed: 0.5,
	fear: -0.5,
	extreme_fear: -1,
	// usd / btc
	bullish: 1,
	bearish: -1,
	bearish_alert: -1,
	// correlation
	synchronized: 1,
	independent: -1,
	// market bias
	// risk_on already defined
	conflicted: -0.3,
	// auction
	healthy: 1,
	weak: -0.5,
	stressed: -1,
	// funding
	calm: 1,
	elevated: 0.5,
	tight: 0,
	// stressed already defined
	crisis: -1,
	// common
	neutral: 0,
};

function signalToNumber(signal: string): number {
	return SIGNAL_NUMERIC[signal] ?? 0;
}

// ─── Structural Redundancy Analysis ──────────────

interface InputOverlap {
	factorA: string;
	factorB: string;
	sharedInputs: string[];
	overlapScore: number; // 0-1, higher = more redundant
}

/**
 * Analyze structural redundancy between factor dimensions.
 * Two dimensions that share raw data inputs are structurally correlated.
 */
export function analyzeStructuralRedundancy(): InputOverlap[] {
	const overlaps: InputOverlap[] = [];

	for (let i = 0; i < FACTOR_DIMENSIONS.length; i++) {
		for (let j = i + 1; j < FACTOR_DIMENSIONS.length; j++) {
			const a = FACTOR_DIMENSIONS[i];
			const b = FACTOR_DIMENSIONS[j];
			const shared = a.sharedInputs.filter((inp) => b.sharedInputs.includes(inp));
			if (shared.length > 0) {
				const totalUnique = new Set([...a.sharedInputs, ...b.sharedInputs]).size;
				overlaps.push({
					factorA: a.name,
					factorB: b.name,
					sharedInputs: shared,
					overlapScore: totalUnique > 0 ? shared.length / totalUnique : 0,
				});
			}
		}
	}

	return overlaps;
}

// ─── Pairwise Signal Correlation ─────────────────

interface FactorCorrelation {
	typeA: string;
	typeB: string;
	correlation: number;
	dataPoints: number;
}

/**
 * Compute pairwise Pearson correlation between analysis signals.
 * Uses categorical signal → numeric conversion.
 * Requires ≥ 10 overlapping dates for meaningful results.
 */
export function computeSignalCorrelations(db: Db): {
	correlations: FactorCorrelation[];
	dataPoints: number;
	sufficient: boolean;
} {
	// Collect all signals by date
	const allRows = db.select().from(analysisResults).orderBy(asc(analysisResults.date)).all();

	const byDate = new Map<string, Map<string, number>>();
	for (const row of allRows) {
		if (row.type === "market_bias") continue; // skip composite
		if (!byDate.has(row.date)) byDate.set(row.date, new Map());
		byDate.get(row.date)!.set(row.type, signalToNumber(row.signal));
	}

	// Get all signal types
	const types = [...new Set(allRows.map((r) => r.type))].filter((t) => t !== "market_bias").sort();

	// Build aligned time series
	const dates = [...byDate.keys()].sort();
	const series: Record<string, number[]> = {};
	for (const t of types) series[t] = [];

	for (const date of dates) {
		const signals = byDate.get(date)!;
		// Only include dates where all signals are present
		if (types.every((t) => signals.has(t))) {
			for (const t of types) {
				series[t].push(signals.get(t)!);
			}
		}
	}

	const n = series[types[0]]?.length ?? 0;
	const sufficient = n >= 10;

	// Compute pairwise correlations
	const correlations: FactorCorrelation[] = [];
	for (let i = 0; i < types.length; i++) {
		for (let j = i + 1; j < types.length; j++) {
			const r = pearson(series[types[i]], series[types[j]]);
			correlations.push({
				typeA: types[i],
				typeB: types[j],
				correlation: r,
				dataPoints: n,
			});
		}
	}

	return { correlations, dataPoints: n, sufficient };
}

function pearson(x: number[], y: number[]): number {
	const n = x.length;
	if (n < 3) return 0;

	let sumX = 0;
	let sumY = 0;
	let sumXY = 0;
	let sumX2 = 0;
	let sumY2 = 0;
	for (let i = 0; i < n; i++) {
		sumX += x[i];
		sumY += y[i];
		sumXY += x[i] * y[i];
		sumX2 += x[i] * x[i];
		sumY2 += y[i] * y[i];
	}

	const denom = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
	if (denom === 0) return 0;
	return (n * sumXY - sumX * sumY) / denom;
}

// ─── Metadata Correlation (continuous values) ────

interface MetadataCorrelation {
	metricA: string;
	metricB: string;
	correlation: number;
	dataPoints: number;
}

/**
 * Compute correlations between continuous metadata values across factors.
 * More informative than categorical signal correlation.
 */
export function computeMetadataCorrelations(db: Db): {
	correlations: MetadataCorrelation[];
	sufficient: boolean;
} {
	// Key continuous metrics per signal type
	const metricMap: Record<string, string> = {
		liquidity_signal: "sofr_iorb_spread_bps",
		funding_stress: "stress_score",
		yield_curve: "spread_10s2s",
		auction_health: "aggregate_health",
		credit_risk: "hyg_ief_ratio",
		sentiment_signal: "composite_score",
		usd_model: "composite_score",
		btc_signal: "price_vs_ma_pct",
	};

	// Build time series from metadata
	const series: Record<string, { dates: string[]; values: number[] }> = {};
	for (const [type, metric] of Object.entries(metricMap)) {
		const rows = db
			.select()
			.from(analysisResults)
			.where(eq(analysisResults.type, type))
			.orderBy(asc(analysisResults.date))
			.all();

		const dates: string[] = [];
		const values: number[] = [];
		for (const row of rows) {
			const meta = (typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata) as Record<
				string,
				unknown
			>;
			const val = meta[metric];
			if (typeof val === "number") {
				dates.push(row.date);
				values.push(val);
			}
		}
		series[`${type}.${metric}`] = { dates, values };
	}

	// Align by date and compute pairwise correlations
	const keys = Object.keys(series);
	const correlations: MetadataCorrelation[] = [];

	for (let i = 0; i < keys.length; i++) {
		for (let j = i + 1; j < keys.length; j++) {
			const a = series[keys[i]];
			const b = series[keys[j]];

			// Find overlapping dates
			const commonDates = a.dates.filter((d) => b.dates.includes(d));
			if (commonDates.length < 3) continue;

			const valsA = commonDates.map((d) => a.values[a.dates.indexOf(d)]);
			const valsB = commonDates.map((d) => b.values[b.dates.indexOf(d)]);

			correlations.push({
				metricA: keys[i],
				metricB: keys[j],
				correlation: pearson(valsA, valsB),
				dataPoints: commonDates.length,
			});
		}
	}

	const minPoints = Math.min(...correlations.map((c) => c.dataPoints), 999);
	return { correlations, sufficient: minPoints >= 10 };
}

// ─── Factor Gap Analysis ─────────────────────────

export interface FactorGap {
	category: string;
	timeScale: string;
	status: "implemented" | "possible" | "blocked";
	description: string;
	difficulty: "easy" | "medium" | "hard";
	dataSource: string;
}

export function identifyFactorGaps(): FactorGap[] {
	return [
		// Mean reversion gaps
		{
			category: "均值回归",
			timeScale: "日频",
			status: "possible",
			description: "SPY/QQQ RSI(14) 超买超卖信号",
			difficulty: "easy",
			dataSource: "已有 hourly_prices 数据",
		},
		{
			category: "均值回归",
			timeScale: "日频",
			status: "possible",
			description: "布林带宽度 + 价格位置（突破回归）",
			difficulty: "easy",
			dataSource: "已有 hourly_prices 数据",
		},
		{
			category: "均值回归",
			timeScale: "日频",
			status: "implemented",
			description: "MVRV < 1 → BTC 低估（链上估值）",
			difficulty: "easy",
			dataSource: "CoinMetrics",
		},
		// Momentum gaps
		{
			category: "动量",
			timeScale: "日频",
			status: "implemented",
			description: "净流动性 7d 方向趋势",
			difficulty: "easy",
			dataSource: "FRED",
		},
		{
			category: "动量",
			timeScale: "日频",
			status: "implemented",
			description: "BTC MA7d 交叉 + 量能",
			difficulty: "easy",
			dataSource: "Binance",
		},
		{
			category: "动量",
			timeScale: "日频",
			status: "possible",
			description: "多资产动量排名（SPY/QQQ/IWM 相对强弱）",
			difficulty: "easy",
			dataSource: "已有 hourly_prices 数据",
		},
		// Structural gaps
		{
			category: "结构性",
			timeScale: "日频",
			status: "implemented",
			description: "SRF 用量 + SOFR-IORB + SOFR99 尾部",
			difficulty: "easy",
			dataSource: "NY Fed + FRED",
		},
		{
			category: "结构性",
			timeScale: "日频",
			status: "implemented",
			description: "拍卖 bid-to-cover + tail + 间接占比",
			difficulty: "easy",
			dataSource: "Treasury API",
		},
		{
			category: "结构性",
			timeScale: "日频",
			status: "possible",
			description: "VIX 期限结构（VIX/VIX3M contango/backwardation）",
			difficulty: "easy",
			dataSource: "FRED: VIXCLS + Yahoo: ^VIX3M",
		},
		{
			category: "结构性",
			timeScale: "日频",
			status: "possible",
			description: "期权 Put/Call 比率（CBOE equity PCR）",
			difficulty: "medium",
			dataSource: "FRED: PCETRIM 或 CBOE 网站",
		},
		// Cross-asset gaps
		{
			category: "跨资产",
			timeScale: "日频",
			status: "implemented",
			description: "BTC-SPX 相关性体制 + 5×5 矩阵",
			difficulty: "easy",
			dataSource: "已有 hourly_prices 数据",
		},
		{
			category: "跨资产",
			timeScale: "日频",
			status: "possible",
			description: "GLD/TLT 比率（通胀 vs 通缩预期）",
			difficulty: "easy",
			dataSource: "Yahoo Finance",
		},
		// Calendar gaps
		{
			category: "日历/季节",
			timeScale: "日频",
			status: "implemented",
			description: "CPI/NFP/FOMC 事件日减仓",
			difficulty: "easy",
			dataSource: "FRED Release Dates",
		},
		{
			category: "日历/季节",
			timeScale: "月频",
			status: "possible",
			description: "月末效应（月末 3 日 vs 其余日回报差异）",
			difficulty: "medium",
			dataSource: "需要历史回测验证",
		},
		{
			category: "日历/季节",
			timeScale: "季频",
			status: "possible",
			description: "季末再平衡效应（养老金/基金季末调仓）",
			difficulty: "medium",
			dataSource: "需要历史回测验证",
		},
		// Microstructure gaps
		{
			category: "微观结构",
			timeScale: "日内",
			status: "blocked",
			description: "Order flow / bid-ask spread",
			difficulty: "hard",
			dataSource: "Alpaca 不提供 L2 数据",
		},
	];
}

/**
 * Format factor gaps into Slack-friendly message for periodic reminder.
 */
export function formatGapReminder(): string {
	const gaps = identifyFactorGaps();
	const possible = gaps.filter((g) => g.status === "possible");
	const easy = possible.filter((g) => g.difficulty === "easy");

	let msg = "*因子空白区域提醒*\n\n";
	msg += `已实现: ${gaps.filter((g) => g.status === "implemented").length} | `;
	msg += `可加入: ${possible.length} (简单: ${easy.length}) | `;
	msg += `受限: ${gaps.filter((g) => g.status === "blocked").length}\n\n`;

	const byCategory = new Map<string, FactorGap[]>();
	for (const g of possible) {
		if (!byCategory.has(g.category)) byCategory.set(g.category, []);
		byCategory.get(g.category)!.push(g);
	}

	for (const [cat, items] of byCategory) {
		msg += `*${cat}*\n`;
		for (const g of items) {
			const diff = g.difficulty === "easy" ? "🟢" : g.difficulty === "medium" ? "🟡" : "🔴";
			msg += `  ${diff} ${g.description} (${g.dataSource})\n`;
		}
		msg += "\n";
	}

	return msg;
}
