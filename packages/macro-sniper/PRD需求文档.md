# Pi-Mono 智能投顾机器人 — PRD 需求文档

我们要做一个智能投顾机器人，构建一个"从宏观水源到资产终端"的闭环系统。

这个系统的逻辑流向是：**流动性（水）→ 利率/债市（管道）→ 经济基本面（环境）→ 情绪与风险资产（表现）→ 仓位与执行（结果）**。

以下是**智能投顾机器人全维度架构方案**：

---

## 一、 核心引擎模块化规划

### 1. 全球流动性与利率监测引擎 (The "Water" Monitor)

这是整个系统的"前瞻指标"，决定了市场的系统性机会。

- **硬指标监控：** 实时抓取 SOFR-IORB 利差、TGA 账户、ON RRP、美联储负债总额。

- **流动性计算公式：**

    $$\text{Net Liquidity} = \text{Fed Total Assets} - \text{TGA} - \text{ON RRP}$$

- **利率市场：** 跟踪 EFFR、IORB 以及联邦基金目标利率的偏离度。

- **Pi-Mono 任务：** 每日定时从 FRED 和美联储官网抓取数据，计算流动性变动并在日报中预警"缩表/扩表"节奏。


### 2. 债市深度分析与收益率曲线 (The "Pipe" Logic)

利用收益率曲线的形态变化，预判经济周期阶段。

- **曲线监控：** 2Y/10Y/20Y/30Y 收益率及利差（10s2s, 30s10s）。

- **逻辑模块（LLM 驱动）：**

    - **Bear Steepener（熊陡）：** 识别 10Y 上涨快于 2Y，自动关联"再通胀交易"或"财政赤字担忧"。

    - **Bull Steepener（牛陡）：** 识别 2Y 下降快于 10Y，自动关联"降息预期上升"或"衰退避险"。

- **信用风险：** 监控 **HYG/IEF** 和 **LQD/IEF**。当比例跌破 20 日均线时，触发 Risk-off 警报。


### 3. 宏观基本面与事件驱动分析 (The "Environment" Scan)

将低频数据与高频新闻结合。

- **数据矩阵：** GDP 细分、ISM PMI、非农、CPI/PCE 路径跟踪。

- **LLM 文本解析：**

    - **央行动态：** 自动爬取 G7 央行（日、欧、英、瑞等）利率决议，使用 NLP 模型对比上一次声明，标注"转鹰"或"转鸽"的措辞变化。

    - **预期管理：** 对比 Fed Watch 点阵图与当前市价的缺口。

- **地缘政治评分：** 监测主流外媒关于"制裁、冲突、关税"的关键词频率，计算风险指数。


### 4. 情绪挖掘与加密货币专属区 (The "Vibe" & Crypto)

捕捉市场极端时刻与另类资金流。

- **情绪指标：** 结合 VIX、MOVE（债市波动率）、恐惧贪婪指数。

- **另类数据：** 爬取 Twitter (@ViviennaBTC 等大 V 提及频次)、Reddit 情绪值、BTC 链上稳定币铸造量。

- **BTC 专属：** 未平仓合约（OI）、期权 Gamma 分布、ETF 净流入/流出数据。

- **Pi-Mono 任务：** 24/7 监控 ETF 审批进程或链上大额转账新闻。


---

## 二、 风险控制与投后进化模块

### 5. 动态风控与压力测试 (The "Shield")

- **相关性矩阵：** 自动计算 BTC 与 DXY、10Y 美债的相关性。如果相关性从 -0.8 升至 -0.2，提示"资产驱动逻辑发生异变"。

- **压力测试：** 模拟场景——"如果美元指数（DXY）暴涨至 108，当前 BTC 仓位的预估回撤是多少？"

- **熔断机制：** 结合实时回撤数据，自动建议减仓比例。


### 6. 归因分析与策略复盘 (The "Brain")

- **AI 决策日志：** 每一笔交易建议旁需附带"证据链"（例如：因为 10s2s 走阔 + HYG/IEF 上升 + BTC ETF 流入 = 建议看多）。

- **Alpha/Beta 拆解：** 复盘时分析收益是来自于大盘上涨（Beta），还是来自于精准捕捉到了链上异动（Alpha）。


---

## 三、 交互与产出系统 (The "Interface")

- **多维度报告产出：**

    - **日报：** 聚焦流动性变动与昨日行情复盘。

    - **周报：** 聚焦宏观趋势（PMI/非农）与下周风险日历。

    - **突发研报：** 在 CPI 或财报公布后 5 分钟内，生成"预期 vs 实际"的深度解析。

- **自然语言指令：** 你可以问它："基于现在的 MOVE 指数和美债利差，我是否应该增加 BTC 仓位？"


---

## 系统逻辑汇总表

| **维度** | **监控核心** | **Pi-Mono 关键动作** | **AI 决策逻辑点** |
|---|---|---|---|
| **流动性** | TGA / RRP / SOFR-IORB | 每日抓取美联储负债表 | 判定市场"水"多还是少 |
| **债市** | 10s2s / MOVE / HYG:IEF | 实时计算利差形态 | 判定是"衰退交易"还是"通胀交易" |
| **宏观** | CPI / 非农 / 央行决议 | 爬取官方文档并摘要 | 判定美联储下一步动作概率 |
| **加密** | ETF 流入 / 稳定币 / OI | 监控 SosoValue 或链上浏览器 | 判定风险资产的承接力度 |
| **情绪** | VIX / Twitter / 微博 | 社交媒体关键词情感分析 | 寻找"过度恐慌"的博弈机会 |

---

## 开发路线图

由于功能非常丰富，我们将分三个阶段进行集成：

1. **第一阶段：后端数据工作流自动化（子任务 1-5）。** 优先打通美债（10s2s）、流动性（TGA/RRP）和 BTC ETF 的数据流，实现基础的日报生成。本阶段专注后端，所有交互通过 CLI 完成，不含前端和 HTTP API。

