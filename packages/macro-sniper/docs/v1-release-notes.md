# macro-sniper v1 版本记录

> 截至 2026-03-13，Phase 1 + Phase 3 全部完成。
> 规模：52 个源文件，8,360 行 TS + 906 行测试，17 张 DB 表，42 条 CLI 命令，9 条 cron 任务，33 个测试全通过。

---

## 一、数据采集层

`src/collectors/` — 从外部 API 采集原始数据写入 DB，与分析层完全解耦。

| 采集器 | 数据源 | 采集内容 | 频率 |
|--------|--------|----------|------|
| `liquidity.ts` | FRED API | WALCL（美联储总资产）、WTREGEN（TGA）、RRPONTSYD（逆回购）、SOFR、IORB、FEDFUNDS | 每日 08:00 |
| `bonds.ts` | FRED API | DGS2/10/20/30（收益率）、T10Y2Y（利差）、T10YIE（通胀预期） | 每日 08:00 + 17:30 |
| `sentiment.ts` | FRED + Yahoo + Binance | VIX、MOVE、Fear & Greed、BTC 价格/OI/ETF 流入、SPY/QQQ/IWM/UUP/DXY/GLD 日线报价 | 每日 + 每小时 :30 |
| `fx.ts` | FRED + Yahoo | DXY、EUR/USD、USD/JPY、USD/CNY、EUR/USD 3M 远期、金价 | 每日 08:00 |
| `usd-model.ts` | FRED + Yahoo | Fed/ECB/BOJ 利率差、期限溢价、VIX、黄金、SOFR-IORB、BEI | 每日 08:00 |
| `cftc.ts` | CFTC Open Interest | Legacy COT + TFF 报告（EUR/JPY/USD Index 投机/资管净头寸） | 每日 08:00 |
| `hourly.ts` | Yahoo + Binance | SPY/QQQ/IWM/UUP/DXY 小时线 OHLCV + BTCUSD 24h stats | 每小时 :30 |
| `binance.ts` | Binance 公开 API | BTC 现货价格 + 期货未平仓合约量 | 按需 |

**DB 表：** `liquidity_snapshots`、`yield_snapshots`、`credit_snapshots`、`sentiment_snapshots`、`fx_snapshots`、`hourly_prices`

---

## 二、分析引擎层

`src/analyzers/` — 从 DB 读取原始数据，输出 8 种标准化信号写入 `analysis_results` 表。

| 分析器 | 输出信号 | 信号值 |
|--------|----------|--------|
| `liquidity-signal.ts` | `liquidity_signal` | expanding / contracting / neutral |
| `yield-curve.ts` | `yield_curve` | bear_steepener / bull_steepener / bear_flattener / bull_flattener / neutral |
| `credit-risk.ts` | `credit_risk` | risk_on / risk_off / risk_off_confirmed |
| `sentiment-signal.ts` | `sentiment_signal` | risk_on / risk_off / neutral |
| `usd-model.ts` | `usd_model` | bullish / bearish / neutral（γ = r_f + π_risk − cy 三因子分解 + 对冲传导效率） |
| `btc-signal.ts` | `btc_signal` | bullish / bearish / neutral（含 equity_score_modifier +5/−10/0） |
| `correlation.ts` | `correlation_matrix` | synchronized / independent / neutral（7d 小时线 + 30d 日线滚动相关系数） |
| `rolling.ts` → market_bias | `market_bias` | risk_on / risk_off / conflicted（三层优先级：信用否决 > 流动性×曲线协同 > 情绪逆向） |
| `atr.ts` | — | 14 日 ATR（不写入 analysis_results，供仓位计算实时调用） |

**元数据：** 每个信号附带完整 JSON metadata（含子分项得分、原始数值、stale 标记），经 Zod schema 校验。

---

## 三、信号评分与仓位计算

`src/executors/signal-scorer.ts` — 将 8 种分析信号加权合成为 5 个标的的综合得分，经 4 层调整输出最终仓位。

### 交易标的

SPY、QQQ、IWM、BTCUSD（做多）、UUP（双向 long/short）

### 评分权重

| 标的 | 流动性 | 收益率曲线 | 情绪 | USD 模型 | 其他 |
|------|--------|------------|------|----------|------|
| SPY | 35% | 25% | 20% | 20% | BTC modifier +5/−10 |
| QQQ | 30% | 20% | 20% | 30% | BTC modifier +5/−10 |
| IWM | 35% | 30% | 20% | 15% | BTC modifier +5/−10 |
| BTCUSD | 15% liq | — | 20% sent | — | 45% btc_signal + 20% corr_regime |
| UUP | 15% liq(反) | 15% curve | — | 70% usd_model | — |

