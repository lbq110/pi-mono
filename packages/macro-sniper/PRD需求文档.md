# Pi-Mono 智能投顾机器人 — PRD 需求文档

我们要做一个智能投顾机器人，构建一个"从宏观水源到资产终端"的闭环系统。

这个系统的逻辑流向是：**流动性（水）→ 利率/债市（管道）→ 美元汇率（锚定）→ 情绪与风险资产（表现）→ 信号评分 → 仓位执行 → 风险管理（结果）**。

---

## 一、系统架构概览

### 已实现模块

| 模块 | 状态 | 职责 |
|------|------|------|
| **流动性监测** | ✅ Phase 1 | FRED 数据采集，净流动性计算，7 日变化方向信号 |
| **债市分析** | ✅ Phase 1 | 收益率曲线形态分类，信用利差 Risk-off 判定 |
| **情绪挖掘** | ✅ Phase 1 | VIX/MOVE/恐惧贪婪/BTC OI/ETF 流入综合信号 |
| **USD 汇率模型** | ✅ Phase 1 | γ = r_f + π_risk − cy 框架，CFTC COT 数据，对冲传导效率 |
| **日报生成** | ✅ Phase 1 | LLM（claude-opus-4-6）生成 8 章节日报，Slack 推送 |
| **BTC 信号** | ✅ Phase 3 | MA7d 交叉，量能比，24h 急跌预警，权益修正因子 |
| **相关性矩阵** | ✅ Phase 3 | 5×5 Pearson 相关性，7d hourly + 30d daily，体制判断 |
| **信号评分器** | ✅ Phase 3 | 加权求和 [-100,100]，DXY 差异化，曲线×通胀轮动矩阵 |
| **交易引擎** | ✅ Phase 3 | score→decision→Alpaca 执行，多空双向（UUP） |
| **风险管理** | ✅ Phase 3 | L1 单仓止损 -8%，24h 冷却，Slack 告警 |
| **准确性追踪** | ✅ Phase 3 | T+5 预测快照，方向正确率，优化建议 |

### 待实现模块

| 模块 | 阶段 | 说明 |
|------|------|------|
| **日报增强 §8-§11** | Phase 3F | 持仓回顾、相关性矩阵、交易信号、压力测试 |
| **L2-L4 风控** | Phase 3E+ | 组合回撤 -15%，信用否决，BTC -5% 联动 |
| **前端看板** | Phase 2 | Web 数据看板，实时图表 |
| **NLP 央行分析** | Phase 2 | 美联储声明鹰鸽分析，FOMC 点阵图追踪 |
| **期权对冲** | Phase 4 | 保护性看跌期权策略接口 |

---

## 二、技术架构

### 项目位置与目录结构

项目位于 pi-mono monorepo：`packages/macro-sniper/`