2. **第二阶段：前端看板 + LLM 逻辑层整合。** 搭建 Web 数据看板，并引入对美联储主席发言和央行决议的 NLP 分析，赋予机器人"理解"政策的能力。如需分布式任务队列，此阶段可将 node-cron 升级为 BullMQ + Redis（业务代码无需改动，仅替换调度层）。

3. **第三阶段：风控与交易闭环。** 加入相关性矩阵分析和 API 下单功能，完成从分析到执行的最后一步。

---

## 第一阶段：后端数据工作流自动化 — 开发指南（子任务 1-5）

### 项目位置与目录结构

项目位于 pi-mono monorepo：`/Users/lubinquan/Desktop/study/Pi/pi-mono/packages/macro-sniper/`

```
packages/macro-sniper/
├── src/
│   ├── index.ts                     # 主入口，barrel export
│   ├── cli.ts                       # CLI 命令入口
│   ├── config.ts                    # Zod 环境变量校验 + 配置
│   ├── logger.ts                    # pino logger 实例 + child logger 工厂
│   ├── types.ts                     # 全局类型定义（含各 analyzer metadata Zod schema）
│   │
│   ├── db/                          # 数据库层
│   │   ├── schema.ts                # Drizzle ORM schema 定义
│   │   ├── migrate.ts               # 迁移脚本
│   │   └── client.ts                # DB 连接实例
│   │
│   ├── collectors/                  # 信息搜集（子任务 2、3、4）
│   │   ├── index.ts
│   │   ├── fred.ts                  # FRED API 客户端
│   │   ├── liquidity.ts             # 流动性数据采集
│   │   ├── bonds.ts                 # 债市收益率 + 信用利差采集
│   │   ├── sentiment.ts             # 情绪数据采集
│   │   ├── yahoo.ts                 # Yahoo Finance 客户端
│   │   └── binance.ts              # Binance 公共 API 客户端（BTC 价格 + OI）
│   │
│   ├── analyzers/                   # 分析引擎（子任务 2、3、4）
│   │   ├── index.ts
│   │   ├── thresholds.ts            # ★ 所有阈值常量集中定义（便于调优）
│   │   ├── liquidity-signal.ts      # 流动性方向信号判定
│   │   ├── yield-curve.ts           # 收益率曲线形态分类
│   │   ├── credit-risk.ts           # 信用利差 Risk-off 判定
│   │   ├── sentiment-signal.ts      # 情绪综合信号判定
│   │   └── rolling.ts               # 滚动计算（7日变化量、20日均线）
│   │
│   ├── reporters/                   # 报表生成（子任务 5）
│   │   ├── index.ts
│   │   ├── prompt-template.ts       # 日报 Prompt 模板
│   │   ├── pipeline.ts              # 读 DB 信号→组装上下文→LLM→写 DB
│   │   └── formatter.ts             # 报告格式化
│   │
│   ├── executors/                   # 交易执行（第三阶段占位）
│   │   ├── index.ts
│   │   └── types.ts
│   │
│   ├── notifications/               # 通知推送（Slack 直推 + mom events 兜底）
│   │   ├── index.ts
│   │   ├── slack.ts                # Slack Bot Token 直接推送（优先）
│   │   ├── slack-format.ts         # Markdown → Slack mrkdwn 格式转换
│   │   └── mom-events.ts           # 向 mom events 目录写 JSON 文件触发 Slack 推送（兜底）
│   │
│   └── jobs/                        # 定时任务编排
│       ├── index.ts
│       ├── scheduler.ts             # node-cron 定时注册
│       ├── pipeline.ts              # 串行执行 collect→analyze→report→notify
│       └── run-tracker.ts           # job_runs 表读写（任务执行记录）
│
├── scripts/
│   └── backfill-fred.ts             # 历史数据回填脚本
│
├── test/
│   ├── helpers.ts                   # 测试公共工具（createTestDb、seed 函数）
│   ├── pipeline.test.ts             # Analyzer 单元测试 + mock LLM 报告 + upsert 幂等
│   ├── collectors/
│   │   ├── fred.test.ts             # FRED 解析、缓存、重试、异常值过滤
│   │   └── binance.test.ts          # Binance BTC 价格/OI 解析、重试耗尽
│   ├── analyzers/
│   │   └── edge-cases.test.ts       # 空数据跳过、数据不足、信用连续突破、极端情绪、曲线形态
│   └── integration/
│       └── e2e-pipeline.test.ts     # 端到端：seed → analyze → report → verify DB
│
├── package.json                     # @mariozechner/pi-macro-sniper
├── tsconfig.build.json
├── drizzle.config.ts                # drizzle-kit 迁移配置
├── vitest.config.ts
└── data/
    └── macro-sniper.db              # SQLite 数据库文件（运行时生成）
```

**模块完全通过 DB 解耦：**

所有模块只依赖 `db/`，互不 import，通过数据库表进行数据传递：

```
collectors → 读外部 API → 写原始数据 → DB（LiquiditySnapshot / YieldSnapshot / CreditSnapshot / SentimentSnapshot）
analyzers  → 读原始数据 → 计算信号  → 写分析结果 → DB（AnalysisResult）
reporters  → 读分析结果 → 组装上下文 → 调用 LLM → 写报告 → DB（GeneratedReport）
notifications → 读报告 → Slack Bot Token 直推（优先）/ 写 mom event JSON（兜底）→ 推送至 Slack
executors  → 读分析结果 → 执行交易（第三阶段）
```

| 层 | 职责 | 唯一依赖 |
|---|---|---|
| `collectors/` | 抓取外部数据，写入 DB | → `db/` |
| `analyzers/` | 读原始数据，计算信号，写回 DB | → `db/` |
| `reporters/` | 读分析结果，生成报告，写回 DB | → `db/` |
| `executors/` | 读分析结果，执行交易（第三阶段） | → `db/` |
| `notifications/` | 读报告，Slack 直推（优先）或 mom event 兜底推送 | → `db/` + Slack API / mom events 目录 |
| `jobs/` | 编排调度，保证执行顺序：collectors → analyzers → reporters → notifications | → 所有模块 |
| `cli.ts` | CLI 入口，用户交互唯一入口 | → 所有模块 |

