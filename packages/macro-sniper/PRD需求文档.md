# Pi-Mono 智能投顾机器人 — PRD 需求文档

我们要做一个智能投顾机器人，构建一个"从宏观水源到资产终端"的闭环系统。

这个系统的逻辑流向是：**流动性（水）→ 利率/债市（管道）→ 美元汇率（锚定）→ 情绪与风险资产（表现）→ 信号评分 → 仓位执行 → 风险管理（结果）**。

---

## 一、系统架构概览

### 已实现模块

| 模块 | 状态 | 职责 |
|------|------|------|
| **流动性监测** | ✅ Phase 1 | FRED 数据采集，净流动性计算，7 日变化方向信号 |
| **债市分析** | ✅ Phase 1 | 收益率曲线形态分类，信用利差 4 级毕业制 Risk-off |
| **情绪挖掘** | ✅ Phase 1 | VIX 35% + MOVE 25% + 恐惧贪婪 40% 综合信号 |
| **USD 汇率模型** | ✅ Phase 1 | γ = r_f + π_risk − cy 框架，CFTC COT 数据，对冲传导效率 |
| **日报生成** | ✅ Phase 1 | LLM（claude-opus-4-6）生成 12 章节日报，Slack 推送 |
| **BTC 4 支柱信号** | ✅ Phase 3 | 技术(35%) + 衍生品(40%) + 链上(15%) + ETF(10%) |
| **相关性矩阵** | ✅ Phase 3 | 5×5 Pearson 相关性，7d hourly + 30d daily，体制判断 |
| **信号评分器** | ✅ Phase 3+v1.2 | 6 维度加权求和 [-100,100]，维度内信号合并，DXY 差异化 |
| **交易引擎** | ✅ Phase 3 | score→decision→Alpaca 执行，多空双向（UUP） |
| **风险管理** | ✅ Phase 3 | L1-L5 五层风控，ATR 移动止损，回撤分级，BTC 联动 |
| **准确性追踪** | ✅ Phase 3 | T+1/T+5/T+10 多时间窗口，7 维度评估，利润因子 |
| **宏观事件日历** | ✅ Phase 3 | 12 项 FRED 经济指标采集，事件日仓位减码 |
| **国债拍卖监控** | ✅ v1.1 | 7 期限拍卖健康度，tail/through 偏差，期限溢价信号 |
| **SRF / 资金压力** | ✅ v1.1 | SRF 用量 + SOFR-IORB 利差 + SOFR99 尾部三支柱评分 |
| **因子正交化分析** | ✅ v1.2 | 6 维度分类 + 结构/统计冗余检测 + 空白区域发现 |

### 待实现模块

| 模块 | 阶段 | 说明 |
|------|------|------|
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
│   ├── collectors/                  # 数据采集（按领域组织）
│   │   ├── index.ts                 # barrel re-export
│   │   ├── liquidity.ts             # 流动性采集（WALCL/TGA/RRP/SOFR/IORB/SOFR99 + SRF 用量）
│   │   ├── bonds.ts                 # 债市（DGS2/3/5/7/10/20/30 + 信用利差 + 国债拍卖）
│   │   ├── sentiment.ts             # 情绪（VIX/MOVE/恐惧贪婪/BTC 衍生品/链上/ETF）
│   │   ├── fx.ts                    # 外汇汇率（DXY + 9 对主要货币）
│   │   ├── usd-model.ts            # USD 模型专用数据（期限溢价/BEI/央行利率）
│   │   ├── hourly.ts               # 小时线 OHLCV（SPY/QQQ/IWM/DXY/UUP/BTC）
│   │   ├── macro-events.ts         # 12 项 FRED 宏观指标采集 + 经济日历
│   │   ├── fred.ts                  # FRED API 客户端（缓存 + 重试）
│   │   ├── yahoo.ts                # Yahoo Finance 客户端
│   │   ├── binance.ts              # Binance 公共 API（BTC 价格/OI/funding/VWAP）
│   │   ├── coinmetrics.ts          # CoinMetrics Community API（MVRV/链上数据）
│   │   └── cftc.ts                  # CFTC COT 持仓数据（Legacy + TFF 报告）
│   │
│   ├── analyzers/                   # 分析引擎
│   │   ├── index.ts
│   │   ├── thresholds.ts            # ★ 所有阈值常量集中定义
│   │   ├── liquidity-signal.ts      # 流动性方向信号
│   │   ├── yield-curve.ts           # 收益率曲线形态分类
│   │   ├── credit-risk.ts           # 信用利差 4 级毕业制 Risk-off
│   │   ├── sentiment-signal.ts      # 情绪综合信号（VIX/MOVE/恐惧贪婪）
│   │   ├── usd-model.ts            # USD 汇率模型（γ = r_f + π_risk − cy）
│   │   ├── btc-signal.ts           # BTC 4 支柱信号（技术/衍生品/链上/ETF）
│   │   ├── correlation.ts          # 滚动相关性矩阵 + 体制判断
│   │   ├── atr.ts                  # ATR 计算（14d hourly bars）
│   │   ├── auction-health.ts       # 国债拍卖健康度 + tail 偏差 + 期限溢价
│   │   ├── funding-stress.ts       # 资金压力（SRF + SOFR-IORB + SOFR99 尾部）
│   │   ├── factor-analysis.ts      # 因子正交化分析 + 维度分类 + 空白区域发现
│   │   └── rolling.ts              # 滚动计算工具（7d 变化、20d 均线）
│   │
│   ├── reporters/                   # 报表生成
│   │   ├── index.ts
│   │   ├── prompt-template.ts       # 日报 Prompt 模板（12 章节）
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