```
packages/macro-sniper/
├── src/
│   ├── index.ts                     # barrel export
│   ├── cli.ts                       # CLI 命令入口（Commander.js）
│   ├── config.ts                    # Zod 环境变量校验 + 配置
│   ├── logger.ts                    # pino logger + child logger 工厂
│   ├── llm.ts                       # LLM 调用层（pi-ai + OAuth + fallback）
│   ├── anthropic-auth.ts            # Anthropic OAuth token 刷新
│   ├── types.ts                     # 全局类型定义（Zod metadata schemas）
│   │
│   ├── db/                          # 数据库层
│   │   ├── schema.ts                # Drizzle ORM schema（16 张表）
│   │   ├── migrate.ts               # 迁移脚本（runMigrations / runMigrationsOnDb）
│   │   └── client.ts                # DB 连接单例
│   │
│   ├── collectors/                  # 数据采集
│   │   ├── index.ts
│   │   ├── fred.ts                  # FRED API 客户端（缓存 + 重试）
│   │   ├── liquidity.ts             # 流动性采集（WALCL/WTREGEN/RRPONTSYD/SOFR/IORB）
│   │   ├── bonds.ts                 # 债市收益率 + 信用利差
│   │   ├── sentiment.ts             # 情绪综合采集（VIX/MOVE/恐惧贪婪/BTC/ETF/权益代理）
│   │   ├── fx.ts                    # 外汇汇率采集（DXY + 9 对主要货币）
│   │   ├── usd-model.ts            # USD 模型专用数据（期限溢价/BEI/央行利率）
│   │   ├── cftc.ts                  # CFTC COT 持仓数据（Legacy + TFF 报告）
│   │   ├── hourly.ts               # 小时线 OHLCV（SPY/QQQ/IWM/DXY/UUP/BTC）
│   │   ├── yahoo.ts                # Yahoo Finance 客户端
│   │   └── binance.ts              # Binance 公共 API（BTC 价格/OI/小时线）
│   │
│   ├── analyzers/                   # 分析引擎
│   │   ├── index.ts
│   │   ├── thresholds.ts            # ★ 所有阈值常量集中定义
│   │   ├── liquidity-signal.ts      # 流动性方向信号
│   │   ├── yield-curve.ts           # 收益率曲线形态分类
│   │   ├── credit-risk.ts           # 信用利差 Risk-off 判定
│   │   ├── sentiment-signal.ts      # 情绪综合信号
│   │   ├── usd-model.ts            # USD 汇率模型（γ = r_f + π_risk − cy）
│   │   ├── btc-signal.ts           # BTC 技术信号（MA7d/量能/急跌）
│   │   ├── correlation.ts          # 滚动相关性矩阵 + 体制判断
│   │   └── rolling.ts              # 滚动计算工具（7d 变化、20d 均线）
│   │
│   ├── reporters/                   # 报表生成
│   │   ├── index.ts
│   │   ├── prompt-template.ts       # 日报 Prompt 模板（7 章节）
│   │   ├── pipeline.ts              # DB → 上下文 → LLM → DB
│   │   └── formatter.ts             # 报告格式化
│   │
│   ├── executors/                   # 交易执行 + 评估
│   │   ├── index.ts
│   │   ├── types.ts                 # TradedSymbol, InstrumentScore, TradeDecision 等
│   │   ├── signal-scorer.ts         # 加权评分器（5 标的 × 多信号源）
│   │   ├── trade-engine.ts          # score → decision → Alpaca 执行
│   │   ├── risk-manager.ts          # L1 止损 + 冷却期
│   │   └── accuracy-tracker.ts      # T+5 预测快照 + 准确性评估
│   │
│   ├── broker/                      # 券商接口
│   │   └── alpaca.ts               # Alpaca Paper Trading API（账户/持仓/下单/平仓）
│   │
│   ├── notifications/               # 通知推送
│   │   ├── index.ts
│   │   ├── slack.ts                 # Slack Bot Token 直推（Block Kit + mrkdwn）
│   │   ├── slack-format.ts          # Markdown → Slack mrkdwn 转换
│   │   └── mom-events.ts           # mom event JSON 兜底
│   │
│   └── jobs/                        # 定时任务
│       ├── index.ts
│       ├── scheduler.ts             # node-cron 注册（ET 时区）
│       ├── pipeline.ts              # collect → analyze → report → trade
│       └── run-tracker.ts           # job_runs 表记录
│
├── scripts/
│   └── backfill-fred.ts             # FRED 历史数据回填
│
├── test/
│   ├── helpers.ts                   # createTestDb + seed 函数（runMigrationsOnDb）
│   ├── pipeline.test.ts             # Analyzer + mock LLM + upsert 幂等
│   ├── collectors/
│   │   ├── fred.test.ts
│   │   └── binance.test.ts
│   ├── analyzers/
│   │   └── edge-cases.test.ts
│   └── integration/
│       └── e2e-pipeline.test.ts     # 端到端 pipeline
│
├── data/
│   └── macro-sniper.db              # SQLite 数据库
├── start-scheduler.sh               # nohup 后台启动脚本
├── package.json
├── tsconfig.build.json
├── drizzle.config.ts
└── vitest.config.ts
```

### 模块解耦原则

所有模块通过 DB 解耦，互不 import：

```
collectors → 读外部 API → 写原始数据 → DB
analyzers  → 读原始数据 → 计算信号   → 写 analysis_results → DB
reporters  → 读 analysis_results → LLM → 写 generated_reports → DB
executors  → 读 analysis_results → 评分 → Alpaca 执行 → 写 positions/orders/trade_log → DB
risk-mgr   → 读 Alpaca positions → 止损判断 → 写 risk_events → DB
notifications → 读 generated_reports → Slack 推送
```

