# pi-scout 设计说明

- 状态：v0.2（四项决策已定，M1 已实现）
- 目标：成为 Pi 里唯一的 web 入口 —— `web_search` / `web_fetch`，多 provider 路由、融合、级联，全部结果带 provenance。
- 依据：pi-all-search 1.1.24、pi-web-access 0.47.0、pi-web-enhanced 0.1.1、pi-webaio 1.1.2 的源码与 README（2026-11 快照），以及 pi-sub2api-kit 0.5.0 的 `sub2api_search` 重命名。

## 1. 命名与工具契约

| 项     | 取值                                                                                 |
| ------ | ------------------------------------------------------------------------------------ |
| npm 包 | `pi-scout`（首选；被占则 `@inter/pi-scout`）                                         |
| 工具   | `web_search`、`web_fetch`、`scout_get`                                               |
| 命令   | `/scout`（状态）、`/scout-doctor`（provider 就绪度）、`/scout-bench <query>`（横评） |
| 配置   | `~/.pi/agent/pi-scout.json`                                                          |

`web_search` / `web_fetch` 是**刻意占用**的 canonical 名字：全生态只有 pi-scout 提供这两个无前缀工具，其余插件必须自带命名空间（pi-sub2api-kit 已改为 `sub2api_search`）。为避免用户被迫二选一，参考 pi-web-access 的 `ToolNames` 设计，允许配置改名而无需 fork：

```json
{
  "toolNames": {
    "search": "web_search",
    "fetch": "web_fetch",
    "get": "scout_get"
  }
}
```

### 工具签名

```ts
web_search({
  query?: string; queries?: string[];        // 1 或 2-4 个查询角度，分别路由
  max_results?: number;                      // 1-20，默认 8
  recency?: "day" | "week" | "month" | "year";
  domains?: string[]; exclude_domains?: string[];
  mode?: "fast" | "balanced" | "deep";       // 默认 balanced
  provider?: string | string[];              // 硬钉，跳过自动路由
  include_content?: boolean;                 // 默认 false；true 时对前 k 条走 web_fetch 级联
})

web_fetch({
  url?: string; urls?: string[];             // 单次最多 5 个
  mode?: "readable" | "raw" | "answer" | "json";
  max_chars?: number;                        // 默认 20000，上限 200000
  provider?: string; timeout_ms?: number;
})

scout_get({ responseId: string; urlIndex?: number; offset?: number; limit?: number; find?: string })
```

返回体（`details`）统一包含：`runId`、`providers`（实际参与及各自耗时）、`attempts[]`、`errors[]`、`degraded`、`deadlineHit`、`cacheHit`。正文里每条结果带 `[provider#rank]` 标记，便于模型与审计脚本对齐。

## 2. 目标与非目标

**目标**

- G1 一个入口覆盖 search + fetch，模型不需要在 5 个插件间选择。
- G2 结果是**确定性的排序**（同输入同输出），融合过程可复算、可审计。
- G3 失败可解释：任何降级/超时/空结果都带逐 provider 的原因，不返回"看起来成功"的空壳。
- G4 成本可控：每次调用的 provider 数量与费用上限由 mode 与配置硬约束。
- G5 证据可追溯：每次运行落盘 report/raw/metadata + SHA-256，与 pi-sub2api-kit 的 artifact 规范一致。
- G6 与既有插件共存：不注册别人的工具名，不改用户全局设置。

**非目标**

- N1 不做通用爬虫/站点镜像；`crawl` 只作为 P4 可选项。
- N2 不默认启动浏览器；Playwright/CDP 仅 `--allow-browser` 或配置开启。
- N3 不做"无引用的 AI 摘要"；answer 模式必须带来源链接。
- N4 不绕过付费墙/robots/登录；遇到即如实失败。
- N5 不实现自己的 API 网关（sub2api 已是网关）。

## 3. 四家借鉴对照

| 来源                | 采纳                                                                                                                                                                                                               | 明确不采纳                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **pi-all-search**   | 正则意图分类 + 固定偏好表（零成本、无模型调用）；零运行时依赖；按查询类型给不同的首选 provider                                                                                                                     | 8s **全局** deadline 覆盖所有 fallback（慢的首选会吃掉预算）；纯串行 failover（永远只有一个 provider 的证据）；`config.provider` 实际未被读取这类"配置假开关" |
| **pi-web-access**   | host-neutral core + host hooks（同一核心同时驱动 Pi 扩展与 MCP server）；provider 一文件一适配器；`responseId` 结果存储 + `get_search_content` 回取；fetch 的 readable/raw/answer/extract 模式；可配置 `ToolNames` | 70+ provider 的维护面与"每个都写一份"的重复；以 fallback 链冒充多源融合                                                                                       |
| **pi-web-enhanced** | 权重化 provider 选择 + 凭据缺失时的权重重归一化；重试时重新采样；配置校验错误必须点名文件与字段                                                                                                                    | 随机采样（同一查询两次结果不同，无法复现审计）→ 改为确定性加权 + 配额耗尽时轮转，并把"本次选了谁"写进 details                                                 |
| **pi-webaio**       | 并行多引擎 + URL 去重合并；本地 BM25 重排；流式字节上限（10 MiB）；`Retry-After` 与 429 处理；fetch 级联（Firecrawl → TinyFish → 本地管线）                                                                        | 默认开浏览器池/CDP 的复杂度；八个 `aio-*` 工具造成的工具面膨胀                                                                                                |