> **扩展性：** 新增数据源只需加 collector + analyzer，写入 DB 后 reporters 自动读取新信号，无需改动 reporters 代码。

### 子任务 1：项目基础架构搭建

**目标：** 初始化项目，搭建可运行的后端开发环境，配置所有外部 API Key。

> **注意：** 第一阶段专注后端工作流跑通，所有交互通过 CLI 完成，前端看板延后至第二阶段。

- [ ] 在 pi-mono monorepo 的 `packages/macro-sniper` 下初始化子项目，遵循 monorepo 约定（ES Module、lockstep 版本、biome 格式化）
- [ ] 技术栈：TypeScript + Drizzle ORM（`better-sqlite3`）+ drizzle-kit + node-cron + Commander.js（CLI）+ `@mariozechner/pi-ai`（monorepo 内 LLM 统一调用层）
- [ ] 数据库：SQLite（单文件，轻量零运维，Drizzle ORM 通过 `drizzle-orm/better-sqlite3` 驱动）
- [ ] 定时调度：node-cron（进程内 cron 表达式调度，零外部依赖；生产环境用 pm2 或 systemd 守护进程）
- [ ] **创建 `.env` 配置文件**，填入所有后续子任务需要的 API Key 和环境变量：
  - `FRED_API_KEY` — 流动性 / 收益率 / VIX 等宏观数据（子任务 2、3、4 使用）
  - `ANTHROPIC_API_KEY` — Claude LLM 日报生成，通过 `@mariozechner/pi-ai` 调用（可选，pi-ai 自动从环境变量检测）
  - `GEMINI_API_KEY` — Google Gemini LLM，默认快速模型（推荐配置）
  - `SLACK_BOT_TOKEN` — Slack Bot Token，用于直接推送日报到 Slack 频道（子任务 5 使用）
  - `SLACK_CHANNEL_ID` — 目标 Slack Channel ID（子任务 5 使用）
  - `MOM_EVENTS_DIR` — mom events 目录路径，Slack 推送兜底方案（可选）
  - `MOM_CHANNEL_ID` — 目标 Slack Channel ID，mom 推送时指定（可选）
  - `BINANCE_API_KEY` — Binance API Key，预留第三阶段交易执行使用（可选，数据采集无需 Key）
  - `POLYGON_API_KEY` — 美股数据备用（可选）
  - `DATABASE_PATH` — SQLite 数据库文件路径
  - LLM 模型等配置项（参见下方环境变量配置参考）
- [ ] 提供 `.env.example` 模板 + Zod 校验环境变量（`src/config.ts`）
- [ ] 定义 Drizzle ORM schema（`src/db/schema.ts`）：
  - 原始数据表：LiquiditySnapshot、YieldSnapshot、CreditSnapshot、SentimentSnapshot
  - 分析结果表：AnalysisResult（type、signal、metadata JSON、date — 所有 analyzer 统一写入，reporters 统一读取）。保持单表设计，但 metadata 字段必须通过 Zod schema 约束（每种 type 对应一个 schema，定义在 `src/types.ts`），写入时校验、读取时解析，避免脏数据
  - 报告表：GeneratedReport
  - 任务执行记录表：JobRun（job、status、startedAt、finishedAt、error、durationMs — 替代 Redis 记录任务状态）
- [ ] 运行 drizzle-kit 迁移，创建数据库表
- [ ] 搭建 CLI 框架（`src/cli.ts`），注册基础命令
- [ ] 编写 `test-apis` 脚本，验证所有外部数据源连通性

> **完成标志：** 子任务 1 完成后，`.env` 中已包含所有必要的 API Key 和配置，后续子任务（2-5）可直接读取，无需重复配置。

**package.json 关键字段：**
```json
{
  "name": "@mariozechner/pi-macro-sniper",
  "type": "module",
  "bin": { "macro-sniper": "./dist/cli.js" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "dev": "tsc -p tsconfig.build.json --watch",
    "test": "vitest --run"
  },
  "dependencies": {
    "@mariozechner/pi-ai": "^0.52.9",
    "better-sqlite3": "...",
    "drizzle-orm": "...",
    "node-cron": "...",
    "commander": "...",
    "pino": "..."
  },
  "devDependencies": {
    "pino-pretty": "..."
  }
}
```

### 开发规范

**非交易日与数据滞后处理：**
- WALCL、WTREGEN 为周频数据（每周四更新），周一至周三采集到的是上周数据
- 美国市场节假日期间部分 FRED 数据不更新
- 每条 Snapshot 记录必须存储 `data_date`（数据实际生效日期）和 `fetched_at`（采集时间），二者区分
- Analyzer 判断数据就绪：比较最新 `data_date` 与当前日期，若超过 stale 阈值则标记信号为 `stale`

**数据 stale 阈值（集中定义在 `src/analyzers/thresholds.ts`）：**

```ts
/** 各数据源的 stale 判定阈值 */
export const STALE_THRESHOLDS = {
  /** 周频数据（WALCL / WTREGEN）：>9 天无新数据视为 stale */
  weekly: 9,
  /** 日频 FRED 数据（SOFR / IORB / EFFR / DGS* / VIXCLS）：>3 天（含周末） */
  dailyFred: 3,
  /** 日频市场数据（HYG / LQD / IEF / MOVE / 恐惧贪婪指数）：>3 天 */
  dailyMarket: 3,
  /** 高频数据（BTC 价格 / OI）：>1 小时 */
  highFrequency: 1,  // 单位：小时
};
```

