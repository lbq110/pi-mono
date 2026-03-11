export interface PositionSummary {
	symbol: string;
	direction: string;
	quantity: number;
	avgCost: number;
	currentPrice: number;
	unrealizedPnl: number;
	pnlPct: number;
}

export interface ScoreSummary {
	symbol: string;
	score: number;
	direction: string;
	sizeMultiplier: number;
	notionalFinal: number;
	creditVeto: boolean;
	corrPenalty: string | null;
}

export interface ReportContext {
	date: string;
	liquiditySignal?: { signal: string; metadata: Record<string, unknown> };
	yieldCurveSignal?: { signal: string; metadata: Record<string, unknown> };
	creditRiskSignal?: { signal: string; metadata: Record<string, unknown> };
	sentimentSignal?: { signal: string; metadata: Record<string, unknown> };
	marketBias?: { signal: string; metadata: Record<string, unknown> };
	usdModel?: { signal: string; metadata: Record<string, unknown> };
	btcSignal?: { signal: string; metadata: Record<string, unknown> };
	correlationMatrix?: { signal: string; metadata: Record<string, unknown> };

	// §8-§11 additions
	positions?: PositionSummary[];
	scores?: ScoreSummary[];
	riskLevel?: string;
	riskMultiplier?: number;
	portfolioDrawdownPct?: number;
	atrInfo?: Record<string, { atrPct: number; stopPct: number }>;
	kellyFraction?: number | null;
	accountEquity?: number;
}

/**
 * Build the LLM prompt for daily report generation.
 * The prompt instructs the model to produce a structured Markdown report in Chinese.
 */