### 4 层叠加调整

```
基础评分 → ① 相关性惩罚 → ② ATR 仓位 → ③ 回撤乘数 → ④ Kelly 上限
```

| 层 | 规则 |
|----|------|
| ① 相关性惩罚 | 权益对 30d corr > 0.85 → 两者 ×0.7 |
| ② ATR 仓位 | notional = min(equity×20%, riskBudget ÷ 2×ATR%) |
| ③ 回撤乘数 | normal ×1 / caution ×0.5 / warning ×0.25 / halt ×0 |
| ④ Kelly 上限 | f*/4（需 ≥20 条预测记录） |

### 评分 → 仓位映射

**做多标的（SPY/QQQ/IWM/BTCUSD）：**

| 综合评分 | 方向 | sizeMultiplier |
|----------|------|----------------|
| ≥ 50 | long | 1.0（100%） |
| ≥ 20 | long | 0.5（50%） |
| < 20 | flat | 0（不开仓） |

**双向标的（UUP）：**

| 综合评分 | 方向 | sizeMultiplier |
|----------|------|----------------|
| ≥ 50 | long | 1.0 |
| ≥ 20 | long | 0.5 |
| −20 ~ 20 | flat | 0 |
| ≤ −20 | short | 0.5 |
| ≤ −50 | short | 1.0 |

### 否决机制

| 否决类型 | 条件 | 影响 |
|----------|------|------|
| 信用否决（L3） | `credit_risk = risk_off_confirmed` | SPY/QQQ/IWM 强制 flat |
| BTC 同步否决 | `correlation = synchronized` 且 `market_bias = risk_off` | BTCUSD 强制 flat |
| market_bias 冲突 | `market_bias = conflicted` | 所有标的 sizeMultiplier 上限 0.75 |

---

## 四、风控体系

`src/executors/risk-manager.ts` — 4 层风控，每小时自动检查。

| 层级 | 机制 | 触发条件 | 动作 |
|------|------|----------|------|
| **L1** | 移动止损（吊灯） | 价格穿越 max(成本, HWM−2×ATR) | 立即平仓 + 24h 冷却 |
| **L2** | 回撤分级 | 组合回撤 ≥5%/10%/15% | 乘数 ×0.5/×0.25/×0 |
| **L3** | 信用否决 | credit_risk = risk_off_confirmed | 权益仓位归零 |
| **L4** | BTC 急跌联动 | BTC 24h ≤ −5% | 权益减仓 20% + 12h 冷却 |

### 移动止损公式

```
做多：止损价 = max(开仓成本, 最高价 − 2 × ATR)
做空：止损价 = min(开仓成本, 最低价 + 2 × ATR)
ATR 不足时回退到固定 −8%
```

### 回撤分级

| 等级 | 条件 | 风控乘数 |
|------|------|----------|
| 🟢 normal | 回撤 < 5% | ×1.0 |
| 🟡 caution | 回撤 ≥ 5% | ×0.5 |
| 🟠 warning | 回撤 ≥ 10% | ×0.25 |
| 🔴 halt | 回撤 ≥ 15% | ×0 |

**恢复：** 连续 3 笔盈利升一级；升级后连亏 2 次退回（双倍退防）。

**数据持久化：** `risk_events` 表记录事件，`risk_state` 表存储组合 HWM / 风控等级 / 连胜连亏计数。

---

## 五、交易执行

`src/executors/trade-engine.ts` + `src/broker/alpaca.ts`

| 功能 | 说明 |
|------|------|
| 经纪商 | Alpaca Paper Trading API（REST） |
| 支持操作 | buy / sell / short / cover / resize_up / resize_down / resize_short / hold |
| 方向 | SPY/QQQ/IWM/BTCUSD 做多；UUP 双向（long + short） |
| 翻转逻辑 | 平仓当前方向 → 下一周期开反方向 |
| 仓位同步 | 每次执行后从 Alpaca 同步到本地 `positions` 表 |
| HWM 追踪 | 同步后更新 `high_water_mark`（移动止损用） |
| 冷却检查 | 下单前检查该标的是否在 L1 止损冷却期内 |
| 市场状态 | 非交易时段仅执行 BTCUSD（24/7 可交易） |

---