**stale 数据处理策略：** 使用最近有效值继续计算，但信号的 metadata 中标记 `stale: true` 及 `stale_sources: string[]`（列出哪些数据源过旧）。Reporter 在日报中注明"以下信号基于非最新数据，仅供参考"。

**时区处理：**
- 定时任务时间均为 ET（美东时间），使用 `date-fns-tz` 处理时区转换
- 服务器部署在非 ET 时区时，通过 `TZ` 环境变量或代码内显式转换

**错误处理规范：**
- 外部 API 调用失败：重试 3 次（指数退避），仍失败则写入错误日志 + 跳过本次采集，不中断整体流水线
- 风险预警类错误（如数据源长期不可用）：通过 mom event 触发 Slack 告警通知
- 所有错误信息不得包含 API Key 等敏感数据

**LLM fallback 策略：**
- 主模型不可用时（API 报错、超时、限流），自动降级到备选模型
- fallback 链：`主模型（默认 gemini-3.1-flash-lite-preview）` → `LLM_FALLBACK_MODEL（默认 gemini-2.5-flash）` → 失败（记录错误，跳过本次生成）
- 所有模型使用统一 Prompt，不做模型特异适配（`@mariozechner/pi-ai` 已屏蔽 API 差异）
- fallback 发生时在日报 metadata 中记录实际使用的模型
- MiniMax 不纳入 fallback 链（质量不稳定），仅作手动测试用

**日志方案：**
- 使用 `pino` 结构化 JSON 日志（便于后续接入 ELK / Datadog）
- 日志级别通过 `LOG_LEVEL` 环境变量控制，默认 `info`
- 各模块使用 child logger（自动附加 `module: 'collector'` / `'analyzer'` / `'reporter'` 等标签）
- 每次采集记录：数据源、耗时、记录数、是否成功
- 生产环境输出到 stdout（由 pm2 / systemd 接管日志轮转），开发环境使用 `pino-pretty` 格式化

**测试 Mock 策略：**
- 所有外部 API 调用在测试中通过 `vi.mock` 拦截，不发真实请求
- `test/fixtures/` 存放各数据源的 mock 响应 JSON，从真实 API 采样一次后固化
- 测试覆盖：正常响应、空数据、API 报错、超时四种场景
- **LLM 调用测试：** mock `@mariozechner/pi-ai` 的 stream 函数，返回 `test/fixtures/sample-report.md` 中的固定文本。不在自动化测试中调用真实 LLM API（成本高且不确定性大）
- **集成测试：** 使用 SQLite `:memory:` 模式，fixture 数据写入 DB，验证完整 pipeline：collectors(mock) → DB → analyzers → DB → reporters(mock LLM) → DB，断言最终 `GeneratedReport` 记录存在且结构正确

**子任务间开发依赖说明：**
- 子任务 5（日报）依赖子任务 2/3/4 的数据，但开发可并行
- 子任务 5 开发时使用 `test/fixtures/` 中的 mock 数据写入 DB，无需等 collectors 完成
- 各子任务独立可测试，通过 fixture 数据 + SQLite 内存模式（`:memory:`）快速验证

### 分析逻辑量化定义

> **代码规范：** 以下所有阈值常量必须集中定义在 `src/analyzers/thresholds.ts` 文件顶部，使用 `UPPER_SNAKE_CASE` 命名，并附注释说明含义。禁止在分析函数中硬编码数字。后续回测调优时只需改动此文件。

#### A. 流动性方向信号（`liquidity-signal.ts`）

```ts
// ─── src/analyzers/thresholds.ts ─────────────────
/** 净流动性 7 日变化量阈值（单位：亿美元） */
export const LIQUIDITY_EXPANDING_THRESHOLD = 500;   // > +500 亿 → expanding
export const LIQUIDITY_CONTRACTING_THRESHOLD = -500; // < -500 亿 → contracting
// ±500 亿之间 → neutral

/** SOFR-IORB 利差预警阈值（单位：bps） */
export const SOFR_IORB_TIGHT_THRESHOLD = 5;         // > 5bps → 资金面偏紧
```

| 信号 | 判定规则 |
|------|---------|
| `expanding` | 净流动性 7 日变化量 > `+LIQUIDITY_EXPANDING_THRESHOLD` |
| `contracting` | 净流动性 7 日变化量 < `LIQUIDITY_CONTRACTING_THRESHOLD` |
| `neutral` | 7 日变化量在阈值之间 |

辅助标记：SOFR-IORB 利差 > `SOFR_IORB_TIGHT_THRESHOLD` → 信号 metadata 中附加 `funding_tight: true`。

#### B. 收益率曲线形态（`yield-curve.ts`）

基于 2Y 和 10Y 的 **5 个交易日变化量（Δ5d）** 判定：

```ts
// ─── src/analyzers/thresholds.ts ─────────────────
/** 收益率变动最低有效幅度（单位：bps） */
export const CURVE_MOVE_THRESHOLD = 3;               // 单边至少变动 3bps
/** 长短端差异最低有效幅度（单位：bps） */
export const CURVE_SPREAD_THRESHOLD = 3;             // 长短端差距至少 3bps
/** 形态判定使用的回看窗口（交易日） */
export const CURVE_LOOKBACK_DAYS = 5;
```

| 形态 | 判定规则 |
|------|---------|
| `bear_steepener` | Δ5d(10Y) > +3bps **且** Δ5d(10Y) − Δ5d(2Y) > +3bps（长端涨更快） |
| `bull_steepener` | Δ5d(2Y) < −3bps **且** Δ5d(2Y) − Δ5d(10Y) < −3bps（短端跌更快） |
| `bear_flattener` | Δ5d(2Y) > +3bps **且** Δ5d(2Y) − Δ5d(10Y) > +3bps（短端涨更快） |
| `bull_flattener` | Δ5d(10Y) < −3bps **且** Δ5d(10Y) − Δ5d(2Y) < −3bps（长端跌更快） |
| `neutral` | 以上均不满足 |

