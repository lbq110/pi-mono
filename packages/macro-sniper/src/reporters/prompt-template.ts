export interface ReportContext {
	date: string;
	liquiditySignal?: { signal: string; metadata: Record<string, unknown> };
	yieldCurveSignal?: { signal: string; metadata: Record<string, unknown> };
	creditRiskSignal?: { signal: string; metadata: Record<string, unknown> };
	sentimentSignal?: { signal: string; metadata: Record<string, unknown> };
	marketBias?: { signal: string; metadata: Record<string, unknown> };
	usdModel?: { signal: string; metadata: Record<string, unknown> };
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

## 输出要求

请严格按照以下固定结构输出 Markdown 格式日报，目标约800字。

**格式要求：每个章节必须用带粗体小标题的列表项分点阐述，禁止写成一整段纯文字。** 示例格式：
*   **小标题A**：具体分析内容...
*   **小标题B**：具体分析内容...

### 章节结构

1. **📊 市场总览** — 一段话概括当日整体立场（risk_on / risk_off / conflicted），点明核心矛盾

2. **💧 流动性研判** — 必须包含以下小标题：
   *   **净流动性**：数值、7 日变化量、方向信号（expanding/contracting/neutral）
   *   **关键指标**：美联储总资产、TGA 余额、ON RRP 余额
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
   *   **收益率分解**：10Y = 实际利率 + 通胀预期 + 期限溢价，指出主驱动因子
   *   **主要货币对**：列出 DXY、EUR/USD、USD/JPY、USD/CNY 等关键汇率
   *   **关注要点**：基于上述分析给出1-2个关键关注点
   *   **操作建议**：基于美元方向信号给出具体的外汇操作建议（如做多/做空美元、关注哪些货币对、建议仓位轻重、止损位参考等）；若信号为 neutral 或数据不足则建议观望并说明触发条件

8. **🎯 综合操作建议** — 基于 overall_bias + confidence + 美元方向信号给出综合方向，confidence=low 时明确建议观望

9. **📋 数据附录** — 关键数值汇总表格（Markdown 表格格式，包含美元模型数据）

若存在 stale 数据，在对应章节开头标注"⚡ 以下信号基于非最新数据（数据源：xxx，最后更新：xxx）"。

直接输出 Markdown 文本，不要包裹在代码块中。不要输出顶级标题（如"# 宏观投研日报"），标题由系统自动添加，直接从"### 📊 市场总览"开始。`;
}