### Collectors 组织原则

Collectors 按**领域**组织，每个领域文件负责一个业务域的数据写入：

| 类型 | 文件 | 职责 |
|------|------|------|
| **领域文件** | `liquidity.ts` | 流动性（FRED 6 series + SRF 用量） |
| | `bonds.ts` | 债市（收益率 DGS* + 信用利差 + 国债拍卖） |
| | `sentiment.ts` | 情绪（VIX/MOVE/F&G + BTC 衍生品/链上/ETF） |
| | `fx.ts` | 外汇汇率 |
| | `usd-model.ts` | USD 模型专用数据 |
| | `hourly.ts` | 小时线 OHLCV |
| | `macro-events.ts` | 宏观事件日历 |
| **API 客户端** | `fred.ts` | FRED API 工具（缓存 + 重试） |
| | `yahoo.ts` | Yahoo Finance 工具 |
| | `binance.ts` | Binance 公共 API 工具 |
| | `coinmetrics.ts` | CoinMetrics Community API 工具 |
| | `cftc.ts` | CFTC COT CSV 工具 |

领域文件可调用多个 API 客户端（如 `bonds.ts` 调 `fred.ts` + `yahoo.ts` + Treasury API），但每个领域文件只负责一个业务域。所有导出通过 `index.ts` 统一暴露。

### 数据库 Schema（21 张表）

| 表 | 用途 | 阶段 |
|---|------|------|
| `liquidity_snapshots` | FRED 流动性原始数据 | Phase 1 |
| `yield_snapshots` | FRED 收益率原始数据（DGS2/3/5/7/10/20/30） | Phase 1 |
| `credit_snapshots` | Yahoo 信用利差原始数据 | Phase 1 |
| `sentiment_snapshots` | 情绪指标原始数据（多 source/metric） | Phase 1 |
| `fx_snapshots` | 外汇汇率 + 期限溢价/BEI | Phase 1 |
| `analysis_results` | 分析信号（10 种 type） | Phase 1 |
| `generated_reports` | LLM 生成报告 | Phase 1 |
| `job_runs` | 任务执行记录 | Phase 1 |
| `hourly_prices` | 小时线 OHLCV + VWAP（6 标的） | Phase 3 |
| `positions` | 本地持仓快照（同步 Alpaca，含 high_water_mark） | Phase 3 |
| `orders` | 订单记录 | Phase 3 |
| `trade_log` | 成交记录 | Phase 3 |
| `prediction_snapshots` | 多时间窗口预测快照（含 btcComposite/sentimentComposite） | Phase 3 |
| `prediction_results` | 预测准确性评估结果（7 维度 + dead zone） | Phase 3 |
| `risk_events` | 风控事件记录（止损触发等） | Phase 3 |
| `risk_state` | 组合风险状态（portfolio_hwm/risk_level/consecutive_wins 等） | Phase 3 |
| `macro_events` | 12 项 FRED 宏观经济指标（CPI/NFP/FOMC/PCE 等） | Phase 3 |
| `macro_calendar` | 经济事件日历（含拍卖事件） | Phase 3 |
| `treasury_auctions` | 国债拍卖结果（7 期限 Note/Bond） | v1.1 |
| `srf_usage` | SRF 每日用量（NY Fed） | v1.1 |

### analysis_results 信号类型（10 种）

| type | signal 取值 | 来源 |
|------|------------|------|
| `liquidity_signal` | expanding / contracting / neutral | liquidity-signal.ts |
| `yield_curve` | bear_steepener / bull_steepener / bear_flattener / bull_flattener / neutral | yield-curve.ts |
| `credit_risk` | risk_on / risk_off / risk_off_confirmed / risk_off_severe | credit-risk.ts |
| `sentiment_signal` | extreme_fear / fear / neutral / greed / extreme_greed | sentiment-signal.ts |
| `usd_model` | bullish / bearish / neutral | usd-model.ts |
| `btc_signal` | bullish / bearish_alert / neutral | btc-signal.ts |
| `correlation_matrix` | synchronized / independent / neutral | correlation.ts |
| `market_bias` | risk_on / risk_off / neutral / conflicted | pipeline.ts |
| `auction_health` | healthy / neutral / weak / stressed | auction-health.ts |
| `funding_stress` | calm / elevated / tight / stressed / crisis | funding-stress.ts |