#### C. 信用利差 Risk-off（`credit-risk.ts`）

```ts
// ─── src/analyzers/thresholds.ts ─────────────────
/** 跌破均线的偏离比例 */
export const CREDIT_BREACH_RATIO = 0.98;             // 比率 < MA20 × 0.98 → 跌破 2%
/** 均线窗口（交易日） */
export const CREDIT_MA_WINDOW = 20;
/** 连续确认天数 */
export const CREDIT_CONFIRM_DAYS = 2;
```

| 信号 | 判定规则 |
|------|---------|
| `risk_off` | HYG/IEF 或 LQD/IEF 比率 < 20 日均线 × 0.98 |
| `risk_off_confirmed` | 连续 2 个交易日满足 `risk_off` |
| `risk_on` | 以上均不满足 |

HYG/IEF 和 LQD/IEF **任一触发**即发出 Risk-off 警报。

#### D. 情绪综合信号（`sentiment-signal.ts`）

各指标标准化到 **0-100 分**（0 = 极度恐慌，100 = 极度贪婪），加权求和：

```ts
// ─── src/analyzers/thresholds.ts ─────────────────
/** VIX 标准化区间 */
export const VIX_FEAR_CEIL = 40;                     // VIX ≥ 40 → 0 分
export const VIX_GREED_FLOOR = 12;                   // VIX ≤ 12 → 100 分

/** MOVE 标准化区间 */
export const MOVE_FEAR_CEIL = 180;                   // MOVE ≥ 180 → 0 分
export const MOVE_GREED_FLOOR = 80;                  // MOVE ≤ 80 → 100 分

/** BTC ETF 7 日累计净流入标准化区间（单位：亿美元） */
export const ETF_FLOW_UPPER = 5;                     // ≥ +5 亿 → 100 分
export const ETF_FLOW_LOWER = -5;                    // ≤ -5 亿 → 0 分

/** BTC OI 7 日变化率标准化区间 */
export const OI_CHANGE_UPPER = 0.10;                 // ≥ +10% → 100 分
export const OI_CHANGE_LOWER = -0.10;                // ≤ -10% → 0 分

/** 各指标权重 */
export const SENTIMENT_WEIGHTS = {
  vix: 0.25,
  move: 0.15,
  fearGreed: 0.20,
  etfFlow: 0.20,
  oiChange: 0.20,
};

/** 情绪分档阈值 */
export const SENTIMENT_EXTREME_FEAR = 20;
export const SENTIMENT_FEAR = 40;
export const SENTIMENT_GREED = 60;
export const SENTIMENT_EXTREME_GREED = 80;
```

| 信号 | 综合分 |
|------|--------|
| `extreme_fear` | < 20 |
| `fear` | 20 - 40 |
| `neutral` | 40 - 60 |
| `greed` | 60 - 80 |
| `extreme_greed` | > 80 |

#### E. 信号冲突处理与综合研判（`jobs/pipeline.ts`）

> 在 pipeline 聚合阶段，将四个模块的独立信号合并为一个 `MarketBias` 结构，写入 `analysis_results` 表供 reporter 读取。

**三层优先级规则：**

```ts
// ─── src/analyzers/thresholds.ts ─────────────────
/**
 * 信号优先级（数字越大优先级越高）：
 * 1. 信用利差 Risk-off — 系统性风险最高优先级
 * 2. 流动性 + 收益率曲线 — 宏观方向
 * 3. 情绪 — 逆向参考辅助
 */
export const SIGNAL_PRIORITY = {
  credit: 3,    // 最高：risk_off_confirmed 时一票否决为 risk_off
  liquidity: 2,
  curve: 2,     // 与流动性同级，协同判断
  sentiment: 1, // 最低：仅作为逆向参考
};
```

**综合研判逻辑：**

1. **信用 Risk-off 一票否决：** 当 credit = `risk_off_confirmed` 时，overall_bias = `risk_off`，confidence = `high`
2. **流动性 × 曲线协同：**
   - 同向（如 expanding + bull_steepener）→ overall_bias = `risk_on`，confidence = `high`
   - 反向（如 expanding + bear_steepener）→ overall_bias = `conflicted`，confidence = `low`
   - 一方 neutral → 跟随另一方，confidence = `medium`
3. **情绪逆向修正：**
   - `extreme_fear` + 流动性 expanding → 附加 "超跌反弹机会" 标记
   - `extreme_greed` + 流动性 contracting → 附加 "风险过高" 标记
   - 其他组合不修正

**输出结构（写入 `analysis_results` 表，type = `market_bias`）：**

```ts
interface MarketBias {
  overall_bias: 'risk_on' | 'risk_off' | 'neutral' | 'conflicted';
  confidence: 'high' | 'medium' | 'low';
  signals: {
    liquidity: string;   // expanding | contracting | neutral
    curve: string;       // bear_steepener | bull_steepener | ...
    credit: string;      // risk_on | risk_off | risk_off_confirmed
    sentiment: string;   // extreme_fear | fear | neutral | greed | extreme_greed
  };
  conflicts: string[];   // 例如 ["流动性扩张与熊陡背离"]
  tags: string[];        // 例如 ["超跌反弹机会", "资金面偏紧"]
}
```

**Reporter 使用规则：**
- 日报逐一展示各模块信号，附具体数值
- "操作建议"部分基于 `overall_bias` + `confidence` 给出方向
- `confidence = low` 时，明确建议"观望，不宜加仓"
- `conflicts` 非空时，在报告中单独列出"信号分歧提示"段落

### 子任务 2：流动性数据采集模块 (The "Water" Monitor)

**目标：** 每日自动抓取美联储流动性数据并持久化。

**数据源：** 全部来自 FRED API（免费，1000 次/天）