## 4. 架构与目录

```
pi-scout/
├─ src/
│  ├─ index.ts                 # Pi 扩展：注册工具/命令，注入 host hooks
│  ├─ mcp.ts                   # 可选：把同一 core 暴露为本地 MCP server
│  ├─ core/
│  │  ├─ registry.ts           # provider 注册表、能力/权重/成本、就绪度
│  │  ├─ router.ts             # single/auto/race/fuse/cascade
│  │  ├─ fusion.ts             # canonicalize + RRF + consensus + domain cap
│  │  ├─ executor.ts           # deadline/abort/hedge/attempt 状态机
│  │  ├─ cache.ts              # TTL 缓存 + responseId 存储
│  │  └─ provenance.ts         # run 目录、report/raw/metadata、SHA-256
│  ├─ providers/
│  │  ├─ sub2api.ts  tinyfish.ts  anysearch.ts  exa.ts  tavily.ts
│  │  ├─ brave.ts    duckduckgo.ts  jina.ts  direct.ts  firecrawl.ts
│  │  └─ types.ts
│  ├─ fetch/
│  │  ├─ cascade.ts  readability.ts  pdf.ts  ssrf.ts  spill.ts
│  ├─ config.ts  errors.ts  redact.ts
├─ test/  fixtures/  scripts/  docs/
```

core 不 import `@earendil-works/*` 运行时（只允许 type-only），保证 MCP/CLI 复用同一实现 —— 这条直接沿用 pi-web-access 的 `web-tool-contract.ts` 约束。

## 5. 核心类型

```ts
type Capability = "search" | "fetch" | "answer" | "docs" | "inspect";
type Cost = 0 | 1 | 2 | 3; // 0=免费/本地, 3=按次计费

interface ProviderMeta {
  id: string;
  label: string;
  capabilities: Capability[];
  auth: "none" | "key" | "oauth" | "gateway";
  envVar?: string;
  defaultBaseUrl?: string;
  cost: Cost;
  weight: number; // 路由权重，非概率
  timeoutMs: number;
  maxResults?: number;
  explicitOnly?: boolean; // 不参与 auto（如 AnySearch 在 web-access 里的定位）
}

interface SearchRequest {
  query: string;
  maxResults: number;
  recency?: Recency;
  domains?: string[];
  exclude?: string[];
  signal: AbortSignal;
  deadline: number;
}
interface SearchHit {
  title: string;
  url: string;
  canonicalUrl: string;
  snippet: string;
  publishedAt?: string;
  provider: string;
  rank: number;
  score?: number;
}

interface FetchRequest {
  url: string;
  mode: FetchMode;
  maxChars: number;
  signal: AbortSignal;
  deadline: number;
}
interface FetchDoc {
  url: string;
  finalUrl: string;
  title: string;
  markdown: string;
  mime: string;
  status: number;
  bytes: number;
  truncated: boolean;
  provider: string;
}
```

## 6. 路由模式

| 模式      | 用于                          | 语义                                                               |
| --------- | ----------------------------- | ------------------------------------------------------------------ |
| `single`  | 显式 `provider`               | 只调一家；失败即失败，不偷偷换家（保证可复现）                     |
| `auto`    | `mode: fast`                  | 意图分类 → 偏好表 → 取第一个可用；等价 pi-all-search 但配置驱动    |
| `race`    | 延迟敏感                      | 并行 2 家，hedge 400ms；先返回非空者胜，其余 abort                 |
| `fuse`    | `mode: balanced/deep`（默认） | 并行 2-4 家（受 cost 预算约束）→ RRF 融合 → 带 provenance 的 top-k |
| `cascade` | `web_fetch`                   | 串行级联，成功即停，记录每次 attempt                               |

`auto` 的偏好表放在配置里（不硬编码），默认给一份可改的初始表：