---

## 三、核心引擎模块详解

### 1. 全球流动性监测引擎（✅ 已实现）

**数据源：** FRED API

| 指标 | FRED Series ID | 频率 | 单位 |
|------|---------------|------|------|
| 美联储总资产 | `WALCL` | 周频（周四） | Millions USD |
| TGA 账户余额 | `WTREGEN` | 日频 | Millions USD |
| ON RRP 余额 | `RRPONTSYD` | 日频 | **Billions USD**（计算前 ×1000 转为 Millions） |
| SOFR 利率 | `SOFR` | 日频 | % |
| IORB 利率 | `IORB` | 日频 | % |
| SOFR 99th 分位 | `SOFR99` | 日频 | %（尾部融资压力） |

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

**信用风险（HYG/IEF、LQD/IEF）— 4 级毕业制：**

| 级别 | 判定 | 仓位乘数 |
|------|------|---------|
| `risk_on` | 比率 ≥ MA20 × 0.98 | ×1.0 |
| `risk_off` | 比率 < MA20 × 0.98（单日） | ×0.7 |
| `risk_off_confirmed` | 比率 < MA20 × 0.98 连续 2+ 日 | ×0.3 |
| `risk_off_severe` | 比率 < MA20 × 0.96 连续 3+ 日，或 HYG+LQD 同时 confirmed | ×0.0 |

> 只有 `risk_off_severe` 才完全清仓权益，其余级别通过乘数渐进降仓。

### 3. USD 汇率模型（✅ 已实现）

**核心框架：** γ = r_f + π_risk − cy

| 因子 | 组成 | 权重 |
|------|------|------|
| **r_f（利差支撑）** | Fed-ECB/BOJ/SONIA 利差差分，10Y 实际利率，2Y-FFR 利率路径 | 30% |
| **π_risk（风险溢价）** | 期限溢价 10Y，VIX（区分全球避险 vs 美国内部风险） | 25% |
| **cy（便利性收益）** | GLD 变化，SOFR-IORB 利差，DXY-利差模型残差 | 15% |
| **Hedge Transmission** | CIP 基差代理，CFTC 投机/资管头寸，DXY-利差背离 | 10% |
| **Global Relative** | EURUSD/USDCNY/USDMXN 相对强弱 | 20% |

**CFTC COT 数据：**
- Legacy 报告：USD Index 投机净头寸
- TFF 报告：EUR/JPY 资管净头寸（对冲比例代理）
- 数据源：CFTC 官网 CSV（周五更新）

**输出：** composite_score [0-100]，>60 bullish，<40 bearish，40-60 neutral。

### 4. 情绪信号（✅ 已实现）

**情绪综合评分（0-100）— 3 因子模型：**

| 指标 | 权重 | 标准化区间 | 数据源 |
|------|------|-----------|--------|
| VIX | 35% | ≥40 → 0分，≤12 → 100分 | FRED (VIXCLS) |
| MOVE | 25% | ≥180 → 0分，≤80 → 100分 | Yahoo Finance |
| 恐惧贪婪指数 | 40% | 直接使用 0-100 | alternative.me |

> BTC 相关指标（ETF 流入、OI 变化）已移至 BTC 4 支柱信号。

### 5. BTC 4 支柱信号（✅ 已实现）

**4 支柱加权模型：**

| 支柱 | 权重 | 子指标 |
|------|------|--------|
| **技术面** | 35% | MA7d 交叉，量能比，24h 急跌预警 |
| **衍生品** | 40% | funding rate（逆向），long/short ratio（逆向），taker 比率（顺向），OI 7d 变化率（顺向） |
| **链上** | 15% | MVRV（CoinMetrics），交易所净流出，活跃地址 |
| **ETF** | 10% | 量价背离信号：高成交量+价格不动=吸筹（看涨），低成交量+价格涨=动量衰竭（看跌） |

**数据源：**
- Binance 公共 API：BTC 价格/VWAP/funding rate/long-short ratio/taker ratio/OI 变化
- CoinMetrics Community API：MVRV/市值/已实现市值/交易所流量/活跃地址/哈希率
- Yahoo Finance：IBIT+FBTC+ARKB+GBTC ETF 成交量×价格（ETF 流量代理）

**BTC 价格 3 层数据：**
- `btc_price`：Binance lastPrice（瞬时价格）
- `close`：hourly_prices 小时 K 线收盘价
- `btc_vwap`：Binance klines quoteVolume/volume（量价加权均价）