| 指标 | FRED Series ID | 频率 | 说明 |
|------|---------------|------|------|
| 美联储总资产 | `WALCL` | 周频 | Federal Reserve Total Assets |
| TGA 账户余额 | `WTREGEN` | 周频 | Treasury General Account |
| ON RRP 余额 | `RRPONTSYD` | 日频 | Overnight Reverse Repurchase |
| SOFR 利率 | `SOFR` | 日频 | Secured Overnight Financing Rate |
| IORB 利率 | `IORB` | 日频 | Interest on Reserve Balances |
| EFFR 利率 | `FEDFUNDS` | 日频 | Effective Federal Funds Rate |

**开发任务：**

- [ ] 封装 FRED API 客户端（基于 fetch，带内存缓存 + 请求计数 + 重试）
- [ ] 实现 `LiquidityCollector`：抓取上述 6 个 series，计算净流动性和 SOFR-IORB 利差
- [ ] 计算 `Net Liquidity = Fed Total Assets - TGA - ON RRP`
- [ ] 计算 7 日滚动变化量
- [ ] 实现流动性方向信号判定（expanding / contracting / neutral）：从 DB 读取 `liquidity_snapshots` 表原始数据，阈值参见"分析逻辑量化定义 - A"，将结果写入 `analysis_results` 表
- [ ] node-cron 定时任务：每日 08:00 ET 自动采集（`src/jobs/scheduler.ts`）
- [ ] CLI 命令：`macro-sniper collect liquidity`、`macro-sniper liquidity`
- [ ] 编写 `scripts/backfill-fred.ts` 脚本回填 2 年历史数据：
  - 限速策略：每次请求间隔 1 秒，单日总请求不超过 500 次，预留配额给正常采集任务
  - 支持断点续传，记录已回填进度
  - **幂等性：upsert 策略** — 以 `(series_id, data_date)` 为唯一键，重复运行时覆盖旧数据而非报错
  - **复用 collector：** 回填脚本内部调用与每日采集相同的 `LiquidityCollector` / `BondsCollector` 写入函数，避免逻辑分叉

### 子任务 3：债市收益率曲线数据模块 (The "Pipe" Logic)

**目标：** 每日自动抓取国债收益率和信用利差，识别曲线形态。

**数据源：**

| 指标 | 来源 | 标识 | 说明 |
|------|------|------|------|
| 2Y 国债收益率 | FRED | `DGS2` | 免费 |
| 10Y 国债收益率 | FRED | `DGS10` | 免费 |
| 20Y 国债收益率 | FRED | `DGS20` | 免费 |
| 30Y 国债收益率 | FRED | `DGS30` | 免费 |
| 10s2s 利差 | FRED | `T10Y2Y` | FRED 预计算 |
| HYG / LQD / IEF 价格 | Yahoo Finance | `yahoo-finance2` 库 | 免费，无需 Key |

**开发任务：**

- [ ] 实现 `BondsCollector`：抓取 4 条收益率 + 计算利差
- [ ] 实现收益率曲线形态分类（bear_steepener / bull_steepener / bear_flattener / bull_flattener / neutral）：从 DB 读取 `yield_snapshots` 表原始数据，阈值参见"分析逻辑量化定义 - B"，将结果写入 `analysis_results` 表
- [ ] 实现信用利差采集：yahoo-finance2 抓取 HYG、LQD、IEF 价格，计算 HYG/IEF 和 LQD/IEF 比率
- [ ] 计算 20 日移动均线，跌破均线触发 Risk-off 警报：从 DB 读取 `credit_snapshots` 表原始数据，阈值参见"分析逻辑量化定义 - C"，将结果写入 `analysis_results` 表
- [ ] node-cron 定时任务：收益率每日 17:30 ET，信用利差每日 17:45 ET（`src/jobs/scheduler.ts`）
- [ ] CLI 命令：`macro-sniper collect bonds`、`macro-sniper bonds regime`

### 子任务 4：BTC ETF 与情绪数据采集模块 (The "Vibe")

**目标：** 高频采集 BTC 相关数据和市场情绪指标。

**数据源：**

| 指标 | 来源 | API | 是否需要 Key | 风险 |
|------|------|-----|-------------|------|
| VIX 波动率 | FRED | `VIXCLS` | 需要（FRED Key） | 低 |
| MOVE 债市波动率 | Yahoo Finance | `^MOVE` (`yahoo-finance2`) | 不需要 | 低 |
| 恐惧贪婪指数 | alternative.me | REST API | 不需要 | 低 |
| BTC 价格 | Binance | `/api/v3/ticker/price` | 不需要（公共端点） | 低 |
| BTC ETF 净流入 | SoSoValue | HTTP | 不需要 | **中（非官方 API，可能变动）** |
| BTC 未平仓合约 | Binance Futures | `/fapi/v1/openInterest` | 不需要（公共端点） | 低 |
| SPY/QQQ/GLD 价格 | Yahoo Finance | `yahoo-finance2` | 不需要 | 低 |

**开发任务：**

- [ ] 实现 `SentimentCollector`：聚合 VIX、MOVE、恐惧贪婪指数、BTC 价格、ETF 流入、OI、权益代理
- [ ] BTC ETF 流入数据：对接 SoSoValue API，请求失败时记录错误日志并跳过本次采集
- [ ] BTC 价格 + OI 数据：对接 Binance 公共 API（`/api/v3/ticker/price` + `/fapi/v1/openInterest`），无需 API Key，带 3 次重试（指数退避），失败返回 null 不中断流水线
- [ ] 实现情绪综合信号判定（`src/analyzers/sentiment-signal.ts`）：从 DB 读取 `sentiment_snapshots` 表原始数据，标准化与权重参见"分析逻辑量化定义 - D"，将结果写入 `analysis_results` 表
- [ ] node-cron 定时任务：情绪数据每小时采集，BTC 数据每 15 分钟采集（`src/jobs/scheduler.ts`）
- [ ] CLI 命令：`macro-sniper collect sentiment`、`macro-sniper sentiment`