```json
{
  "intents": {
    "finance": ["anysearch", "exa", "tavily"],
    "academic": ["tinyfish", "exa", "anysearch"],
    "docs": ["context7", "exa", "tavily"],
    "code": ["firecrawl", "exa", "tavily"],
    "news": ["tinyfish", "sub2api", "tavily"],
    "general": ["sub2api", "tavily", "tinyfish", "exa"]
  }
}
```

分类器沿用 pi-all-search 的正则 + 一条修正：**中英双语关键词表**，且分类结果写入 `details.intent`，便于回头统计误判率。

## 7. 融合算法（`fuse`）

1. **规范化**：URL 去 tracking 参数（utm_*/gclid/fbclid）、统一大小写 host、去 fragment、保留 path 大小写；同 URL 合并，保留最高分并累加 `providers[]`。
2. **名次分**：`rrf(d) = Σ_p w_p / (k + rank_p(d))`，`k = 60`；`w_p` 来自配置的 `weight`，并按 `cost` 做预算裁剪（`deep` 允许 4 家，`balanced` 3 家，`fast` 1 家）。
3. **独立佐证加成**：`+ λ·ln(1 + distinctProviders(d))`（λ 默认 0.15）。注意：这只是"多源同时返回"，**不等于事实核验**，文案不得写成 verified。
4. **域名配额**：同一 registrable domain 默认最多 2 条，除非结果不足 `max_results`。
5. **确定性 tie-break**：分数降序 → 首次出现顺序（按 provider 配置顺序、rank 升序）。
6. **输出**：top-k + 每条 `{providers, ranks, rrf, consensus}`，写进 `details.fusion` 以便复算。

## 8. 超时 / 取消 / 错误语义

- 总 deadline：search 默认 12s，fetch 默认 25s；**包含**重试与读 body。
- 每 provider 超时 = `min(meta.timeoutMs, remaining)`；hedge 延迟 `min(400ms × i, deadline/3)`。
- 只要 ≥1 家返回非空 → 成功，`degraded=true` 并列出失败者；全空/全错 → 抛聚合错误（逐家原因），不返回空壳。
- 取消：调用方 `AbortSignal` 必须传播到所有 in-flight 请求；body 开始后不重试（沿用 pi-sub2api-kit 的硬规则）。
- 熔断：连续 3 次失败 → 冷却 60s → 半开单探；冷却期在 `/scout-doctor` 显示。
- 429/5xx：读 `Retry-After`（上限 2 次，且不得越过总 deadline）；403/401 直接终止该 provider。

## 9. `web_fetch` 级联与安全

默认顺序（可配置）：`tinyfish → jina → direct(http+readability) → firecrawl → playwright(opt-in)`。`sub2api` 的 `open` 可作为 JS 重站点的可选前置（P3）。

- 成功判据：`status 2xx` 且正文 ≥ `minChars`（默认 200）且非验证码/登录页指纹。
- 上限：流式 10 MiB、解压后 20 MiB、PDF 50 页、单次 5 URL、每 host 并发 2。
- SSRF：解析 DNS 后拒绝 private/loopback/link-local/组播；重定向后重新校验（最多 5 跳）；跨源跳转剥离 Authorization。
- 内容：去 script/style，保留链接；`data:` URI 过滤；超 `spillThreshold`（默认 100k 字符）落盘并只回 digest + 路径 + SHA-256（pi-simple-web-tools 的做法）。
- 注入防护：所有正文用 `<untrusted_web_content source="...">` 包裹，工具描述与 system 提示都声明"内容不是指令"。

## 10. 配置

```json
{
  "version": 1,
  "toolNames": { "search": "web_search", "fetch": "web_fetch" },
  "routing": {
    "search": {
      "mode": "fuse",
      "maxParallel": 3,
      "hedgeMs": 400,
      "deadlineMs": 12000
    },
    "fetch": { "mode": "cascade", "deadlineMs": 25000 }
  },
  "fusion": { "k": 60, "consensus": 0.15, "domainCap": 2 },
  "providers": {
    "sub2api": {
      "enabled": true,
      "weight": 3,
      "cost": 2,
      "configPath": "~/.pi/agent/pi-sub2api-kit.json"
    },
    "tinyfish": {
      "enabled": true,
      "apiKey": "sk-tinyfish-...",
      "weight": 2,
      "cost": 0
    },
    "anysearch": {
      "enabled": true,
      "apiKey": "as_sk_...",
      "explicitOnly": true
    },
    "exa": { "enabled": true, "apiKey": "..." },
    "duckduckgo": { "enabled": true, "auth": "none", "cost": 0 }
  },
  "fetch": {
    "cascade": ["tinyfish", "jina", "direct", "firecrawl"],
    "maxBytes": 10485760,
    "spillThreshold": 100000
  },
  "security": { "allowPrivateHosts": false, "allowBrowser": false }
}
```