### 6. 相关性矩阵（✅ 已实现）

- 5×5 Pearson 相关性（SPY/QQQ/IWM/DXY/BTCUSD）
- 7d hourly（timestamp floor-to-hour 对齐 Yahoo/Binance）
- 30d daily
- 体制：BTC-SPY r > 0.7 → synchronized；r < 0.2 → independent

### 7. 综合研判逻辑（✅ 已实现）

**三层优先级：**

1. **信用 Risk-off 一票否决**（priority=3）：credit = `risk_off_confirmed` → overall = `risk_off`，confidence = `high`
2. **流动性 × 曲线协同**（priority=2）：同向 → `risk_on` high；反向 → `conflicted` low；一方 neutral → 跟随另一方 medium
3. **情绪逆向修正**（priority=1）：extreme_fear + expanding → "超跌反弹机会"；extreme_greed + contracting → "风险过高"

### 8. 国债拍卖健康度（✅ v1.1 已实现）

**数据源：** US Treasury Fiscal Data API（免费，无需 key）

**监控期限：** 2Y / 3Y / 5Y / 7Y / 10Y / 20Y / 30Y（Note + Bond）

**每次拍卖采集指标：**

| 指标 | 含义 |
|------|------|
| `high_yield` | 中标利率（stop-out rate） |
| `bid_to_cover_ratio` | 投标倍数 |
| `indirect_pct` | 间接投标者占比（外国央行/主权基金） |
| `direct_pct` | 直接投标者占比 |
| `primary_dealer_pct` | 一级交易商占比（被迫兜底比例） |
| `offering_amt` | 发行额 |

**健康度评分（0-100）：**

| 维度 | 权重 | 逻辑 |
|------|------|------|
| 投标倍数 vs 基准 | 40% | 比率 > 基准 → 需求旺盛 |
| 间接投标者占比 | 30% | 高 = 外资积极买入 |
| 一级交易商占比 | 30% | 低 = 真实需求足够 |

**Tail/Through 偏差：**
- `tail_bps = 中标利率 − DGS WI 代理利率`
- 正值 = tail（需求不足，市场要更高补偿）
- 负值 = through（需求超预期好）

**期限溢价信号：**
- `term_premium_signal = 短端健康度 − 长端健康度`
- 正值 = 长端需求弱于短端 → 期限溢价上升
- 汇总按期限加权（10Y/30Y 权重 2x）

**信号级别：** healthy (≥65) / neutral (≥45) / weak (≥30) / stressed (<30)

### 9. SRF 与资金压力（✅ v1.1 已实现）

**数据源：** NY Fed Markets API（免费，无需 key）

**SRF（Standing Repo Facility）使用逻辑：**
- SRF 用量激增 = 银行不得不找央行借钱
- SOFR > IORB = 隔夜融资成本超过准备金利率
- SOFR 99th 飙升 = 部分机构极度缺钱

**三支柱等权评分（0-100）：**

| 支柱 | 权重 | 阈值 |
|------|------|------|
| SRF 用量 | 33% | $5B=elevated, $20B=spike; 连续多日额外加分 |
| SOFR−IORB 利差 | 34% | >0bp=转正, >5bp=tight, >10bp=stressed |
| SOFR 99th 尾部 | 33% | SOFR99−IORB >8bp=压力, >16bp=严重 |

**信号级别：** calm (<20) / elevated (<40) / tight (<60) / stressed (<80) / crisis (≥80)

### 10. 宏观事件日历（✅ Phase 3 已实现）

**12 项 FRED 经济指标：**

| 指标 | FRED Series | 频率 | 影响 |
|------|------------|------|------|
| CPI | CPIAUCSL | 月频 | 高 |
| 核心 CPI | CPILFESL | 月频 | 高 |
| 非农就业 | PAYEMS | 月频 | 高 |
| 失业率 | UNRATE | 月频 | 高 |
| FOMC 利率上限 | DFEDTARU | 不定期 | 高 |
| PCE | PCEPI | 月频 | 高 |
| 核心 PCE | PCEPILFE | 月频 | 高 |
| GDP | GDP | 季频 | 高 |
| PPI | PPIFIS | 月频 | 中 |
| 初请失业金 | ICSA | 周频 | 中 |
| 零售销售 | RSAFS | 月频 | 中 |
| 密歇根消费者信心 | UMCSENT | 月频 | 中 |

**事件日仓位减码（Layer 5）：**
- 高影响事件日（CPI/NFP/FOMC 等）：SPY/QQQ/IWM × 0.7
- BTC 和 UUP 不受影响（对 CPI/NFP 敏感度较低）

### 11. 因子正交化分析（✅ v1.2 已实现）