### 数据库 Schema（16 张表）

| 表 | 用途 | 阶段 |
|---|------|------|
| `liquidity_snapshots` | FRED 流动性原始数据 | Phase 1 |
| `yield_snapshots` | FRED 收益率原始数据 | Phase 1 |
| `credit_snapshots` | Yahoo 信用利差原始数据 | Phase 1 |
| `sentiment_snapshots` | 情绪指标原始数据（多 source/metric） | Phase 1 |
| `fx_snapshots` | 外汇汇率 + 期限溢价/BEI | Phase 1 |
| `analysis_results` | 分析信号（8 种 type） | Phase 1 |
| `generated_reports` | LLM 生成报告 | Phase 1 |
| `job_runs` | 任务执行记录 | Phase 1 |
| `hourly_prices` | 小时线 OHLCV（6 标的） | Phase 3 |
| `positions` | 本地持仓快照（同步 Alpaca） | Phase 3 |
| `orders` | 订单记录 | Phase 3 |
| `trade_log` | 成交记录 | Phase 3 |
| `prediction_snapshots` | T+5 预测快照 | Phase 3 |
| `prediction_results` | 预测准确性评估结果 | Phase 3 |
| `risk_events` | 风控事件记录（止损触发等） | Phase 3 |

### analysis_results 信号类型（8 种）

| type | signal 取值 | 来源 |
|------|------------|------|
| `liquidity_signal` | expanding / contracting / neutral | liquidity-signal.ts |
| `yield_curve` | bear_steepener / bull_steepener / bear_flattener / bull_flattener / neutral | yield-curve.ts |
| `credit_risk` | risk_on / risk_off / risk_off_confirmed | credit-risk.ts |
| `sentiment_signal` | extreme_fear / fear / neutral / greed / extreme_greed | sentiment-signal.ts |
| `usd_model` | bullish / bearish / neutral | usd-model.ts |
| `btc_signal` | bullish / bearish_alert / neutral | btc-signal.ts |
| `correlation_matrix` | synchronized / independent / neutral | correlation.ts |
| `market_bias` | risk_on / risk_off / neutral / conflicted | pipeline.ts |

---

## 三、核心引擎模块详解

### 1. 全球流动性监测引擎（✅ 已实现）

**数据源：** FRED API

| 指标 | FRED Series ID | 频率 | 单位 |
|------|---------------|------|------|
| 美联储总资产 | `WALCL` | 周频 | Millions USD |
| TGA 账户余额 | `WTREGEN` | 周频 | Millions USD |
| ON RRP 余额 | `RRPONTSYD` | 日频 | **Billions USD**（计算前 ×1000 转为 Millions） |
| SOFR 利率 | `SOFR` | 日频 | % |
| IORB 利率 | `IORB` | 日频 | % |

**流动性公式：**
$$\text{Net Liquidity} = \text{WALCL} - \text{WTREGEN} - \text{RRPONTSYD} \times 1000$$

> ⚠️ RRPONTSYD 单位为 Billions，其余为 Millions，必须先乘以 1000 再做减法。

**信号判定：** 7 日变化量 > +500 亿 → expanding；< -500 亿 → contracting；其间 → neutral。
SOFR-IORB > 5bps → `funding_tight: true`。

### 2. 债市分析与收益率曲线（✅ 已实现）

**收益率曲线形态（5 日 Δ 判定）：**

| 形态 | 判定 | 含义 |
|------|------|------|
| `bear_steepener` | 10Y 涨 > +3bps 且 10Y-2Y 变化 > +3bps | 再通胀/财政忧虑 |
| `bull_steepener` | 2Y 跌 > -3bps 且 2Y-10Y 变化 < -3bps | 降息预期/衰退 |
| `bear_flattener` | 2Y 涨 > +3bps 且 2Y-10Y 变化 > +3bps | 加息预期 |
| `bull_flattener` | 10Y 跌 > -3bps 且 10Y-2Y 变化 < -3bps | 避险/长端需求 |
| `neutral` | 以上均不满足 | — |