## 六、准确性追踪

`src/executors/accuracy-tracker.ts`

| 功能 | 说明 |
|------|------|
| 快照 | 每次日报生成后记录当日所有信号 + 5 标的价格 |
| T+5 评估 | 5 个交易日后对比实际价格变动 vs 预测方向 |
| 评估维度 | market_bias 方向、BTC 方向、收益率轮动（IWM vs QQQ）、USD 方向 |
| 优化建议 | ≥10 条结果后自动生成调参建议 JSON |
| Kelly 数据源 | `prediction_results` 表供 1/4 Kelly 公式使用 |

**DB 表：** `prediction_snapshots`、`prediction_results`

---

## 七、日报系统

`src/reporters/`

| 组件 | 说明 |
|------|------|
| 主模型 | `claude-opus-4-6`（Anthropic OAuth，自动刷新 token） |
| 备选 | `gemini-3.1-flash-lite-preview`（Gemini API Key） |
| 中文输出 | ~800 字，强制分点小标题 |

### 12 章节结构

1. 📊 市场总览
2. 💧 流动性研判
3. 📈 债市形态解读
4. 🔗 信用风险
5. ₿ BTC 与情绪
6. ⚠️ 信号分歧提示（仅 conflicted 时出现）
7. 💵 美元汇率研判（γ 三因子 + 对冲传导效率 + 收益率分解）
8. 📦 持仓回顾（仓位 + PnL + 风控等级）
9. 🔄 相关性与轮动（矩阵 + BTC 机制 + 惩罚状态）
10. 📊 交易信号详解（评分分解 + ATR + Kelly）
11. 🎯 综合操作建议
12. 📋 数据附录

**Prompt 上下文：** 除 6 种分析信号外，还注入 BTC 信号、相关性矩阵、当前持仓、评分明细、ATR 波动率、风控状态，总 prompt ~9,100 字符。

**DB 表：** `generated_reports`

---

## 八、通知推送

`src/notifications/`

| 通道 | 方式 | 状态 |
|------|------|------|
| **Slack** | Bot Token 直推 Block Kit + mrkdwn | ✅ 主通道 |
| Mom events | JSON 文件写入（兜底） | ✅ 备用 |

**Slack 特性：** CJK 粗体修复、自动分块（<3000 字符/块）、Markdown → mrkdwn 转换。

**告警类型：** 日报推送、L1 止损告警、L4 BTC 急跌告警。

---

## 九、调度系统

`src/jobs/scheduler.ts` — 9 条 cron 任务，全部 ET（美东）时区。

| Cron | 时间 | 任务 |
|------|------|------|
| `0 8 * * *` | 08:00 | 全量 pipeline（collect → analyze → report → trade → notify） |
| `30 17 * * *` | 17:30 | 收益率补充采集 |
| `45 17 * * *` | 17:45 | 信用利差补充采集 |
| `30 9 * * 1-5` | 09:30 | T+5 预测准确性评估 |
| `0 * * * *` | 每小时 :00 | L1 止损 + L4 BTC 急跌检查 |
| `5 * * * *` | 每小时 :05 | BTC 交易引擎 |
| `0 * * * *` | 每小时 :00 | 情绪采集 |
| `0 * * * *` | 每小时 :00 | 小时线采集 |
| — | — | 任务执行记录写入 `job_runs` 表 |

**部署：** `start-scheduler.sh` → nohup 后台，日志 `/tmp/macro-sniper-scheduler.log`

---

## 十、数据库

SQLite + Drizzle ORM + better-sqlite3，17 张表。

| 类别 | 表 |
|------|----|
| 原始数据 | `liquidity_snapshots`, `yield_snapshots`, `credit_snapshots`, `sentiment_snapshots`, `fx_snapshots`, `hourly_prices` |
| 分析结果 | `analysis_results` |
| 交易 | `positions`, `orders`, `trade_log` |
| 风控 | `risk_events`, `risk_state` |
| 预测 | `prediction_snapshots`, `prediction_results` |
| 日报 | `generated_reports` |
| 系统 | `job_runs` |

所有快照表和分析表均有唯一索引支持 upsert 幂等写入。

---

## 十一、CLI 命令

`src/cli.ts` — 42 条命令，分 8 组。