**问题：** 10 个分析信号并非完全独立。`liquidity_signal` 和 `funding_stress` 共享 SOFR/IORB/SOFR99 输入；`yield_curve` 和 `auction_health` 共享 DGS 收益率数据。如果在评分器中给相关信号各自分配独立权重，等于同一个信息投了两票。

**解决方案：6 个独立因子维度 + 2 个元因子**

| 维度 | 回答的问题 | 包含信号 | 维度内混合权重 |
|------|----------|---------|--------------|
| **流动性体制** | 钱是在变多还是变少？ | `liquidity_signal`(70%) + `funding_stress`(30%) | 共享一个评分权重槽 |
| **利率预期** | 市场认为利率往哪走？ | `yield_curve`(70%) + `auction_health`(30%) | 共享一个评分权重槽 |
| **信用条件** | 信用风险是否在被重新定价？ | `credit_risk` | 独立（乘数模式） |
| **风险偏好** | 市场愿意承担多少风险？ | `sentiment_signal` | 独立 |
| **美元体制** | 美元在走强还是走弱？ | `usd_model` | 独立 |
| **BTC 微观结构** | BTC 自身的供需如何？ | `btc_signal` | 独立 |

| 元因子 | 作用 | 信号 |
|--------|------|------|
| **跨资产结构** | 资产关系变化，影响因子传导路径 | `correlation_matrix` |
| **市场复合** | 所有因子加权合成 | `market_bias` |

**维度合并在评分器层实现：** 10 个分析器继续独立运行并写入 DB，评分器在读取信号后先将同一维度的多个信号合成为一个维度分数，再参与跨维度加权。

**流动性维度合并公式：**
```
liq_norm = {expanding: +1, neutral: 0, contracting: -1}
funding_norm = (50 - stress_score) / 50    // 0=calm → +1, 100=crisis → -1
liquidity_regime = liq_norm × 0.7 + funding_norm × 0.3
```

**利率维度合并公式：**
```
curve_norm = {bull_steepener: +0.8, ..., bear_flattener: -0.8}
auction_norm = (aggregate_health - 50) / 50    // 0=stressed → -1, 100=healthy → +1
rate_expectations = curve_norm × 0.7 + auction_norm × 0.3
```

**冗余检测工具（CLI `factors redundancy`）：**
- 结构冗余：识别各维度共享的原始数据输入
- 信号相关性：分类信号 → 数值 [-1,+1]，计算 Pearson r
- 连续指标相关性：metadata 中的 composite_score / spread / stress_score 等
- 判定标准：|r| > 0.7 高度冗余应合并，0.4-0.7 中度相关降权，< 0.4 独立

**因子空白区域发现（CLI `factors gaps`）：**

按"信息类型 × 时间尺度"矩阵扫描已实现和可加入的因子：

| 类别 | 已实现 | 可加入（简单） | 可加入（中等） |
|------|--------|-------------|--------------|
| 均值回归 | MVRV | RSI(14)、布林带 | — |
| 动量 | 净流动性趋势、MA7d | 多资产相对强弱 | — |
| 结构性 | SRF+SOFR、拍卖 | VIX 期限结构 | Put/Call 比率 |
| 跨资产 | BTC-SPX 相关性 | GLD/TLT 比率 | — |
| 日历/季节 | 事件日减仓 | — | 月末效应、季末效应 |
| 微观结构 | — | — | Order flow（受限） |

空白区域提醒每 3 天自动通过 Slack 推送。

---

## 四、交易执行系统（Phase 3）

### 交易标的

| 标的 | Alpaca 代码 | 仓位上限 | 方向 | 信号来源 |
|------|------------|---------|------|---------|
| SPY | SPY | 账户权益 20% | 仅做多 | 流动性+曲线+情绪+USD+BTC修正 |
| QQQ | QQQ | 账户权益 20% | 仅做多 | 同上（DXY 敏感度最高） |
| IWM | IWM | 账户权益 20% | 仅做多 | 同上（DXY 敏感度最低） |
| BTCUSD | BTCUSD | 账户权益 20% | 仅做多 | BTC 4 支柱+相关性+情绪+流动性 |
| UUP | UUP | 账户权益 20% | **多空双向** | USD模型(70%)+流动性反向(15%)+曲线(15%) |

> 仓位上限 `POSITION_MAX_PCT = 0.20`，按账户权益动态缩放。

### 信号评分器

**加权求和模型** → finalScore ∈ [-100, 100]

**维度合并（v1.2）：** 评分器在加权之前先将同一维度的信号合并为维度分数（详见 §11 因子正交化分析）。权重槽中的"流动性"实际是 liquidity_signal(70%) + funding_stress(30%) 的合成值，"收益率曲线"实际是 yield_curve(70%) + auction_health(30%) 的合成值。