### 子任务 5：日报生成引擎

**目标：** 整合三个数据模块，使用 LLM 生成每日投研报告。

**日报格式约束：**

| 属性 | 日报（每日） | 深度研报（按需） |
|------|-------------|-----------------|
| 模型 | gemini-3.1-flash-lite-preview（快速，5 秒级） | claude-opus-4-6 |
| 目标长度 | ~800 字 | ~2000 字 |
| 语言 | 中文 | 中文 |
| 输出格式 | Markdown（含表格） | Markdown（含表格 + 图表描述） |
| 生成方式 | LLM 直接生成最终 Markdown 文本（不经 JSON 中间层） | 同左 |

**日报固定结构（Prompt 中约束）：**
1. **📊 市场总览** — 一段话概括当日整体立场（risk_on / risk_off / conflicted）
2. **💧 流动性研判** — 净流动性数值、7 日变化、方向信号、SOFR-IORB 利差
3. **📈 债市形态解读** — 10s2s 利差、曲线形态分类、含义解释
4. **🔗 信用风险** — HYG/IEF、LQD/IEF 比率及均线关系
5. **₿ BTC 与情绪** — ETF 流入、OI、恐惧贪婪指数、情绪综合分
6. **⚠️ 信号分歧提示** — 仅当 `conflicts` 非空时出现
7. **🎯 操作建议** — 基于 overall_bias + confidence 给出方向，confidence=low 时建议观望
8. **📋 数据附录** — 关键数值汇总表格

> 若存在 stale 数据，在对应章节开头标注"⚡ 以下信号基于非最新数据（数据源：xxx，最后更新：xxx）"。

**开发任务：**

- [ ] 设计日报 Prompt 模板（按上述固定结构，注入流动性信号、收益率曲线形态、BTC ETF 动态作为上下文）
- [ ] 实现报告生成 pipeline（`src/reporters/pipeline.ts`）：从 `analysis_results` 表读取当日全部信号（含 `market_bias` 综合研判）→ 组装上下文 → 通过 `@mariozechner/pi-ai` 调用 LLM → 写入 `reports` 表（不 import analyzers，完全通过 DB 解耦）
- [ ] 报告内容包含：市场总览、流动性研判、债市形态解读、BTC/情绪信号、信号分歧提示（如有）、风险提示、操作建议（基于 `overall_bias` + `confidence`，参见"分析逻辑量化定义 - E"）
- [ ] 使用 gemini-3.1-flash-lite-preview 生成日报（快速、低成本），claude-opus-4-6 生成深度研报（均通过 pi-ai 统一调用，支持自定义模型定义）
- [ ] node-cron 定时任务：每日 06:00 ET 自动生成（`src/jobs/scheduler.ts`）
- [ ] 通知推送：日报生成后优先通过 Slack Bot Token 直推（`src/notifications/slack.ts`），自动将 Markdown 转换为 Slack mrkdwn 格式；Slack 直推未配置时兜底写入 mom event JSON（`src/notifications/mom-events.ts`）
- [ ] CLI 命令：`macro-sniper report today`、`macro-sniper report generate`

---

### CLI 命令汇总

所有交互通过 CLI 完成，CLI 是第一阶段的唯一用户入口：

```bash
# ─── 数据采集（collectors → DB） ──────────────────
macro-sniper collect liquidity    # 采集流动性数据
macro-sniper collect bonds        # 采集债市数据
macro-sniper collect sentiment    # 采集情绪数据
macro-sniper collect all          # 采集全部数据

# ─── 信号分析（DB → analyzers → DB） ─────────────
macro-sniper analyze              # 运行全部分析引擎，结果写入 DB
macro-sniper analyze liquidity    # 只分析流动性信号
macro-sniper analyze bonds        # 只分析收益率曲线
macro-sniper analyze sentiment    # 只分析情绪信号

# ─── 数据查询（读 DB） ───────────────────────────
macro-sniper liquidity             # 查看最新流动性数据 + 信号
macro-sniper bonds regime          # 查看当前收益率曲线形态
macro-sniper sentiment             # 查看最新情绪数据

# ─── 日报（DB → reporters → DB → mom event → Slack）─
macro-sniper report today          # 查看今日日报
macro-sniper report generate       # 手动触发日报生成 + 写 mom event 推送

# ─── 完整流水线 ──────────────────────────────────
macro-sniper run                   # 一键执行：collect → analyze → report → notify

# ─── 定时任务 ─────────────────────────────────────
macro-sniper jobs start            # 前台启动 node-cron 调度循环（生产环境用 pm2/systemd 守护）
macro-sniper jobs status           # 查看任务执行记录（读 job_runs 表）
macro-sniper jobs stop             # 停止调度进程（SIGTERM）
```

> **定时任务执行顺序：** `collectors` → `analyzers` → `reporters` → `notifications`，由 `jobs/pipeline.ts` 通过 async/await 串行保证先后依赖，每步执行结果记录到 `job_runs` 表。

### 通知推送（Slack 直推 + mom 兜底）

macro-sniper 支持两种 Slack 推送方式，按优先级自动选择：

1. **Slack Bot Token 直推（优先）：** 通过 `chat.postMessage` API 直接发送到 Slack 频道，无外部依赖，配置 `SLACK_BOT_TOKEN` + `SLACK_CHANNEL_ID` 即可。发送前自动将 Markdown 转换为 Slack mrkdwn 格式（标题加粗、表格转 key-value 列表）。
2. **Mom events 兜底：** 当 Slack 直推未配置时，回退到向 mom `events/` 目录写 JSON 文件，由 mom 转发至 Slack Channel。

**推送优先级逻辑（`src/jobs/scheduler.ts`）：**

```ts
// 优先 Slack 直推
if (config.SLACK_BOT_TOKEN && config.SLACK_CHANNEL_ID) {
  notified = await postToSlack(content, { botToken, channelId });
}
// 兜底 Mom events
if (!notified && config.MOM_EVENTS_DIR && config.MOM_CHANNEL_ID) {
  notifyViaMom(content, `daily-report-${today}`, { eventsDir, channelId });
}
```