```bash
# 数据采集
collect liquidity|bonds|sentiment|fx|hourly|all

# 分析引擎
analyze all|liquidity|usd|btc|correlation

# 数据查询
liquidity                    # 最新流动性数据 + 信号
bonds regime                 # 收益率曲线形态
sentiment                    # 情绪数据
usd                          # USD 模型分析

# 日报
report today                 # 查看今日日报
report generate              # 手动生成日报 + 推送

# 完整流水线
run                          # collect → analyze → report → notify

# 交易
trade preview                # 预览评分（含 ATR/相关性/回撤/Kelly 调整）
trade run                    # 执行交易

# 风控
risk check                   # 手动 L1 止损检查
risk btc-crash               # 手动 L4 BTC 急跌检查
risk status                  # 风控事件 + 冷却 + 回撤分级

# 准确性
accuracy report              # 准确性报告 + 优化建议
accuracy check               # 手动 T+5 评估
accuracy snapshot            # 手动创建预测快照

# 持仓
portfolio status             # 账户 + 持仓
portfolio orders             # 最近订单
portfolio reset              # 平仓 + 取消全部

# 系统
jobs start                   # 前台启动 cron 调度
jobs status                  # 任务执行记录
db:migrate                   # 数据库迁移
```

---

## 十二、基础设施

| 组件 | 技术 |
|------|------|
| 语言 | TypeScript ESM |
| 构建 | tsgo (`tsconfig.build.json`) |
| 格式化 | Biome（tabs, indentWidth 3） |
| 测试 | Vitest, 33 tests / 5 files |
| 日志 | Pino structured logging（child logger per module） |
| 配置 | Zod-validated `.env`（`src/config.ts`） |
| LLM | `@mariozechner/pi-ai`（OAuth 自动刷新，fallback chain） |
| 数据库 | SQLite + Drizzle ORM + better-sqlite3 |
| HTTP | FRED / Yahoo / Binance / Alpaca / CFTC / Slack REST API |

---

## 十三、关键设计决策

| 决策 | 说明 |
|------|------|
| 模块解耦 | collectors → DB → analyzers → DB → reporters → DB，三层通过 DB 完全解耦 |
| Binance 替代 CoinGecko/Coinglass | 公开端点，无需 API Key |
| UUP 替代 UDN | Invesco DB US Dollar Index Bullish Fund，双向（long+short） |
| 仓位比例上限 | 单标的 ≤ 账户权益 20%（`POSITION_MAX_PCT`），替代早期固定 $10,000 |
| ATR 自适应 | 高波动标的自动缩小仓位，低波动标的放大至比例上限 |
| 移动止损合并 | 吊灯止损 + 保本止损合为一条公式：`max(entry, HWM − 2×ATR)` |
| 回撤分级 | 4 级状态机（normal/caution/warning/halt），降级自动、升级需连胜 |
| 双倍退防 | 升级后连亏 2 次退回，防止假恢复 |
| 1/4 Kelly | 保守使用 f*/4，需 ≥20 样本，系统初期自动跳过 |
| OAuth 自动刷新 | `console.anthropic.com/v1/oauth/token`，每次 LLM 调用前检查过期 |
| 翻转逻辑 | 平仓当前方向 → 下一周期开反方向，避免原子翻转复杂性 |

---

## 十四、Git 关键提交

| Commit | 内容 |
|--------|------|
| `1ed63741` | Phase 1 完成（采集 + 分析 + 日报 + 通知） |
| `0814ad91` | Phase 3C：BTC 信号 + 相关性矩阵 |
| `ab08b301` | Phase 3D：信号评分 + 交易引擎 + 准确性追踪 |
| `65f63a77` | Phase 3E-L1：单仓止损 + 24h 冷却 |
| `471afbb4` | UUP 双向交易集成 |
| `1756b9ee` | PRD 完整重写（593 行） |
| `eb5d2b6a` | ATR 仓位 + 移动止损 + 回撤分级 + 相关性惩罚 + Kelly |
| `4f625c66` | L4 BTC 急跌联动 + 日报 §8-§10 增强 |
| `885fe12b` | 固定 $10K 上限 → 账户比例 20% |

---

## 十五、待实现（Phase 2+）

| 功能 | 阶段 |
|------|------|
| 前端 Web 看板 | Phase 2 |
| 央行声明 NLP 分析 | Phase 2 |
| FOMC 点阵图追踪 | Phase 2 |
| 地缘政治风险指数 | Phase 2 |
| 期权对冲策略接口 | Phase 4 |
| Alpha/Beta 归因分析 | Phase 4 |
| 社交媒体情绪分析（Twitter/Reddit） | Phase 4 |