**权益标的维度权重（SPY/QQQ/IWM）：**

| 维度 | QQQ | SPY | IWM |
|------|-----|-----|-----|
| 流动性体制 | 0.30 | 0.35 | 0.35 |
| 利率预期 | 0.20 | 0.25 | 0.30 |
| 风险偏好（逆向） | 0.20 | 0.20 | 0.20 |
| 美元体制 | 0.30 | 0.20 | 0.15 |

**DXY 敏感度系数：** QQQ=1.0 > SPY=0.6 > BTCUSD=0.5 > IWM=0.2

**USD 驱动源差异化（✅ 已实现）：**

USD 模型对权益标的的影响不再使用"美元强 = 股票压力大"的一刀切逻辑。信号评分器从 USD 模型 metadata 中读取 5 个子因子分数，根据驱动源差异化处理：

```
adjustedImpact = Σ(−deviation_i × modelWeight_i × impactMultiplier_i) / 50
equityImpact   = adjustedImpact × DXY敏感度系数
```

| 驱动因子 | 条件 | impactMultiplier | 理由 |
|---------|------|-----------------|------|
| rate_support | yield_driver=real_rate | 0.5 | 经济强劲，USD 强但股票未必差 |
| rate_support | yield_driver=term_premium | 1.0 | 财政风险，全额传导 |
| rate_support | yield_driver=inflation | 0.8 | 通胀粘性，中等传导 |
| risk_premium | deviation > 0（全球避险） | 1.3 | 避险资金涌入 USD，放大股票负面影响 |
| risk_premium | deviation < 0（美国内部风险） | −0.8 | **翻转**：USD 弱但股票也跌 |
| convenience_yield | — | 0.3 | 结构性溢价，与股票基本面弱相关 |
| hedge_transmission | — | 0.0 | 传导效率，非方向信号 |
| global_relative | — | 0.4 | 被动走强 ≠ 美国经济差 |

> 当 USD 模型 metadata 不可用时自动回退到原始一刀切逻辑。

**收益率曲线 × 通胀轮动矩阵：**
- 4 种曲线形态 × 3 种通胀状态（hot/warm/cool）× 3 种权益标的
- 通胀判定：T10YIE > 2.5% 或 (GLD 5d >+2% 且 20d >+5%) → hot；<2.0% 或两者为负 → cool；else warm
- 加分示例：bull_steepener + cool → IWM +15pt，QQQ +5pt

**BTC 维度权重：** btc_microstructure=0.45，corr_regime=0.20，risk_appetite=0.20，liquidity_regime=0.15

**UUP 维度权重：** usd_regime=0.70，liquidity_regime(反向)=0.15，rate_expectations=0.15

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

**否决逻辑（毕业制）：**
- credit_risk = `risk_off` → 仓位 ×0.7
- credit_risk = `risk_off_confirmed` → 仓位 ×0.3
- credit_risk = `risk_off_severe` → 仓位 ×0.0（全部平仓）
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

**L1 移动止损（ATR 吊灯 + 保本合并）：**
- 公式：`stop = max(entry_cost, HWM − 2×ATR)`（做多）
- ATR 计算：14d hourly bars，K=2
- HWM 逐仓跟踪：每次持仓同步后更新 `positions.high_water_mark`
- ATR 不可用时回退到固定 -8% 止损

**L2 回撤分级：**
| 回撤级别 | 阈值 | 仓位乘数 | 恢复条件 |
|---------|------|---------|---------|
| normal | — | ×1.0 | — |
| caution | -5% | ×0.5 | 3 次连续盈利升级 |
| warning | -10% | ×0.25 | 3 次连续盈利升级 |
| halt | -15% | ×0.0 | 3 次连续盈利升级 |

- **双倍退防：** 升级后连续 2 次亏损 → 强制退回更低级别
- 回撤基准：`portfolio_hwm`（组合权益最高水位）

**L3 信用否决（毕业制）：**
- `risk_off` → ×0.7 | `risk_off_confirmed` → ×0.3 | `risk_off_severe` → ×0.0

**L4 BTC 急跌联动：**
- BTC 24h < -5% → SPY/QQQ/IWM 减仓 20%，12h 冷却

**L5 事件日减码：**
- 高影响宏观事件日（CPI/NFP/FOMC）→ SPY/QQQ/IWM ×0.7
- BTC 和 UUP 不受影响

**5 层仓位调整 Pipeline：** correlation → ATR → drawdown → Kelly → event-day

> 评分器在进入 5 层 Pipeline 之前，先将 10 个分析信号合并为 6 个独立维度分数（v1.2）。

**相关性惩罚：** 30d daily corr > 0.85 的权益对 → 双方 ×0.7

**Quarter-Kelly 上限：** f*/4，最少 20 个样本后自动激活（~4 周）

### 准确性追踪 v2