**信用风险（HYG/IEF、LQD/IEF）：**
- 比率 < 20 日均线 × 0.98 → `risk_off`
- 连续 2 日 → `risk_off_confirmed`（一票否决所有权益仓位）

### 3. USD 汇率模型（✅ 已实现）

**核心框架：** γ = r_f + π_risk − cy

| 因子 | 组成 | 权重 |
|------|------|------|
| **r_f（利差支撑）** | Fed-ECB/BOJ 利差差分，10Y 实际利率，2Y-FFR 差值 | 35% |
| **π_risk（风险溢价）** | 期限溢价 10Y，VIX | 25% |
| **cy（便利性收益）** | GLD 变化，SOFR-IORB 利差，DXY-利差模型残差 | 25% |
| **Hedge Transmission** | CIP 基差代理，CFTC 投机/资管头寸，DXY-利差背离 | 15% |

**CFTC COT 数据：**
- Legacy 报告：USD Index 投机净头寸
- TFF 报告：EUR/JPY 资管净头寸（对冲比例代理）
- 数据源：CFTC 官网 CSV（周五更新）

**输出：** composite_score [0-100]，>60 bullish，<40 bearish，40-60 neutral。

### 4. 情绪与 BTC 信号（✅ 已实现）

**情绪综合评分（0-100）：**

| 指标 | 权重 | 标准化区间 |
|------|------|-----------|
| VIX | 25% | ≥40 → 0分，≤12 → 100分 |
| MOVE | 15% | ≥180 → 0分，≤80 → 100分 |
| 恐惧贪婪指数 | 20% | 直接使用 0-100 |
| BTC ETF 7d 流入 | 20% | ≥+5亿 → 100分，≤-5亿 → 0分 |
| BTC OI 7d 变化率 | 20% | ≥+10% → 100分，≤-10% → 0分 |

**BTC 技术信号：**
- MA7d 交叉：price > MA7d → bullish
- 量能比：24h volume > 1.2× MA7d volume → 量能扩张
- 急跌预警：24h change < -5% → `bearish_alert`
- 权益修正因子：bullish → +5pt，bearish_alert → -10pt，neutral → 0pt

**相关性矩阵：**
- 5×5 Pearson 相关性（SPY/QQQ/IWM/DXY/BTCUSD）
- 7d hourly（timestamp floor-to-hour 对齐 Yahoo/Binance）
- 30d daily
- 体制：BTC-SPY r > 0.7 → synchronized；r < 0.2 → independent

### 5. 综合研判逻辑（✅ 已实现）

**三层优先级：**

1. **信用 Risk-off 一票否决**（priority=3）：credit = `risk_off_confirmed` → overall = `risk_off`，confidence = `high`
2. **流动性 × 曲线协同**（priority=2）：同向 → `risk_on` high；反向 → `conflicted` low；一方 neutral → 跟随另一方 medium
3. **情绪逆向修正**（priority=1）：extreme_fear + expanding → "超跌反弹机会"；extreme_greed + contracting → "风险过高"

---

## 四、交易执行系统（Phase 3）

### 交易标的

| 标的 | Alpaca 代码 | 仓位上限 | 方向 | 信号来源 |
|------|------------|---------|------|---------|
| SPY | SPY | $10,000 | 仅做多 | 流动性+曲线+情绪+USD+BTC修正 |
| QQQ | QQQ | $10,000 | 仅做多 | 同上（DXY 敏感度最高） |
| IWM | IWM | $10,000 | 仅做多 | 同上（DXY 敏感度最低） |
| BTCUSD | BTCUSD | $10,000 | 仅做多 | BTC信号+相关性+情绪+流动性 |
| UUP | UUP | $10,000 | **多空双向** | USD模型(70%)+流动性反向(15%)+曲线(15%) |

### 信号评分器

**加权求和模型** → finalScore ∈ [-100, 100]

**权益标的权重（SPY/QQQ/IWM）：**

| 信号 | QQQ | SPY | IWM |
|------|-----|-----|-----|
| 流动性 | 0.30 | 0.35 | 0.35 |
| 收益率曲线 | 0.20 | 0.25 | 0.30 |
| 情绪（逆向） | 0.20 | 0.20 | 0.20 |
| USD 模型 | 0.30 | 0.20 | 0.15 |