**Markdown → Slack mrkdwn 转换（`src/notifications/slack-format.ts`）：**

| Markdown | Slack mrkdwn |
|----------|-------------|
| `# 标题` / `## 标题` | `*标题*`（粗体） |
| `**加粗**` | `*加粗*` |
| `* 列表项` | `•  列表项` |
| `\| 表格 \|` | `•  *列名*:  值 — 备注`（key-value 列表） |
| `---` | `─` 分隔线 |

**推送场景：**

| 触发时机 | 内容 |
|---------|------|
| 每日 06:00 ET 日报生成后 | 日报全文（mrkdwn 格式） |
| 风险预警（HYG/IEF 跌破均线、流动性骤变等） | 预警摘要 + 关键数值 |

**mom skill 集成（可选）：**

在 mom 的 skills 目录创建 `macro-sniper/SKILL.md`，让用户可以在 Slack 中直接与 macro-sniper 交互：

```markdown
---
name: macro-sniper
description: 查询宏观流动性、债市、BTC 情绪数据及投研日报
---

# Macro Sniper Skill

## 使用方式

查看最新流动性数据：
\`\`\`bash
macro-sniper liquidity
\`\`\`

查看收益率曲线形态：
\`\`\`bash
macro-sniper bonds regime
\`\`\`

查看情绪数据：
\`\`\`bash
macro-sniper sentiment
\`\`\`

查看今日日报：
\`\`\`bash
macro-sniper report today
\`\`\`

手动触发日报生成：
\`\`\`bash
macro-sniper report generate
\`\`\`

一键执行完整流水线：
\`\`\`bash
macro-sniper run
\`\`\`
```

> 用户在 Slack 中 @mom "现在流动性怎样？" → mom 读取 skill → 执行 `macro-sniper liquidity` → 将结果回复到 Slack。

### 第一阶段整体验证方式

- 通过 CLI 命令验证完整工作流（数据采集 → 存储 → 分析 → 日报生成 → mom event → Slack 推送）
- 通过 `vitest` 运行单元测试和集成测试

---

## 数据源 API Key 汇总

第一阶段所需的全部 API Key：

| API | 用途 | 申请地址 | 费用 | 必需 |
|-----|------|---------|------|------|
| **FRED API** | 流动性 + 收益率 + VIX 等宏观数据 | https://fred.stlouisfed.org/docs/api/api_key.html | 免费（1000 次/天） | 是 |
| **Google Gemini** | 默认快速 LLM（日报生成） | https://aistudio.google.com/apikey | 免费 tier 可用 | 推荐 |
| **Anthropic Claude** | 深度研报 / LLM 备选 | https://console.anthropic.com | 按量付费 | 否（可选） |
| **Slack Bot Token** | 日报直推 Slack 频道 | Slack App 管理后台 | 免费 | 推荐 |
| **Binance** | BTC 价格 + 期货 OI（公共端点无需 Key；Key 预留第三阶段交易执行） | https://www.binance.com/en/binance-api | 免费 | 否（第三阶段） |
| **Polygon.io** | 美股数据（备用） | https://polygon.io | 免费 tier | 否（可选） |

> **无需 API Key 的数据源：** Yahoo Finance (`yahoo-finance2`，含 HYG/LQD/IEF/SPY/QQQ/GLD/^MOVE)、Fear & Greed Index (`alternative.me`)、Binance 公共 API（BTC 现货价格 + 期货 OI）、SoSoValue（HTTP 请求）。
>
> **Binance 公共 API 说明：** 现货价格 (`/api/v3/ticker/price`) 和期货 OI (`/fapi/v1/openInterest`) 均为公共端点，无需 API Key，无严格限流。替代了此前的 CoinGecko（BTC 价格）和 Coinglass（BTC OI）依赖，减少两个外部 Key 的配置需求。
>
> **yahoo-finance2 风险提示：** 该库为非官方实现，通过抓取 Yahoo Finance 数据工作，稳定性不及 FRED 等官方 API。若 Yahoo 变更接口可能导致采集失败，需做好容错处理。

### 环境变量配置参考

```env
# ─── 必须 ─────────────────────────────────────────
FRED_API_KEY=your_fred_api_key_here

# ─── Slack 直推（优先推送方式） ───────────────────
SLACK_BOT_TOKEN=xoxb-...
SLACK_CHANNEL_ID=C0XXXXXXX

# ─── Mom 兜底（Slack 直推不可用时） ──────────────
MOM_EVENTS_DIR=/path/to/mom/data/events
MOM_CHANNEL_ID=C0XXXXXXX

# ─── LLM API Key（至少配置一个） ─────────────────
GEMINI_API_KEY=                        # 推荐，默认快速模型使用 Gemini
ANTHROPIC_API_KEY=sk-ant-...           # 可选，pi-ai 自动从环境变量检测

# ─── 可选（数据源 + 交易执行） ───────────────────
BINANCE_API_KEY=                       # 预留第三阶段交易执行（数据采集无需 Key）
POLYGON_API_KEY=

# ─── 数据库 ───────────────────────────────────────
DATABASE_PATH=./data/macro-sniper.db

# ─── LLM 配置 ─────────────────────────────────────
LLM_MODEL_HEAVY=claude-opus-4-6             # 深度研报
LLM_MODEL_FAST=gemini-3.1-flash-lite-preview # 日报（快速，5 秒级生成）
LLM_FALLBACK_MODEL=gemini-2.5-flash         # 主模型不可用时的 fallback
LLM_TEMPERATURE=0.1

# ─── 应用 ─────────────────────────────────────────
APP_ENV=development
LOG_LEVEL=info                         # pino 日志级别：trace/debug/info/warn/error/fatal
```