**多时间窗口预测评估：**

| 窗口 | 适用信号 | 用途 |
|------|---------|------|
| T+1 | BTC 短期信号 | 日内信号有效性 |
| T+5 | 标准宏观信号 | 周度方向准确率 |
| T+10 | 流动性/信用/USD | 宏观趋势验证 |

**7 维度评估：** biasCorrect, btcCorrect, yieldRotationCorrect, usdCorrect, liquidityCorrect, creditCorrect, sentimentCorrect

**Dead zone：** |return| < 0.5% 视为噪声，排除出方向胜率统计

**利润因子：** Σ(正确方向回报) / Σ(错误方向回报)，比原始胜率更有意义

**信号强度关联：** 高置信 vs 低置信的准确率对比

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

### 日报固定结构（12 章节）

1. **📊 市场总览** — risk_on/risk_off/conflicted 立场 + 置信度
2. **💧 流动性研判** — 净流动性、7 日变化、SOFR-IORB、SRF 用量
3. **📈 债市形态解读** — 10s2s 利差、曲线形态、含义
4. **🔗 信用风险** — HYG/IEF、LQD/IEF 比率 vs MA20、毕业制级别
5. **₿ BTC 4 支柱** — 技术/衍生品/链上/ETF 综合评分
6. **📊 情绪指标** — VIX/MOVE/恐惧贪婪
7. **💵 美元汇率研判** — γ 模型评分、利差/风险溢价/便利性/对冲传导
8. **📋 持仓回顾** — 当前持仓、未实现 PnL、ATR、移动止损位
9. **🔄 相关性与轮动** — 7d/30d 相关矩阵、BTC-SPX 体制
10. **🎯 交易信号详解** — 5 标的评分分解、Kelly 系数、风控层状态
11. **📅 宏观事件日历** — 近期经济数据发布 + 拍卖安排
12. **🎯 综合操作建议** — 方向 + 置信度 + 风险提示 + 数据附录

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
| `0 8 * * *` | 08:00 每日 | 全量 pipeline：collect all → analyze → report → trade → notify |
| `45 8 * * 1-5` | 08:45 周一~五 | 宏观事件采集（08:30 发布窗口，仅事件日） |
| `30 9 * * 1-5` | 09:30 周一~五 | T+1/T+5/T+10 准确性评估 |
| `15 10 * * 1-5` | 10:15 周一~五 | 宏观事件采集（10:00 发布窗口，仅事件日） |
| `15 13 * * 1-5` | 13:15 周一~五 | 国债拍卖结果采集（拍卖 13:00 关闭） |
| `15 14 * * 3` | 14:15 周三 | FOMC 声明采集（14:00 发布，仅事件日） |
| `0 17 * * 1-5` | 17:00 周一~五 | 流动性（TGA/RRP 日频 + WALCL 周频）+ SRF 用量 |
| `0 18 * * 1-5` | 18:00 周一~五 | 收益率 + 信用利差 |
| `0 20 * * 0` | 20:00 周日 | 经济日历刷新 |
| `0 9 */3 * *` | 09:00 每 3 天 | 因子空白区域提醒（Slack 推送） |
| `0 * * * *` | 每小时 :00 | L1 止损检查 + L4 BTC 急跌检查 |
| `5 * * * *` | 每小时 :05 | BTC 交易引擎 |
| `30 * * * *` | 每小时 :30 | 情绪 + 小时线采集（含 BTC VWAP） |

**部署：** `start-scheduler.sh` → nohup 后台，日志 `/tmp/macro-sniper-scheduler.log`

---

## 七、CLI 命令汇总