**DXY 敏感度系数：** QQQ=1.0 > SPY=0.6 > BTCUSD=0.5 > IWM=0.2

**收益率曲线 × 通胀轮动矩阵：**
- 4 种曲线形态 × 3 种通胀状态（hot/warm/cool）× 3 种权益标的
- 通胀判定：T10YIE > 2.5% 或 (GLD 5d >+2% 且 20d >+5%) → hot；<2.0% 或两者为负 → cool；else warm
- 加分示例：bull_steepener + cool → IWM +15pt，QQQ +5pt

**BTC 权重：** btc_signal=0.45，corr_regime=0.20，sentiment=0.20，liquidity=0.15

**UUP 权重：** usd_model=0.70，liquidity_anti_corr=0.15，yield_curve=0.15

### 仓位阈值

**单向标的（SPY/QQQ/IWM/BTC）：**
| 分数 | 方向 | 仓位比 |
|------|------|--------|
| ≥ 50 | long | 100% |
| ≥ 20 | long | 50% |
| < 20 | flat | 0% |

**双向标的（UUP）：**
| 分数 | 方向 | 仓位比 |
|------|------|--------|
| ≥ +50 | long | 100% |
| ≥ +20 | long | 50% |
| (-20, +20) | flat | 0% |
| ≤ -20 | short | 50% |
| ≤ -50 | short | 100% |

**否决逻辑：**
- credit_risk = risk_off_confirmed → 所有权益平仓
- BTC synchronized + risk_off → BTC 平仓
- market_bias = conflicted → 所有仓位上限 75%

**仓位调整容差：** 目标 vs 现有 >20% 才触发 resize

### 交易引擎

**动作类型：** buy / sell / hold / resize_up / resize_down / short / cover / resize_short

**翻转逻辑（UUP long↔short）：** 先平当前方向，下一周期开反向仓位

**执行约束：**
- 美股（SPY/QQQ/IWM/UUP）：仅市场开盘时执行
- BTC：24/7 可执行
- L1 止损冷却期内：禁止重新入场

### 风险管理

**L1 单仓止损（✅ 已实现）：**
- 阈值：单仓未实现亏损 < -8%
- 动作：立即平仓
- 冷却期：24h 内禁止该标的重新入场
- 告警：Slack Block Kit 推送（标的、亏损%、绝对亏损、冷却到期时间）
- 记录：`risk_events` 表

**L2-L4（待实现）：**
- L2：组合总回撤 < -15%
- L3：信用利差否决（权益平仓）
- L4：BTC -5% 急跌联动（减仓 20%）

### 准确性追踪

**T+5 预测评估：**
- 快照：每次日报生成后记录当日信号 + 价格
- 评估：5 个交易日后对比实际价格变化 vs 预测方向
- 维度：market_bias 方向、BTC 方向、收益率轮动、USD 方向
- 优化建议：10 次以上结果后自动生成调参建议

---

## 五、日报系统

### LLM 配置

| 角色 | 模型 | 用途 |
|------|------|------|
| 主模型 | `claude-opus-4-6`（Anthropic OAuth） | 日报生成 |
| 备选 | `gemini-3.1-flash-lite-preview` | 主模型不可用时 fallback |

**OAuth 流程：**
- Token 存储：`/root/.pi/agent/auth.json`（access/refresh/expires）
- 刷新端点：`console.anthropic.com/v1/oauth/token`
- 每次 API 调用前自动检查 token 有效性，过期自动刷新

### 日报固定结构（7 章节）

1. **📊 市场总览** — risk_on/risk_off/conflicted 立场 + 置信度
2. **💧 流动性研判** — 净流动性、7 日变化、SOFR-IORB
3. **📈 债市形态解读** — 10s2s 利差、曲线形态、含义
4. **🔗 信用风险** — HYG/IEF、LQD/IEF 比率 vs MA20
5. **₿ BTC 与情绪** — ETF 流入、OI、恐惧贪婪、综合分
6. **💵 美元汇率研判** — γ 模型评分、利差/风险溢价/便利性/对冲传导
7. **🎯 综合操作建议** — 方向 + 置信度 + 风险提示 + 数据附录