export function buildDailyReportPrompt(ctx: ReportContext): string {
	const staleWarnings: string[] = [];

	// Collect stale data warnings
	for (const entry of [ctx.liquiditySignal, ctx.yieldCurveSignal, ctx.creditRiskSignal, ctx.sentimentSignal]) {
		if (!entry) continue;
		const meta = entry.metadata;
		if (meta.stale && Array.isArray(meta.stale_sources) && meta.stale_sources.length > 0) {
			staleWarnings.push(`${meta.stale_sources.join(", ")}`);
		}
	}

	const staleNote =
		staleWarnings.length > 0
			? `\n⚡ 注意：以下数据源可能不是最新的：${staleWarnings.join("、")}。对应信号仅供参考。\n`
			: "";

	// Build positions data section
	const positionsSection =
		ctx.positions && ctx.positions.length > 0
			? ctx.positions
					.map(
						(p) =>
							`  ${p.symbol}: ${p.direction} ${p.quantity}股 @ $${p.avgCost.toFixed(2)}, 现价 $${p.currentPrice.toFixed(2)}, PnL $${p.unrealizedPnl.toFixed(2)} (${(p.pnlPct * 100).toFixed(2)}%)`,
					)
					.join("\n")
			: "暂无持仓";

	const scoresSection =
		ctx.scores && ctx.scores.length > 0
			? ctx.scores
					.map(
						(s) =>
							`  ${s.symbol}: score=${s.score.toFixed(1)} ${s.direction} ${(s.sizeMultiplier * 100).toFixed(0)}% $${s.notionalFinal}${s.creditVeto ? " [VETO]" : ""}${s.corrPenalty ? ` [${s.corrPenalty}]` : ""}`,
					)
					.join("\n")
			: "暂无评分";

	const atrSection =
		ctx.atrInfo && Object.keys(ctx.atrInfo).length > 0
			? Object.entries(ctx.atrInfo)
					.map(([sym, info]) => `  ${sym}: ATR=${info.atrPct.toFixed(2)}% 止损距=${info.stopPct.toFixed(2)}%`)
					.join("\n")
			: "ATR 数据积累中（需 15 天小时线）";

	const riskSection = [
		`  风控等级: ${ctx.riskLevel ?? "normal"} (乘数: ${ctx.riskMultiplier ?? 1})`,
		`  组合回撤: ${ctx.portfolioDrawdownPct !== undefined ? `${(ctx.portfolioDrawdownPct * 100).toFixed(2)}%` : "n/a"}`,
		ctx.kellyFraction !== null && ctx.kellyFraction !== undefined
			? `  1/4 Kelly 上限: ${(ctx.kellyFraction * 100).toFixed(1)}%`
			: "  1/4 Kelly: 样本不足，暂未激活",
		ctx.accountEquity ? `  账户权益: $${ctx.accountEquity.toFixed(2)}` : "",
	]
		.filter(Boolean)
		.join("\n");

	return `你是一位专业的宏观分析师，请根据以下数据生成一份中文投研日报。

日期：${ctx.date}
${staleNote}
## 数据输入

### 流动性信号
${ctx.liquiditySignal ? JSON.stringify(ctx.liquiditySignal, null, 2) : "暂无数据"}

### 收益率曲线
${ctx.yieldCurveSignal ? JSON.stringify(ctx.yieldCurveSignal, null, 2) : "暂无数据"}

### 信用风险
${ctx.creditRiskSignal ? JSON.stringify(ctx.creditRiskSignal, null, 2) : "暂无数据"}

### 情绪信号
${ctx.sentimentSignal ? JSON.stringify(ctx.sentimentSignal, null, 2) : "暂无数据"}

### 综合研判
${ctx.marketBias ? JSON.stringify(ctx.marketBias, null, 2) : "暂无数据"}

### 美元定价模型（γ = r_f + π_risk − cy）
${ctx.usdModel ? JSON.stringify(ctx.usdModel, null, 2) : "暂无数据"}

### BTC 信号
${ctx.btcSignal ? JSON.stringify(ctx.btcSignal, null, 2) : "暂无数据"}

### 相关性矩阵
${ctx.correlationMatrix ? JSON.stringify(ctx.correlationMatrix, null, 2) : "暂无数据"}

### 当前持仓
${positionsSection}

### 交易信号评分
${scoresSection}

### ATR 波动率
${atrSection}

### 风控状态
${riskSection}

## 输出要求

请严格按照以下固定结构输出 Markdown 格式日报，目标约800字。

**格式要求：每个章节必须用带粗体小标题的列表项分点阐述，禁止写成一整段纯文字。** 示例格式：
*   **小标题A**：具体分析内容...
*   **小标题B**：具体分析内容...

### 章节结构

1. **📊 市场总览** — 一段话概括当日整体立场（risk_on / risk_off / conflicted），点明核心矛盾

2. **💧 流动性研判** — 必须包含以下小标题（所有流动性数值单位均为百万美元，显示时请转换为易读格式如"X.XX 万亿"或"X,XXX 亿"）：
   *   **净流动性**：数值（百万美元→转换为万亿显示）、7 日变化量、方向信号（expanding/contracting/neutral）
   *   **关键指标**：美联储总资产、TGA 余额、ON RRP 余额（均为百万美元）
   *   **资金面**：SOFR、IORB、SOFR-IORB 利差，是否出现资金紧张

3. **📈 债市形态解读** — 必须包含以下小标题：
   *   **利差表现**：10s2s 利差数值
   *   **形态判定**：曲线形态分类（bear_steepener/bull_steepener/bear_flattener/bull_flattener/neutral）
   *   **形态含义**：解释该形态对经济周期的指示意义

4. **🔗 信用风险** — 必须包含以下小标题：
   *   **比率表现**：HYG/IEF、LQD/IEF 的当前比率及 20 日均线
   *   **风险评估**：是否触发 breach、连续突破天数、风险信号（risk_on/risk_off）

5. **₿ BTC 与情绪** — 必须包含以下小标题：
   *   **情绪指标**：综合情绪得分、恐惧贪婪指数
   *   **市场表现**：BTC 价格、OI 变化、ETF 资金流向
   *   **分歧分析**：指标间是否存在背离（如恐惧贪婪指数与综合得分方向相反）

6. **⚠️ 信号分歧提示** — 仅当综合研判中 conflicts 非空时出现，否则完全跳过此节

7. **💵 美元汇率研判** — 必须包含以下小标题（基于三因子定价公式 γ = r_f + π_risk − cy）：
   *   **美元方向信号**：综合评分（0-100）、信号（bullish/bearish/neutral）
   *   **利差支撑（r_f）**：Fed-ECB利差、Fed-BOJ利差、实际利率（10Y-BEI）、2Y与联邦基金利率之差（市场降息定价）、利差评分
   *   **风险溢价（π_risk）**：10Y期限溢价、VIX、风险评分；需判断风险来源——若VIX高+期限溢价低则为"全球避险→利好美元"，若VIX高+期限溢价高则为"美国自身财政/政策风险→利空美元"；若收益率上行由期限溢价驱动则明确指出"利差逻辑失效"
   *   **便利性收益（cy）**：黄金走势（去美元化信号）、SOFR-IORB利差（美债抵押品价值）、USD残差溢价（DXY超出利差模型的部分）、便利性评分
   *   **对冲传导效率**：分析利差预期能否有效传导至即期美元（hedge_transmission_score），从两个维度展开：
       - **对冲成本**：SOFR vs €STR利差（hedging_cost_score，若有值）、CIP基差代理（cip_basis_proxy，正=对冲便宜→外资"左手买债右手卖远期"→即期美元涨不动，负=对冲贵→外资裸奔→买债直接推升即期美元）
       - **对冲比例（影子指标）**：①CFTC TFF资管机构EUR多头（eur_asset_mgr_net，数值越大=对冲越多=利差传导越弱），注意周变化方向（正=加仓对冲/负=减仓）；②JPY资管同理；③CFTC USD Index投机净头寸（cftc_noncomm_net，负=市场做空美元）；④DXY vs利差背离（dxy_rate_divergence，负=利差强但DXY不涨=高对冲比例阻断传导）
       - **综合判断**：若hedge_transmission_score < 40则明确指出"利差传导效率低，即使利差有吸引力，美元也难以走强"
   *   **收益率分解**：10Y = 实际利率 + 通胀预期 + 期限溢价，指出主驱动因子
   *   **主要货币对**：列出 DXY、EUR/USD、USD/JPY、USD/CNY 等关键汇率
   *   **关注要点**：基于上述分析给出1-2个关键关注点

8. **📦 持仓回顾** — 必须包含以下小标题：
   *   **当前持仓**：列出所有持仓标的、方向、数量、成本价、现价、未实现盈亏（金额+百分比）
   *   **持仓变化**：相比上次日报，哪些标的新开仓/加仓/减仓/平仓
   *   **风控状态**：当前风控等级（normal/caution/warning/halt）、组合回撤、风控乘数
   *   若无持仓则简述"当前空仓"及原因

9. **🔄 相关性与轮动** — 必须包含以下小标题：
   *   **相关性矩阵**：列出 SPY-QQQ、SPY-IWM、QQQ-IWM、BTC-SPY 的 7d 和 30d 相关系数
   *   **BTC 相关性机制**：当前 BTC-SPY 相关性处于什么状态（synchronized/independent/neutral），对交易的影响
   *   **相关性惩罚**：是否有标的因高相关性被降低仓位

10. **📊 交易信号详解** — 必须包含以下小标题：
   *   **评分汇总**：每个标的的综合得分、方向、仓位比例、目标金额
   *   **ATR 波动率**：各标的的 14 日 ATR 百分比、止损距离百分比（若 ATR 数据不足则说明）
   *   **1/4 Kelly 上限**：当前是否激活、f* 值、对仓位的约束效果
   *   **关键信号分解**：对得分最高和最低的标的展开子分项（流动性、收益率曲线、情绪、USD 模型各贡献多少分）

11. **🎯 综合操作建议** — 基于 overall_bias + confidence + 美元方向信号 + 持仓状态给出综合方向，confidence=low 时明确建议观望

12. **📋 数据附录** — 关键数值汇总表格（Markdown 表格格式，包含美元模型数据、各标的评分、ATR、风控状态）

若存在 stale 数据，在对应章节开头标注"⚡ 以下信号基于非最新数据（数据源：xxx，最后更新：xxx）"。

直接输出 Markdown 文本，不要包裹在代码块中。不要输出顶级标题（如"# 宏观投研日报"），标题由系统自动添加，直接从"### 📊 市场总览"开始。`;
}