```bash
# ─── 数据采集 ──────────────────────────────────────
macro-sniper collect liquidity     # 流动性数据（WALCL/TGA/RRP/SOFR/IORB/SOFR99）
macro-sniper collect bonds         # 债市数据（DGS2/3/5/7/10/20/30 + 信用利差）
macro-sniper collect sentiment     # 情绪 + BTC 衍生品/链上/ETF
macro-sniper collect fx            # FX 汇率 + USD 模型数据
macro-sniper collect hourly        # 小时线 OHLCV + BTC VWAP + 24h stats
macro-sniper collect macro         # 12 项 FRED 宏观指标
macro-sniper collect calendar      # 经济事件日历
macro-sniper collect auction       # 国债拍卖数据
macro-sniper collect srf           # SRF 用量（NY Fed）
macro-sniper collect all           # 全部数据源

# ─── 分析引擎 ──────────────────────────────────────
macro-sniper analyze all           # 运行全部分析（10 种信号）
macro-sniper analyze liquidity     # 流动性信号
macro-sniper analyze usd           # USD 模型
macro-sniper analyze btc           # BTC 4 支柱信号
macro-sniper analyze correlation   # 相关性矩阵
macro-sniper analyze auction       # 拍卖健康度 + tail 偏差 + 期限溢价
macro-sniper analyze funding       # 资金压力（SRF + SOFR-IORB + SOFR99）

# ─── 数据查询 ──────────────────────────────────────
macro-sniper liquidity             # 最新流动性数据 + 信号
macro-sniper bonds regime          # 收益率曲线形态
macro-sniper sentiment             # 情绪数据
macro-sniper usd                   # USD 模型分析
macro-sniper macro                 # 宏观事件 + 近期日历
macro-sniper auction               # 拍卖结果 + 即将拍卖
macro-sniper srf                   # SRF 用量历史图表

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
macro-sniper risk btc-crash        # 手动触发 BTC 急跌联动检查

# ─── 准确性追踪 ────────────────────────────────────
macro-sniper accuracy report       # 准确性报告（T+1/T+5/T+10）+ 优化建议
macro-sniper accuracy check        # 手动触发多窗口评估
macro-sniper accuracy snapshot     # 手动创建预测快照

# ─── 持仓管理 ──────────────────────────────────────
macro-sniper portfolio status      # 账户 + 持仓
macro-sniper portfolio orders      # 最近订单
macro-sniper portfolio reset       # 平仓 + 取消全部订单

# ─── 因子分析 ──────────────────────────────────────
macro-sniper factors dimensions    # 6 维度 + 2 元因子分类
macro-sniper factors redundancy    # 结构/统计冗余分析（相关性矩阵）
macro-sniper factors gaps          # 因子空白区域 + 建议

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
| **FRED API** | 流动性/收益率/VIX/SOFR99/期限溢价/BEI/央行利率/宏观指标 | 是 | 低 |
| **Yahoo Finance** | HYG/LQD/IEF/SPY/QQQ/IWM/GLD/UUP/MOVE/DXY 价格 + 小时线 + ETF 成交量 | 否 | 中（非官方） |
| **Binance** | BTC 价格/VWAP/OI/funding rate/long-short ratio/taker ratio/小时线 | 否（公共端点） | 低 |
| **CoinMetrics** | MVRV/市值/已实现市值/交易所流量/活跃地址/哈希率 | 否（Community API） | 低 |
| **alternative.me** | 恐惧贪婪指数 | 否 | 低 |
| **CFTC** | COT 持仓数据（Legacy + TFF） | 否 | 低 |
| **US Treasury** | 国债拍卖结果（Fiscal Data API） | 否 | 低 |
| **NY Fed** | SRF 用量（Markets API） | 否 | 低 |
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
- 当前：33/33 tests passing（5 test files）

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

### Phase 3 已完成（续）
- 子任务 E（L2-L4）：回撤分级 + 阶梯恢复 + 双倍退防 + 信用否决（毕业制） + BTC 急跌联动
- 子任务 F：日报增强 §8-§12（持仓回顾、相关性与轮动、交易信号详解、宏观日历、操作建议）
- 仓位管理：ATR 自适应仓位、移动止损（吊灯）、相关性惩罚、1/4 Kelly 上限
- BTC 4 支柱信号：技术(35%) + 衍生品(40%) + 链上(15%) + ETF(10%)
- 准确性追踪 v2：T+1/T+5/T+10 多窗口、7 维度、dead zone、利润因子
- 宏观事件日历：12 项 FRED 指标 + 事件日仓位减码（L5）
- 仓位上限改为账户权益 20%（动态缩放）

### v1.1 已完成
- 国债拍卖监控：7 期限拍卖健康度 + tail/through 偏差 + 期限溢价信号（commit `62779b8d`, `cd2016b4`）
- SRF 资金压力：SRF 用量 + SOFR-IORB 利差 + SOFR99 尾部三支柱评分（commit `735c76ba`）
- 收益率序列补齐：DGS3/DGS5/DGS7 + SOFR99

### v1.2 已完成
- Collectors 按领域重组：SRF 合入 `liquidity.ts`，国债拍卖合入 `bonds.ts`（commit `b16c5e74`）
- 因子正交化分析工具：维度分类 + 结构/统计冗余检测 + 空白区域发现（commit `e5ce3839`）
- 信号评分器维度合并：liquidity_signal+funding_stress → 流动性体制维度；yield_curve+auction_health → 利率预期维度（commit `441f2775`）
- 新 CLI 命令：`factors dimensions`、`factors redundancy`、`factors gaps`
- 每 3 天自动 Slack 推送因子空白区域提醒

### Phase 2（待启动）
- 前端 Web 看板
- 央行声明 NLP 分析
- FOMC 点阵图追踪
- 地缘政治风险指数

### Phase 4（远期）
- 期权对冲策略接口
- Alpha/Beta 归因分析
- 社交媒体情绪分析（Twitter/Reddit）