**Stale 数据标注：** "⚡ 以下信号基于非最新数据（数据源：xxx）"

### 通知推送

**Slack Block Kit + mrkdwn：**
- 自动将 Markdown 转换为 Slack mrkdwn
- CJK 粗体修复
- 超长内容自动分块（<3000 字符/块）
- 优先 Slack Bot Token 直推，兜底 mom event JSON

---

## 六、定时调度

所有时间为 ET（美东时间）。

| Cron | 时间 | 任务 |
|------|------|------|
| `0 8 * * *` | 08:00 每日 | 全量 pipeline：collect → analyze → report → trade → notify |
| `30 9 * * 1-5` | 09:30 周一~五 | T+5 预测准确性评估 |
| `0 * * * *` | 每小时 :00 | L1 止损检查 |
| `5 * * * *` | 每小时 :05 | BTC 交易引擎 |
| `30 * * * *` | 每小时 :30 | 情绪 + 小时线采集 |

**部署：** `start-scheduler.sh` → nohup 后台，日志 `/tmp/macro-sniper-scheduler.log`

---

## 七、CLI 命令汇总

```bash
# ─── 数据采集 ──────────────────────────────────────
macro-sniper collect liquidity     # 流动性数据
macro-sniper collect bonds         # 债市数据
macro-sniper collect sentiment     # 情绪数据
macro-sniper collect fx            # FX 汇率 + USD 模型数据
macro-sniper collect hourly        # 小时线 OHLCV + BTC 24h stats
macro-sniper collect all           # 全部数据源

# ─── 分析引擎 ──────────────────────────────────────
macro-sniper analyze all           # 运行全部分析（8 种信号）
macro-sniper analyze liquidity     # 流动性信号
macro-sniper analyze usd           # USD 模型
macro-sniper analyze btc           # BTC 信号
macro-sniper analyze correlation   # 相关性矩阵

# ─── 数据查询 ──────────────────────────────────────
macro-sniper liquidity             # 最新流动性数据 + 信号
macro-sniper bonds regime          # 收益率曲线形态
macro-sniper sentiment             # 情绪数据
macro-sniper usd                   # USD 模型分析

# ─── 日报 ──────────────────────────────────────────
macro-sniper report today          # 查看今日日报
macro-sniper report generate       # 手动生成日报 + 推送

# ─── 完整流水线 ────────────────────────────────────
macro-sniper run                   # collect → analyze → report → notify

# ─── 交易执行 ──────────────────────────────────────
macro-sniper trade preview         # 预览评分（不下单）
macro-sniper trade run             # 执行交易

# ─── 风险管理 ──────────────────────────────────────
macro-sniper risk check            # 手动触发止损检查
macro-sniper risk status           # 查看止损事件 + 冷却状态

# ─── 准确性追踪 ────────────────────────────────────
macro-sniper accuracy report       # 准确性报告 + 优化建议
macro-sniper accuracy check        # 手动触发 T+5 评估
macro-sniper accuracy snapshot     # 手动创建预测快照

# ─── 持仓管理 ──────────────────────────────────────
macro-sniper portfolio status      # 账户 + 持仓
macro-sniper portfolio orders      # 最近订单
macro-sniper portfolio reset       # 平仓 + 取消全部订单

# ─── 系统 ──────────────────────────────────────────
macro-sniper jobs start            # 前台启动 cron 调度
macro-sniper jobs status           # 任务执行记录
macro-sniper db:migrate            # 运行数据库迁移
```

---

## 八、环境变量配置