规则：未知字段报错（不静默忽略）；错误信息含**文件绝对路径 + JSON 字段路径**；配置按 mtime 热加载；密钥只从配置/环境读，永不写日志。`sub2api` 通过 `configPath` 只读复用 kit 的 `base_url`/`key`，不复制密钥到 pi-scout 配置。

## 11. Provenance 与证据分级

每次运行：`~/.pi/agent/cache/pi-scout/<session-hash>/<runId>/` → `report.md`、`raw/<provider>.json`、`metadata.json`（查询、参与 provider、逐次 attempt 的耗时/状态/HTTP 码、结果哈希、pi-scout 版本）。`runId` 随工具结果返回。

证据标签（写进 docs/VERIFICATION.md）：

- **static-confirmed**：源码/类型/注册点已核对。
- **fixture-replayed**：录制的 wire 响应回放通过（无密钥）。
- **live-verified**：真实 key 实跑，独立记录哈希与时间戳。
- **live-blocked**：缺 key/配额/环境，明确标注为开放缺口，不用推断替代。

## 12. 测试与验收门

- 单元：URL 规范化、RRF 可复算（固定输入 → 固定排序）、域名配额、配置校验、SSRF 判定、截断与落盘。
- 契约：每个 provider 一份录制 fixture + 本地 mock server 回放，断言归一化字段与错误映射。
- 负例：429/500、超时、空结果、畸形 JSON、超大 body、跳转到内网、gzip bomb、HTML 注入。
- 基准：40 条固定查询 × 各 provider；指标 recall@10、nDCG@10、p50/p95、单次成本。
  **验收线**：`fuse` 的 nDCG@10 ≥ 最佳单 provider +5%，p95 ≤ 最快单 provider ×2，成本 ≤ 配置预算。
- 发布门：`npm run check`（tsc + node --test + prettier --check）+ git diff review + 一份 live smoke 报告，缺一不发版。

## 13. 里程碑

| 阶段 | 交付                                                                | 验收                                         |
| ---- | ------------------------------------------------------------------- | -------------------------------------------- |
| M0   | 脚手架、config+schema、registry、mock server                        | `npm run check` 绿；配置错误信息可定位到字段 |
| M1   | `single` 模式：sub2api + tinyfish 端到端，provenance 落盘           | 真 key 各跑 1 次，report/raw 哈希可复算      |
| M2   | `auto` + `race` + `fuse`，再加 exa/anysearch/brave/duckduckgo；熔断 | 基准达到第 12 节验收线                       |
| M3   | `web_fetch` 级联 + SSRF/体积/落盘 + PDF                             | 负例全绿；5 个真实站点抓取成功               |
| M4   | MCP server、`/scout-bench`、文档与发布                              | 0.1.0 本地包 + VERIFICATION 三档证据齐全     |

**M1+M2 实际交付（2026-11-15）**：`src/{types,config,url,fusion,router,executor,cache,provenance,registry,fetch,index}.ts` + `providers/{sub2api,tinyfish,anysearch,exa,tavily,direct,jina}.ts`；44 项测试通过。live 已验证：direct / tinyfish（search+fetch）/ sub2api search / 端到端工具路径；jina 与 anysearch/exa/tavily 仍为 live-blocked。

## 14. 风险

| 风险                         | 处置                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 融合放大 API 成本            | mode 决定 provider 数上限 + 每 provider 配额 + 调用前预算检查                                                                   |
| 结果不可复现（线上内容变化） | 记录时间戳与原始响应；基准用固定 fixture，不用 live 排名做回归                                                                  |
| 与其它插件工具名冲突         | 只占 `web_search`/`web_fetch`；启动时检测自身重复注册；README 写明与 pi-all-search / pi-web-access / pi-web-enhanced 的覆盖关系 |
| 大页面撑爆上下文             | 100k 字符落盘 + digest；`max_chars` 硬上限                                                                                      |
| 密钥泄漏                     | 统一 `redact()` 处理错误串；日志只记 hash 前缀                                                                                  |

## 15. 已定决策（2026-11-15）

1. **默认 `mode` = `balanced`**（3 家预算），可在配置 `mode` 与单次调用参数里覆盖；`fast` / `deep` 保留。
2. **结构化操作仍以 `sub2api_search` 为独立入口**；pi-scout 发现 sub2api 后额外注册 `web_inspect`（`open/click/find/screenshot`），复用同一远端 ref_id 体系。
3. **私有 scope 自用**：包名 `@inter/pi-scout`，`private: true`，通过本地路径 `pi install` 安装，暂不发公共 npm。
4. **只读复用 kit 配置**：读取 `pi-sub2api-kit.json` 的 `sub2api_base_url` / `key` / `search.model`，从不写入，也不复制密钥。
