#!/usr/bin/env node

import { Command } from "commander";
import { desc, eq } from "drizzle-orm";
import { analyzeAuctionHealth } from "./analyzers/auction-health.js";
import { analyzeBtcSignal } from "./analyzers/btc-signal.js";
import { computeCorrelationMatrix } from "./analyzers/correlation.js";
import { analyzeFundingStress } from "./analyzers/funding-stress.js";
import { analyzeLiquiditySignal } from "./analyzers/liquidity-signal.js";
import { analyzeUsdModel } from "./analyzers/usd-model.js";
import {
	collectCreditSpreads,
	collectEconomicCalendar,
	collectHourlyPrices,
	collectLiquidity,
	collectMacroEvents,
	collectSentiment,
	collectSrfUsage,
	collectTreasuryAuctions,
	collectUsdModelData,
	collectYields,
	getAuctionHistory,
	getLatestMacroEvent,
	getSrfHistory,
	getUpcomingAuctions,
	getUpcomingEvents,
	MACRO_SERIES,
} from "./collectors/index.js";
import { loadConfig } from "./config.js";
import { closeDb, getDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { analysisResults, generatedReports } from "./db/schema.js";
import {
	checkPendingPredictions,
	createPredictionSnapshot,
	formatAccuracyReport,
} from "./executors/accuracy-tracker.js";
import {
	checkStopLoss,
	getLastStopLossEvent,
	getPortfolioHWM,
	getRiskLevel,
	getRiskMultiplier,
	isInStopLossCooldown,
	STOP_LOSS_THRESHOLD,
} from "./executors/risk-manager.js";
import { previewScores, runTradeEngine } from "./executors/trade-engine.js";
import { runAnalysisPipeline } from "./jobs/pipeline.js";
import { getRecentJobRuns } from "./jobs/run-tracker.js";
import { runFullPipeline, startScheduler, stopScheduler } from "./jobs/scheduler.js";
import { streamText } from "./llm.js";
import { createChildLogger, logger } from "./logger.js";
import { generateDailyReport } from "./reporters/pipeline.js";

const log = createChildLogger("cli");

const program = new Command();

program
	.name("macro-sniper")
	.description("Macro liquidity, bond market, and crypto sentiment analysis CLI")
	.version("0.52.10");

// ─── Database init (auto-migrate) ────────────────

function initDb() {
	const config = loadConfig();
	runMigrations(config.DATABASE_PATH);
	return getDb(config.DATABASE_PATH);
}

// ─── collect commands ────────────────────────────

const collect = program.command("collect").description("Collect data from external sources");

collect
	.command("liquidity")
	.description("Collect liquidity data from FRED")
	.action(async () => {
		const config = loadConfig();
		const db = initDb();
		await collectLiquidity(db, config.FRED_API_KEY);
		closeDb();
	});

collect
	.command("bonds")
	.description("Collect bond yield and credit spread data")
	.action(async () => {
		const config = loadConfig();
		const db = initDb();
		await collectYields(db, config.FRED_API_KEY);
		await collectCreditSpreads(db);
		closeDb();
	});

collect
	.command("sentiment")
	.description("Collect sentiment data")
	.action(async () => {
		const config = loadConfig();
		const db = initDb();
		await collectSentiment(db, {
			fredApiKey: config.FRED_API_KEY,
		});
		closeDb();
	});

collect
	.command("fx")
	.description("Collect FX rates and USD model data (DXY, pairs, term premium, BEI)")
	.action(async () => {
		const config = loadConfig();
		const db = initDb();
		await collectUsdModelData(db, config.FRED_API_KEY);
		closeDb();
	});

collect
	.command("hourly")
	.description("Collect hourly OHLCV data (SPY/QQQ/IWM/DXY/BTC) + BTC 24h stats")
	.action(async () => {
		const db = initDb();
		await collectHourlyPrices(db);
		closeDb();
	});

collect
	.command("macro")
	.description("Collect high-impact macro events (CPI, NFP, FOMC, PCE, GDP, etc.)")
	.action(async () => {
		const config = loadConfig();
		const db = initDb();
		await collectMacroEvents(db, config.FRED_API_KEY);
		closeDb();
	});

collect
	.command("calendar")
	.description("Collect economic calendar (FRED release dates)")
	.action(async () => {
		const config = loadConfig();
		const db = initDb();
		await collectEconomicCalendar(db, config.FRED_API_KEY);
		closeDb();
	});

collect
	.command("srf")
	.description("Collect Fed Standing Repo Facility (SRF) daily usage from NY Fed")
	.action(async () => {
		const db = initDb();
		await collectSrfUsage(db);
		closeDb();
	});

collect
	.command("auction")
	.description("Collect US Treasury auction results (Notes/Bonds)")
	.action(async () => {
		const db = initDb();
		await collectTreasuryAuctions(db);
		closeDb();
	});

collect
	.command("all")
	.description("Collect all data sources")
	.action(async () => {
		const config = loadConfig();
		const db = initDb();
		await collectLiquidity(db, config.FRED_API_KEY);
		await collectYields(db, config.FRED_API_KEY);
		await collectCreditSpreads(db);
		await collectSentiment(db, { fredApiKey: config.FRED_API_KEY });
		await collectUsdModelData(db, config.FRED_API_KEY);
		await collectHourlyPrices(db);
		await collectMacroEvents(db, config.FRED_API_KEY);
		await collectEconomicCalendar(db, config.FRED_API_KEY);
		await collectTreasuryAuctions(db);
		await collectSrfUsage(db);
		closeDb();
	});

// ─── analyze commands ────────────────────────────

const analyze = program.command("analyze").description("Run analysis engines");

analyze
	.command("all")
	.description("Run all analysis engines")
	.action(() => {
		const db = initDb();
		const today = new Date().toISOString().split("T")[0];
		runAnalysisPipeline(db, today);
		closeDb();
	});

analyze
	.command("liquidity")
	.description("Analyze liquidity signal only")
	.action(() => {
		const db = initDb();
		const today = new Date().toISOString().split("T")[0];
		analyzeLiquiditySignal(db, today);
		closeDb();
	});

analyze
	.command("usd")
	.description("Analyze USD model only")
	.action(() => {
		const db = initDb();
		const today = new Date().toISOString().split("T")[0];
		analyzeUsdModel(db, today);
		closeDb();
	});

analyze
	.command("auction")
	.description("Analyze Treasury auction health")
	.action(() => {
		const db = initDb();
		const today = new Date().toISOString().split("T")[0];
		analyzeAuctionHealth(db, today);

		const row = db
			.select()
			.from(analysisResults)
			.where(eq(analysisResults.type, "auction_health"))
			.orderBy(desc(analysisResults.date))
			.limit(1)
			.all()[0];

		if (row) {
			const meta = (typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata) as {
				auctions: {
					term: string;
					auctionDate: string;
					healthScore: number;
					bidToCover: number | null;
					indirectPct: number | null;
					dealerPct: number | null;
					tailBps: number | null;
					highYield: number | null;
				}[];
				aggregate_health: number;
				short_end_health: number;
				long_end_health: number;
				term_premium_signal: number;
				avg_tail_bps: number | null;
			};

			console.log(`\nSignal: ${row.signal.toUpperCase()}`);
			console.log(`Aggregate Health: ${meta.aggregate_health.toFixed(1)}/100`);
			console.log(`Short End: ${meta.short_end_health.toFixed(1)}  Long End: ${meta.long_end_health.toFixed(1)}`);
			console.log(
				`Term Premium Signal: ${meta.term_premium_signal > 0 ? "+" : ""}${meta.term_premium_signal.toFixed(1)} (positive = long end weaker)`,
			);
			console.log(`Avg Tail: ${meta.avg_tail_bps !== null ? `${meta.avg_tail_bps.toFixed(1)} bps` : "n/a"}`);

			console.log("\n── Per-Term Detail ──\n");
			console.log("  Term          Date        Health  B/C   Indirect  Dealer   Yield    Tail");
			console.log(`  ${"─".repeat(78)}`);
			for (const a of meta.auctions) {
				const health = a.healthScore.toFixed(0).padStart(4);
				const btc = a.bidToCover?.toFixed(2) ?? "n/a";
				const ind = a.indirectPct !== null ? `${a.indirectPct.toFixed(1)}%` : "n/a";
				const dlr = a.dealerPct !== null ? `${a.dealerPct.toFixed(1)}%` : "n/a";
				const yld = a.highYield !== null ? `${a.highYield.toFixed(3)}%` : "n/a";
				const tail = a.tailBps !== null ? `${a.tailBps >= 0 ? "+" : ""}${a.tailBps.toFixed(1)}bp` : "n/a";
				console.log(
					`  ${a.term.padEnd(14)} ${a.auctionDate}  ${health}    ${btc.padStart(5)}  ${ind.padStart(8)}  ${dlr.padStart(6)}  ${yld.padStart(7)}  ${tail.padStart(7)}`,
				);
			}
		}
		closeDb();
	});

analyze
	.command("btc")
	.description("Analyze BTC signal (MA7d, volume, sharp drop alert)")
	.action(() => {
		const db = initDb();
		const today = new Date().toISOString().split("T")[0];
		analyzeBtcSignal(db, today);
		closeDb();
	});

analyze
	.command("funding")
	.description("Analyze funding stress (SRF + SOFR-IORB + SOFR tail)")
	.action(() => {
		const db = initDb();
		const today = new Date().toISOString().split("T")[0];
		analyzeFundingStress(db, today);

		const row = db
			.select()
			.from(analysisResults)
			.where(eq(analysisResults.type, "funding_stress"))
			.orderBy(desc(analysisResults.date))
			.limit(1)
			.all()[0];

		if (row) {
			const meta = (typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata) as {
				stress_score: number;
				pillar_srf: number;
				pillar_sofr_iorb: number;
				pillar_sofr_tail: number;
				srf_accepted_bn: number;
				srf_5d_avg_bn: number;
				srf_consecutive_days: number;
				srf_date: string | null;
				sofr: number;
				iorb: number;
				sofr_iorb_spread_bps: number;
				sofr99: number | null;
				sofr99_iorb_bps: number;
				sofr_5d_trend_bps: number;
			};

			console.log(`\nSignal: ${row.signal.toUpperCase()}`);
			console.log(`Stress Score: ${meta.stress_score.toFixed(1)}/100`);
			console.log("\n── Pillar Scores ──\n");
			console.log(`  SRF Usage:      ${meta.pillar_srf.toFixed(1)}/100`);
			console.log(`  SOFR−IORB:      ${meta.pillar_sofr_iorb.toFixed(1)}/100`);
			console.log(`  SOFR Tail:      ${meta.pillar_sofr_tail.toFixed(1)}/100`);
			console.log("\n── Raw Data ──\n");
			console.log(`  SRF Take-up:    $${meta.srf_accepted_bn.toFixed(2)}B (date: ${meta.srf_date ?? "n/a"})`);
			console.log(`  SRF 5d Avg:     $${meta.srf_5d_avg_bn.toFixed(2)}B`);
			console.log(`  SRF Consec Days: ${meta.srf_consecutive_days}`);
			console.log(`  SOFR:           ${meta.sofr.toFixed(2)}%`);
			console.log(`  IORB:           ${meta.iorb.toFixed(2)}%`);
			console.log(
				`  SOFR−IORB:      ${meta.sofr_iorb_spread_bps >= 0 ? "+" : ""}${meta.sofr_iorb_spread_bps.toFixed(1)} bps`,
			);
			console.log(`  SOFR 99th:      ${meta.sofr99?.toFixed(2) ?? "n/a"}%`);
			console.log(`  SOFR99−IORB:    +${meta.sofr99_iorb_bps.toFixed(1)} bps`);
			console.log(
				`  SOFR 5d Trend:  ${meta.sofr_5d_trend_bps >= 0 ? "+" : ""}${meta.sofr_5d_trend_bps.toFixed(1)} bps`,
			);
		}
		closeDb();
	});

analyze
	.command("correlation")
	.description("Compute rolling correlation matrix (7d hourly + 30d daily)")
	.action(() => {
		const db = initDb();
		const today = new Date().toISOString().split("T")[0];
		computeCorrelationMatrix(db, today);
		closeDb();
	});

// Default: analyze all
analyze.action(() => {
	const db = initDb();
	const today = new Date().toISOString().split("T")[0];
	runAnalysisPipeline(db, today);
	closeDb();
});

// ─── data query commands ─────────────────────────

program
	.command("liquidity")
	.description("View latest liquidity data and signal")
	.action(() => {
		const db = initDb();
		const rows = db
			.select()
			.from(analysisResults)
			.where(eq(analysisResults.type, "liquidity_signal"))
			.orderBy(desc(analysisResults.createdAt))
			.limit(1)
			.all();

		if (rows.length === 0) {
			console.log("No liquidity analysis found. Run: macro-sniper collect liquidity && macro-sniper analyze");
		} else {
			const row = rows[0];
			console.log(`Date: ${row.date}`);
			console.log(`Signal: ${row.signal}`);
			console.log("Metadata:", JSON.stringify(row.metadata, null, 2));
		}
		closeDb();
	});

program
	.command("bonds")
	.description("View bond market data")
	.command("regime")
	.description("View current yield curve regime")
	.action(() => {
		const db = initDb();
		const rows = db
			.select()
			.from(analysisResults)
			.where(eq(analysisResults.type, "yield_curve"))
			.orderBy(desc(analysisResults.createdAt))
			.limit(1)
			.all();

		if (rows.length === 0) {
			console.log("No yield curve analysis found. Run: macro-sniper collect bonds && macro-sniper analyze");
		} else {
			const row = rows[0];
			console.log(`Date: ${row.date}`);
			console.log(`Curve Regime: ${row.signal}`);
			console.log("Metadata:", JSON.stringify(row.metadata, null, 2));
		}
		closeDb();
	});

program
	.command("sentiment")
	.description("View latest sentiment data")
	.action(() => {
		const db = initDb();
		const rows = db
			.select()
			.from(analysisResults)
			.where(eq(analysisResults.type, "sentiment_signal"))
			.orderBy(desc(analysisResults.createdAt))
			.limit(1)
			.all();

		if (rows.length === 0) {
			console.log("No sentiment analysis found. Run: macro-sniper collect sentiment && macro-sniper analyze");
		} else {
			const row = rows[0];
			console.log(`Date: ${row.date}`);
			console.log(`Signal: ${row.signal}`);
			console.log("Metadata:", JSON.stringify(row.metadata, null, 2));
		}
		closeDb();
	});

program
	.command("usd")
	.description("View latest USD model analysis")
	.action(() => {
		const db = initDb();
		const rows = db
			.select()
			.from(analysisResults)
			.where(eq(analysisResults.type, "usd_model"))
			.orderBy(desc(analysisResults.createdAt))
			.limit(1)
			.all();

		if (rows.length === 0) {
			console.log("No USD model analysis found. Run: macro-sniper collect fx && macro-sniper analyze usd");
		} else {
			const row = rows[0];
			console.log(`Date: ${row.date}`);
			console.log(`Signal: ${row.signal}`);
			console.log("Metadata:", JSON.stringify(row.metadata, null, 2));
		}
		closeDb();
	});

program
	.command("btc")
	.description("View latest BTC signal (4-pillar: technicals + derivatives + on-chain + ETF)")
	.action(() => {
		const db = initDb();
		const rows = db
			.select()
			.from(analysisResults)
			.where(eq(analysisResults.type, "btc_signal"))
			.orderBy(desc(analysisResults.createdAt))
			.limit(1)
			.all();

		if (rows.length === 0) {
			console.log("No BTC signal found. Run: macro-sniper collect sentiment && macro-sniper analyze btc");
		} else {
			const row = rows[0];
			const meta = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
			console.log(`Date: ${row.date}`);
			console.log(`Signal: ${row.signal}`);
			console.log(`\n── Pillar Scores ──`);
			console.log(`  Technicals:  ${meta.technicals_score?.toFixed(1) ?? "n/a"}/100  (wt=30%)`);
			console.log(`  Derivatives: ${meta.derivatives_score?.toFixed(1) ?? "n/a"}/100  (wt=30%)`);
			console.log(`  On-chain:    ${meta.onchain_score?.toFixed(1) ?? "n/a"}/100  (wt=20%)`);
			console.log(`  ETF Flow:    ${meta.etf_flow_score?.toFixed(1) ?? "n/a"}/100  (wt=20%)`);
			console.log(`  Composite:   ${meta.composite_score?.toFixed(1) ?? "n/a"}/100`);
			console.log(`\n── Technicals ──`);
			console.log(`  Price:     $${meta.btc_price?.toFixed(0)}`);
			console.log(`  MA7d:      $${meta.ma7d?.toFixed(0)}  (${meta.above_ma7d ? "above" : "below"})`);
			console.log(`  Change24h: ${meta.change_pct_24h?.toFixed(2)}%`);
			console.log(
				`  Volume:    ratio=${meta.volume_ratio?.toFixed(2)}  ${meta.volume_expanding ? "EXPANDING" : ""}`,
			);
			console.log(`\n── Derivatives ──`);
			console.log(
				`  Funding:     ${meta.funding_rate !== null ? `${(meta.funding_rate * 100).toFixed(4)}%` : "n/a"}`,
			);
			console.log(`  L/S Ratio:   ${meta.long_short_ratio?.toFixed(4) ?? "n/a"}`);
			console.log(`  Taker B/S:   ${meta.taker_buy_sell_ratio?.toFixed(4) ?? "n/a"}`);
			console.log(
				`  OI 7d Chg:   ${meta.oi_change_7d !== null ? `${(meta.oi_change_7d * 100).toFixed(2)}%` : "n/a"}`,
			);
			console.log(`\n── On-chain ──`);
			console.log(`  MVRV:        ${meta.mvrv?.toFixed(4) ?? "n/a"}`);
			console.log(`  Net Ex Flow: ${meta.net_exchange_flow?.toFixed(2) ?? "n/a"} BTC`);
			console.log(`  Active Addr: ${meta.active_addresses?.toFixed(0) ?? "n/a"}`);
			console.log(`\n── ETF Divergence ──`);
			console.log(
				`  Dollar Vol:  $${meta.etf_dollar_volume ? `${(meta.etf_dollar_volume / 1e6).toFixed(0)}M` : "n/a"}`,
			);
			console.log(`  Vol Ratio:   ${meta.etf_volume_ratio?.toFixed(2) ?? "n/a"}`);
			console.log(`  Divergence:  ${meta.etf_divergence_type ?? "n/a"}`);
			console.log(`\n  Equity Modifier: ${meta.equity_score_modifier}`);
			if (meta.stale_sources?.length > 0) {
				console.log(`  Stale: ${meta.stale_sources.join(", ")}`);
			}
		}
		closeDb();
	});

// ─── macro commands ──────────────────────────────

program
	.command("macro")
	.description("Display latest macro event data and upcoming calendar")
	.action(() => {
		const db = initDb();

		console.log("\n══ Latest Macro Events ══\n");
		for (const series of MACRO_SERIES) {
			const event = getLatestMacroEvent(db, series.eventType);
			if (event) {
				const mom =
					event.momChange !== null
						? `MoM=${event.momChange >= 0 ? "+" : ""}${event.momChange.toFixed(2)}${series.eventType === "nfp" ? "K" : "%"}`
						: "";
				const yoy =
					event.yoyChange !== null
						? `YoY=${event.yoyChange >= 0 ? "+" : ""}${event.yoyChange.toFixed(2)}${series.eventType === "nfp" ? "K" : "%"}`
						: "";
				const impact = series.impact === "high" ? "★★★" : "★★";
				console.log(
					`  ${impact} ${series.name.padEnd(30)} ${event.releaseDate}  val=${event.value.toFixed(series.eventType === "unemployment" || series.eventType === "fomc" ? 2 : 1)}  ${mom}  ${yoy}`,
				);
			} else {
				console.log(`  ${"   "} ${series.name.padEnd(30)} (no data)`);
			}
		}

		console.log("\n══ Upcoming Events (7 days) ══\n");
		const upcoming = getUpcomingEvents(db, 7);
		if (upcoming.length === 0) {
			console.log("  No upcoming events in the next 7 days");
		} else {
			const seen = new Set<string>();
			for (const ev of upcoming) {
				// Dedup: same date + same release often has multiple event types (CPI + Core CPI)
				const key = `${ev.releaseDate}:${ev.fredReleaseId}`;
				if (seen.has(key)) continue;
				seen.add(key);
				const impact = ev.impact === "high" ? "★★★" : "★★";
				const types = upcoming
					.filter((e) => e.releaseDate === ev.releaseDate && e.fredReleaseId === ev.fredReleaseId)
					.map((e) => e.eventType)
					.join(", ");
				console.log(`  ${ev.releaseDate} ${ev.releaseTime ?? "??:??"} ET  ${impact} ${ev.releaseName} [${types}]`);
			}
		}
		console.log("");

		closeDb();
	});

// ─── factors commands ─────────────────────────────

import {
	analyzeStructuralRedundancy,
	computeMetadataCorrelations,
	computeSignalCorrelations,
	FACTOR_DIMENSIONS,
	identifyFactorGaps,
	META_FACTORS,
} from "./analyzers/factor-analysis.js";

const factors = program.command("factors").description("Factor analysis and orthogonality tools");

factors
	.command("dimensions")
	.description("Show factor dimension classification (6 independent + 2 meta)")
	.action(() => {
		console.log("\n══ 因子维度分类（6 个独立维度 + 2 个元因子） ══\n");
		for (const dim of FACTOR_DIMENSIONS) {
			console.log(`  ${dim.name}`);
			console.log(`    问题: ${dim.question}`);
			console.log(`    信号: ${dim.signals.join(", ")}`);
			console.log(`    主要指标: ${dim.primaryMetric}`);
			if (dim.sharedInputs.length > 0) {
				console.log(`    共享输入: ${dim.sharedInputs.join(", ")}`);
			}
			console.log();
		}
		console.log("  ── 元因子 ──\n");
		for (const mf of META_FACTORS) {
			console.log(`  ${mf.name}: ${mf.question} → ${mf.signal}`);
		}
		console.log();
	});

factors
	.command("redundancy")
	.description("Analyze structural and statistical factor redundancy")
	.action(() => {
		const db = getDb();
		runMigrations();

		// Structural redundancy
		console.log("\n══ 结构冗余分析（共享输入数据源） ══\n");
		const overlaps = analyzeStructuralRedundancy();
		if (overlaps.length === 0) {
			console.log("  无结构冗余（各维度输入完全独立）");
		} else {
			for (const o of overlaps) {
				const pct = (o.overlapScore * 100).toFixed(0);
				console.log(`  ${o.factorA} ↔ ${o.factorB}`);
				console.log(`    共享: ${o.sharedInputs.join(", ")} (重叠度 ${pct}%)`);
				console.log();
			}
		}

		// Signal correlation
		console.log("══ 信号方向相关性（分类信号 → 数值） ══\n");
		const { correlations: sigCorr, dataPoints, sufficient } = computeSignalCorrelations(db);
		if (!sufficient) {
			console.log(`  数据不足: ${dataPoints} 天 (需要 ≥ 10 天)\n`);
		}
		if (sigCorr.length > 0) {
			const sorted = sigCorr.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
			console.log("  因子 A              因子 B              相关系数  判定");
			console.log(`  ${"─".repeat(70)}`);
			for (const c of sorted) {
				const r = c.correlation;
				const abs = Math.abs(r);
				let verdict = "";
				if (abs > 0.7) verdict = "⚠️  高度冗余 — 应合并";
				else if (abs > 0.4) verdict = "⚡ 中度相关 — 降权";
				else verdict = "✅ 独立";
				console.log(
					`  ${c.typeA.padEnd(20)} ${c.typeB.padEnd(20)} ${r >= 0 ? "+" : ""}${r.toFixed(3)}    ${verdict}`,
				);
			}
			console.log(`\n  数据点: ${dataPoints} 天 ${sufficient ? "" : "(不足，仅供参考)"}`);
		}

		// Metadata correlation
		console.log("\n══ 连续指标相关性（metadata 数值） ══\n");
		const { correlations: metaCorr, sufficient: metaSuf } = computeMetadataCorrelations(db);
		if (metaCorr.length > 0) {
			const sorted = metaCorr.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
			for (const c of sorted.slice(0, 15)) {
				const r = c.correlation;
				const abs = Math.abs(r);
				const tag = abs > 0.7 ? "⚠️" : abs > 0.4 ? "⚡" : "✅";
				console.log(
					`  ${tag} ${c.metricA.padEnd(35)} ↔ ${c.metricB.padEnd(35)} r=${r >= 0 ? "+" : ""}${r.toFixed(3)} (n=${c.dataPoints})`,
				);
			}
			console.log(`\n  统计显著性: ${metaSuf ? "足够" : "不足（仅供参考）"}`);
		} else {
			console.log("  数据不足");
		}
		console.log();

		closeDb();
	});

factors
	.command("gaps")
	.description("Show factor gap analysis — what factors could be added")
	.action(() => {
		const gaps = identifyFactorGaps();

		console.log("\n══ 因子空白区域分析 ══\n");

		const categories = [...new Set(gaps.map((g) => g.category))];
		for (const cat of categories) {
			console.log(`  ── ${cat} ──\n`);
			const catGaps = gaps.filter((g) => g.category === cat);
			for (const g of catGaps) {
				const icon = g.status === "implemented" ? "✅" : g.status === "possible" ? "🔲" : "🚫";
				const diff = g.difficulty === "easy" ? "简单" : g.difficulty === "medium" ? "中等" : "困难";
				console.log(`    ${icon} [${diff}] ${g.description}`);
				if (g.status !== "implemented") {
					console.log(`       数据源: ${g.dataSource}`);
				}
			}
			console.log();
		}

		const possible = gaps.filter((g) => g.status === "possible");
		const easy = possible.filter((g) => g.difficulty === "easy");
		console.log(
			`  总计: ${gaps.filter((g) => g.status === "implemented").length} 已实现 | ${possible.length} 可加入 (${easy.length} 简单) | ${gaps.filter((g) => g.status === "blocked").length} 受限`,
		);
		console.log();
	});

// ─── srf command ─────────────────────────────────

program
	.command("srf")
	.description("Display SRF (Standing Repo Facility) usage history")
	.action(() => {
		const db = initDb();
		const history = getSrfHistory(db, 30);

		if (history.length === 0) {
			console.log("No SRF data. Run: macro-sniper collect srf");
			closeDb();
			return;
		}

		console.log("\n══ SRF Daily Usage (last 30d) ══\n");
		console.log("  Date        Take-up         Bar");
		console.log(`  ${"─".repeat(60)}`);

		// Show oldest first
		for (const row of [...history].reverse()) {
			const bn = row.totalAccepted / 1e9;
			const label = bn >= 0.01 ? `$${bn.toFixed(2)}B` : "$0";
			const bar = bn > 0.01 ? "█".repeat(Math.min(40, Math.ceil(bn / 0.5))) : "";
			console.log(`  ${row.operationDate}  ${label.padStart(12)}  ${bar}`);
		}

		// Summary
		const total = history.reduce((s, r) => s + r.totalAccepted, 0) / 1e9;
		const max = Math.max(...history.map((r) => r.totalAccepted)) / 1e9;
		const nonZeroDays = history.filter((r) => r.totalAccepted > 100_000_000).length;
		console.log(`\n  Total: $${total.toFixed(2)}B across ${history.length} days`);
		console.log(`  Peak: $${max.toFixed(2)}B | Days with usage: ${nonZeroDays}`);
		console.log("");

		closeDb();
	});

// ─── auction command ─────────────────────────────

program
	.command("auction")
	.description("Display Treasury auction results and upcoming auctions")
	.action(() => {
		const db = initDb();

		const terms = ["2-Year", "3-Year", "5-Year", "7-Year", "10-Year", "20-Year", "30-Year"];

		console.log("\n══ Latest Treasury Auction Results ══\n");
		console.log("  Term          Date        Yield   Bid/Cover  Indirect  Direct   Dealer   Offering");
		console.log("  " + "─".repeat(85));

		for (const term of terms) {
			const history = getAuctionHistory(db, term, 2);
			for (const a of history) {
				const yld = a.highYield !== null ? `${a.highYield.toFixed(3)}%` : "pending";
				const btc = a.bidToCoverRatio !== null ? a.bidToCoverRatio.toFixed(2) : "n/a";
				const ind = a.indirectPct !== null ? `${a.indirectPct.toFixed(1)}%` : "n/a";
				const dir = a.directPct !== null ? `${a.directPct.toFixed(1)}%` : "n/a";
				const dlr = a.primaryDealerPct !== null ? `${a.primaryDealerPct.toFixed(1)}%` : "n/a";
				const off = `$${(a.offeringAmt / 1e9).toFixed(0)}B`;
				console.log(
					`  ${a.securityTerm.padEnd(14)} ${a.auctionDate}  ${yld.padStart(7)}  ${btc.padStart(9)}  ${ind.padStart(8)}  ${dir.padStart(6)}  ${dlr.padStart(6)}   ${off}`,
				);
			}
		}

		console.log("\n══ Upcoming Auctions ══\n");
		const upcoming = getUpcomingAuctions(db);
		if (upcoming.length === 0) {
			console.log("  No upcoming auctions");
		} else {
			for (const a of upcoming) {
				const off = `$${(a.offeringAmt / 1e9).toFixed(0)}B`;
				console.log(
					`  ${a.auctionDate} ${a.closingTime ?? "13:00"} ET  ${a.securityTerm} ${a.securityType}  ${off}`,
				);
			}
		}
		console.log("");

		closeDb();
	});

// ─── report commands ─────────────────────────────

const report = program.command("report").description("Daily report operations");

report
	.command("today")
	.description("View today's report")
	.action(() => {
		logger.level = "silent";
		const db = initDb();
		const today = new Date().toISOString().split("T")[0];
		const rows = db
			.select()
			.from(generatedReports)
			.where(eq(generatedReports.date, today))
			.orderBy(desc(generatedReports.createdAt))
			.limit(1)
			.all();

		if (rows.length === 0) {
			console.log("No report found for today. Run: macro-sniper report generate");
		} else {
			console.log(rows[0].content);
		}
		closeDb();
	});

report
	.command("generate")
	.description("Generate daily report now")
	.action(async () => {
		const config = loadConfig();
		const db = initDb();
		const today = new Date().toISOString().split("T")[0];
		const content = await generateDailyReport(db, today, streamText, config.LLM_MODEL_FAST);
		console.log(content);
		closeDb();
	});

// ─── run (full pipeline) ─────────────────────────

program
	.command("run")
	.description("Run full pipeline: collect → analyze → report → notify")
	.action(async () => {
		initDb();
		await runFullPipeline(streamText);
		closeDb();
	});

// ─── jobs commands ───────────────────────────────

const jobs = program.command("jobs").description("Cron job management");

jobs
	.command("start")
	.description("Start cron scheduler (foreground)")
	.action(() => {
		initDb();
		startScheduler(streamText);
		log.info("Scheduler running. Press Ctrl+C to stop.");

		// Keep process alive
		process.on("SIGINT", () => {
			stopScheduler();
			closeDb();
			process.exit(0);
		});
		process.on("SIGTERM", () => {
			stopScheduler();
			closeDb();
			process.exit(0);
		});
	});

jobs
	.command("status")
	.description("View recent job runs")
	.action(() => {
		const db = initDb();
		for (const jobName of ["collect", "analyze", "report", "notify"]) {
			const runs = getRecentJobRuns(db, jobName, 5);
			if (runs.length > 0) {
				console.log(`\n── ${jobName} ──`);
				for (const run of runs) {
					const duration = run.durationMs ? `${run.durationMs}ms` : "n/a";
					console.log(`  ${run.startedAt} | ${run.status} | ${duration}${run.error ? ` | ${run.error}` : ""}`);
				}
			}
		}
		closeDb();
	});

jobs
	.command("stop")
	.description("Stop scheduler (sends SIGTERM)")
	.action(() => {
		// This command would need to find and signal the running process.
		// For now, just stop in-process.
		stopScheduler();
		console.log("Scheduler stop signal sent.");
	});

// ─── db commands ─────────────────────────────────

program
	.command("db:migrate")
	.description("Run database migrations")
	.action(() => {
		initDb();
		console.log("Database migrated successfully.");
		closeDb();
	});

// ─── trade commands ──────────────────────────────

const trade = program.command("trade").description("Paper trading execution");

trade
	.command("preview")
	.description("Preview signal scores without executing trades")
	.action(() => {
		const db = initDb();
		const scores = previewScores(db);
		const {
			SPY,
			QQQ,
			IWM,
			BTCUSD,
			UUP,
			inflationRegime,
			marketBias,
			marketBiasConfidence,
			riskLevel,
			riskMultiplier,
			atrInfo,
			kellyFraction,
		} = scores;
		console.log(`\n── Market Context ──`);
		console.log(`  Bias:      ${marketBias} (${marketBiasConfidence})`);
		console.log(
			`  Inflation: ${inflationRegime.regime} | BEI10y=${inflationRegime.bei10y.toFixed(2)}% | GLD5d=${inflationRegime.gld5dMomentum.toFixed(2)}% | GLD20d=${inflationRegime.gld20dTrend.toFixed(2)}%`,
		);
		console.log(`  Risk:      ${riskLevel} (×${riskMultiplier})`);
		if (kellyFraction !== null) console.log(`  Kelly:     1/4 f* = ${(kellyFraction * 100).toFixed(1)}%`);
		console.log(`\n── ATR (14d) ──`);
		for (const [sym, info] of Object.entries(atrInfo)) {
			console.log(`  ${sym.padEnd(8)} ATR=${info.atrPct.toFixed(2)}%  stop=${info.stopPct.toFixed(2)}%`);
		}
		console.log(`\n── Instrument Scores ──`);
		for (const s of [SPY, QQQ, IWM, BTCUSD, UUP]) {
			const creditTag = s.creditVeto
				? " [CREDIT_SEVERE]"
				: s.creditMultiplier < 1.0
					? ` [CREDIT×${s.creditMultiplier.toFixed(1)}]`
					: "";
			const veto = creditTag || (s.btcSyncVeto ? " [BTC_SYNC_VETO]" : "");
			console.log(
				`  ${s.symbol.padEnd(8)} score=${s.finalScore.toFixed(1).padStart(7)}  ${s.direction.padEnd(5)}  ${(s.sizeMultiplier * 100).toFixed(0).padStart(3)}%  $${s.notionalFinal.toFixed(0).padStart(6)}${veto}`,
			);
			console.log(
				`           liq=${s.evidence.liquidity.contribution.toFixed(1)} curve=${s.evidence.yieldCurve.contribution.toFixed(1)} sent=${s.evidence.sentiment.contribution.toFixed(1)} usd=${s.evidence.usdModel.contribution.toFixed(1)} btcmod=${s.evidence.btcEquityModifier}`,
			);
			if (s.evidence.rotationNote !== "n/a for BTC") console.log(`           rotation: ${s.evidence.rotationNote}`);
			if (s.evidence.conflictNote) console.log(`           conflict: ${s.evidence.conflictNote}`);
			if (s.evidence.corrRegimeNote) console.log(`           corr: ${s.evidence.corrRegimeNote}`);
		}
		closeDb();
	});

trade
	.command("run")
	.description("Execute trades based on current signals")
	.action(async () => {
		const db = initDb();
		const result = await runTradeEngine(db);
		console.log(`\n── Trade Execution ──`);
		console.log(`  Market open: ${result.marketOpen}`);
		console.log(`  ${result.summary}`);
		console.log(`\n── Decisions ──`);
		for (const d of result.decisions) {
			console.log(
				`  ${d.symbol.padEnd(8)} ${d.action.padEnd(12)} ${d.currentDirection} → ${d.targetDirection}  $${d.targetNotional.toFixed(0)}`,
			);
			console.log(`           ${d.reason}`);
		}
		console.log(`\n── Orders ──`);
		for (const o of result.orders) {
			if (o.status !== "skipped") {
				console.log(
					`  ${o.symbol.padEnd(8)} ${o.side}  status=${o.status}  orderId=${o.alpacaOrderId ?? "n/a"}${o.error ? `  error=${o.error}` : ""}`,
				);
			}
		}
		closeDb();
	});

// ─── risk commands ────────────────────────────────

import { checkBtcCrashLinkage } from "./executors/risk-manager.js";

const risk = program.command("risk").description("Risk management (L1-L4)");

risk
	.command("check")
	.description("Manually run L1 stop-loss check on all open positions")
	.action(async () => {
		const db = initDb();
		const result = await checkStopLoss(db);
		if (!result.triggered) {
			console.log(`No stop-loss breaches (threshold: ${(STOP_LOSS_THRESHOLD * 100).toFixed(0)}%).`);
		} else {
			console.log(`\n── L1 Stop-Loss Events ──`);
			for (const e of result.events) {
				const pct = (e.pnlPct * 100).toFixed(2);
				console.log(
					`  ${e.symbol.padEnd(8)} pnl=${pct}%  qty=${e.qty.toFixed(4)}  price=$${e.price.toFixed(2)}  closed=${e.closed}${e.error ? `  error=${e.error}` : ""}`,
				);
			}
		}
		closeDb();
	});

risk
	.command("btc-crash")
	.description("Manually check L4 BTC crash linkage (-5% 24h → reduce equity 20%)")
	.action(async () => {
		const db = initDb();
		const result = await checkBtcCrashLinkage(db);
		console.log(
			`BTC 24h return: ${result.btcReturn24h !== null ? `${(result.btcReturn24h * 100).toFixed(2)}%` : "n/a"}`,
		);
		if (!result.triggered) {
			console.log("No BTC crash linkage triggered.");
		} else {
			console.log(`\n── L4 BTC Crash Linkage ──`);
			for (const r of result.reductions) {
				console.log(`  ${r.symbol.padEnd(8)} ${r.oldQty} → ${r.newQty}${r.error ? `  error=${r.error}` : ""}`);
			}
		}
		closeDb();
	});

risk
	.command("status")
	.description("Show risk event history and current cooldown status")
	.action(() => {
		const db = initDb();
		const symbols = ["SPY", "QQQ", "IWM", "BTCUSD", "UUP"];
		console.log(`\n── Risk Status (L1 threshold: ${(STOP_LOSS_THRESHOLD * 100).toFixed(0)}%) ──`);
		for (const sym of symbols) {
			const inCooldown = isInStopLossCooldown(db, sym);
			const lastEvent = getLastStopLossEvent(db, sym);
			if (lastEvent) {
				const pct = (lastEvent.triggerValue * 100).toFixed(2);
				const cooldownStr =
					inCooldown && lastEvent.cooldownUntil
						? `cooldown until ${new Date(lastEvent.cooldownUntil).toLocaleString("zh-CN", { timeZone: "America/New_York", hour12: false })}`
						: "no cooldown";
				console.log(
					`  ${sym.padEnd(8)} last stop-loss: ${pct}% on ${lastEvent.createdAt.slice(0, 16)}  ${cooldownStr}`,
				);
			} else {
				console.log(`  ${sym.padEnd(8)} no stop-loss events`);
			}
		}

		// Drawdown tier info
		const riskLevel = getRiskLevel(db);
		const riskMult = getRiskMultiplier(db);
		const hwm = getPortfolioHWM(db);
		console.log(`\n── Drawdown Tier ──`);
		console.log(`  Level:      ${riskLevel} (multiplier: ${riskMult})`);
		console.log(`  Portfolio HWM: $${hwm.toFixed(2)}`);
		closeDb();
	});

// ─── accuracy commands ────────────────────────────

const accuracy = program.command("accuracy").description("Prediction accuracy tracking");

accuracy
	.command("report")
	.description("Show prediction accuracy report with optimization hints")
	.action(() => {
		const db = initDb();
		console.log(formatAccuracyReport(db));
		closeDb();
	});

accuracy
	.command("check")
	.description("Manually trigger T+5 accuracy evaluation for pending predictions")
	.action(() => {
		const db = initDb();
		checkPendingPredictions(db);
		console.log("Accuracy check complete.");
		closeDb();
	});

accuracy
	.command("snapshot")
	.description("Manually create a prediction snapshot for today")
	.action(() => {
		const db = initDb();
		const today = new Date().toISOString().split("T")[0];
		createPredictionSnapshot(db, today);
		console.log(`Snapshot created for ${today}.`);
		closeDb();
	});

// ─── portfolio commands ───────────────────────────

const portfolio = program.command("portfolio").description("Paper trading portfolio management");

portfolio
	.command("status")
	.description("Show current positions and account summary")
	.action(async () => {
		const { getPortfolioSummary } = await import("./broker/alpaca.js");
		const summary = await getPortfolioSummary();
		console.log("\n── Account ──");
		console.log(`  Equity:        $${summary.equity.toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
		console.log(`  Cash:          $${summary.cash.toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
		console.log(`  Buying Power:  $${summary.buyingPower.toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
		const pnlSign = summary.totalUnrealizedPnl >= 0 ? "+" : "";
		console.log(`  Unrealized P&L: ${pnlSign}$${summary.totalUnrealizedPnl.toFixed(2)}`);

		if (summary.positions.length === 0) {
			console.log("\n── Positions: none ──");
		} else {
			console.log("\n── Positions ──");
			for (const p of summary.positions) {
				const pnlSign = p.unrealizedPnl >= 0 ? "+" : "";
				console.log(
					`  ${p.symbol.padEnd(8)} ${p.direction.padEnd(6)} qty=${p.qty.toFixed(4).padStart(10)}` +
						`  cost=$${p.avgCost.toFixed(2)}  now=$${p.currentPrice.toFixed(2)}` +
						`  P&L: ${pnlSign}$${p.unrealizedPnl.toFixed(2)} (${pnlSign}${p.unrealizedPnlPct.toFixed(2)}%)`,
				);
			}
		}
	});

portfolio
	.command("orders")
	.description("Show recent orders")
	.action(async () => {
		const { getAlpacaClient } = await import("./broker/alpaca.js");
		const client = getAlpacaClient();
		const orders = await client.getOrders("all", 20);
		console.log("\n── Recent Orders (last 20) ──");
		if (orders.length === 0) {
			console.log("  No orders found.");
		} else {
			for (const o of orders) {
				const price = o.filled_avg_price ? `@$${Number.parseFloat(o.filled_avg_price).toFixed(2)}` : "";
				console.log(
					`  ${o.created_at.slice(0, 19)}  ${o.symbol.padEnd(8)}  ${o.side.padEnd(5)}  qty=${o.qty.padStart(8)}  ${o.status.padEnd(10)}  ${price}`,
				);
			}
		}
	});

portfolio
	.command("reset")
	.description("Close all positions and cancel all orders")
	.action(async () => {
		const { getAlpacaClient } = await import("./broker/alpaca.js");
		const client = getAlpacaClient();
		await client.cancelAllOrders();
		await client.closeAllPositions();
		console.log("All positions closed and orders cancelled.");
	});

// ─── Parse and execute ───────────────────────────

program.parse();