```env
# ─── 必须 ─────────────────────────────────────────
FRED_API_KEY=                          # FRED API（流动性/收益率/VIX）

# ─── Slack 推送 ──────────────────────────────────
SLACK_BOT_TOKEN=xoxb-...              # Slack Bot Token
SLACK_CHANNEL_ID=C0XXXXXXX            # 目标频道

# ─── LLM ─────────────────────────────────────────
# Anthropic OAuth（主模型 claude-opus-4-6）
# 通过 /root/.pi/agent/auth.json 管理 token
# 备选 Gemini API Key：
GEMINI_API_KEY=

# ─── 交易执行（Alpaca Paper Trading）─────────────
ALPACA_API_KEY=
ALPACA_API_SECRET=
ALPACA_BASE_URL=https://paper-api.alpaca.markets/v2

# ─── 可选 ─────────────────────────────────────────
MOM_EVENTS_DIR=                        # mom event 兜底路径
MOM_CHANNEL_ID=
DATABASE_PATH=./data/macro-sniper.db
LOG_LEVEL=info

# ─── LLM 模型配置 ────────────────────────────────
LLM_MODEL_HEAVY=claude-opus-4-6
LLM_MODEL_FAST=gemini-3.1-flash-lite-preview
LLM_FALLBACK_MODEL=gemini-2.5-flash
LLM_TEMPERATURE=0.1
```

---

## 九、数据源汇总

| 数据源 | 用途 | 需要 Key | 风险 |
|--------|------|---------|------|
| **FRED API** | 流动性/收益率/VIX/期限溢价/BEI/央行利率 | 是 | 低 |
| **Yahoo Finance** | HYG/LQD/IEF/SPY/QQQ/IWM/GLD/UUP/MOVE/DXY 价格 + 小时线 | 否 | 中（非官方） |
| **Binance** | BTC 价格/OI/小时线/24h stats | 否（公共端点） | 低 |
| **alternative.me** | 恐惧贪婪指数 | 否 | 低 |
| **SoSoValue** | BTC ETF 7d 净流入 | 否 | 中（非官方） |
| **CFTC** | COT 持仓数据（Legacy + TFF） | 否 | 低 |
| **Alpaca** | Paper Trading 执行 | 是 | 低 |

---

## 十、开发规范

### 代码规范
- ES Module，biome 格式化（tabs，indentWidth 3）
- 无 `any` 类型
- 无 inline imports
- 所有阈值集中于 `thresholds.ts`，禁止硬编码

### 数据 Stale 处理
- 周频数据（WALCL/WTREGEN）：>9 天 → stale
- 日频 FRED：>3 天 → stale
- 日频市场数据：>3 天 → stale
- 高频数据（BTC）：>1 小时 → stale
- Stale 时使用最近有效值，metadata 标记 `stale: true`

### 错误处理
- 外部 API：3 次重试（指数退避），失败跳过不中断 pipeline
- 风险预警：Slack 告警
- 敏感数据不入日志

### 测试
- 所有外部 API 通过 `vi.mock` 拦截
- SQLite `:memory:` 模式 + `runMigrationsOnDb()`
- 当前：33/33 tests passing

### Git 提交
- 特定文件 `git add`，不用 `git add -A`
- commit message 包含 `fixes #N` 关联 issue

---

## 十一、开发路线图

### Phase 1 ✅ 已完成（commit `1ed63741`）
- 子任务 1：项目基础架构
- 子任务 2：流动性采集 + 分析
- 子任务 3：债市采集 + 收益率曲线 + 信用风险
- 子任务 4：情绪采集 + 综合信号
- 子任务 5：日报生成 + Slack 推送
- 附加：USD FX 模型、CFTC COT、对冲传导效率、market_bias 综合研判

### Phase 3 ✅ 已完成
- 子任务 A：Alpaca broker 基础设施 + DB schema
- 子任务 B：小时线采集（SPY/QQQ/IWM/DXY/UUP/BTC）
- 子任务 C：BTC 信号分析 + 相关性矩阵（commit `0814ad91`）
- 子任务 D：信号评分器 + 交易引擎 + 准确性追踪（commit `ab08b301`）
- 子任务 E（L1）：单仓止损 -8% + 24h 冷却（commit `65f63a77`）
- UUP 双向交易集成（commit `471afbb4`）

### Phase 3 待实现
- **子任务 E（L2-L4）：** 组合回撤、信用否决、BTC 联动
- **子任务 F：** 日报增强 §8 持仓回顾、§9 相关性矩阵、§10 交易信号、§11 压力测试

### Phase 2（待启动）
- 前端 Web 看板
- 央行声明 NLP 分析
- FOMC 点阵图追踪
- 地缘政治风险指数

### Phase 4（远期）
- 期权对冲策略接口
- Alpha/Beta 归因分析
- 社交媒体情绪分析（Twitter/Reddit）
