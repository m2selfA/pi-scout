# pi-scout

Pi 的统一 web 入口：`web_search` + `web_fetch` + `web_inspect`，多 provider 路由、融合、级联，结果带 provenance。

- 版本：0.6.1（Brave / DuckDuckGo / Firecrawl 后端；GitHub 搜索与抓取、PDF 抽取、重定向 SSRF 复核、40 条横评）
- 包名：`@inter/pi-scout`（暂不发布 npm，仅 GitHub 公开仓库）
- 设计文档：`docs/DESIGN.md`

## 安装（本地，不发布）

```powershell
pi install E:\inter\Documents\Repos\pi-scout
```

只试用一次、不改全局 settings：

```powershell
pi -e E:\inter\Documents\Repos\pi-scout
```

本包**没有**替代你执行 `pi install`；上面的命令需要你自己运行。

## 工具

| 工具          | 作用                                                                                           |
| ------------- | ---------------------------------------------------------------------------------------------- |
| `web_search`  | 意图路由 + 多 provider 融合（默认 `balanced`，3 家预算），返回带 provider 归属的摘要结果       |
| `web_fetch`   | 按 `fetch.cascade` 级联抓取（默认 direct → tinyfish → jina），返回 digest + 正文；超长自动落盘 |
| `web_inspect` | **仅当发现 sub2api 时注册**：`open` / `click` / `find` / `screenshot`，沿用远端 ref_id         |

工具名可通过 `toolNames` 配置改名，不需要 fork。

命令：`/scout`、`/scout-doctor` 查看状态与 provider 就绪度；**`/scout-reload`** 重新读取配置文件并重建 provider 注册表——改 key/代理/provider 开关后不必重启 Pi（改工具名或改代码仍需重启）；**`/scout-bench`** 跑 40 条固定查询横评（默认 dry-run，加 `--confirm` 才执行，`--providers=exa,tavily --limit=8` 可收窄）。

## 配置

默认路径 `~/.pi/agent/pi-scout.json`（可用 `PI_SCOUT_CONFIG` 覆盖）。文件不存在时使用默认值；字段非法时报错会带上**文件路径 + 字段路径**，不会静默忽略。

```json
{
  "version": 1,
  "mode": "balanced",
  "toolNames": {
    "search": "web_search",
    "fetch": "web_fetch",
    "inspect": "web_inspect"
  },
  "routing": {
    "search": {
      "mode": "fuse",
      "maxParallel": 3,
      "hedgeMs": 400,
      "deadlineMs": 12000
    },
    "fetch": { "mode": "cascade", "deadlineMs": 25000 },
    "intents": { "news": ["tinyfish", "sub2api", "tavily"] }
  },
  "fusion": { "k": 60, "consensus": 0.15, "domainCap": 2 },
  "providers": {
    "sub2api": {
      "enabled": true,
      "weight": 3,
      "cost": 2,
      "configPath": "C:\\Users\\you\\.pi\\agent\\pi-sub2api-kit.json"
    },
    "tinyfish": { "enabled": true, "apiKey": "sk-tinyfish-..." },
    "anysearch": {
      "enabled": true,
      "apiKey": "as_sk_...",
      "explicitOnly": true
    },
    "exa": { "enabled": true, "apiKeyEnv": "EXA_API_KEY" },
    "tavily": { "enabled": true, "apiKeyEnv": "TAVILY_API_KEY" },
    "github": {
      "enabled": true,
      "apiKey": "ghp_..."
    },
    "jina": { "enabled": true, "apiKeyEnv": "JINA_API_KEY", "proxy": "auto" },
    "vercel": {
      "enabled": true,
      "apiKeyEnv": "AI_GATEWAY_API_KEY",
      "model": "deepseek/deepseek-v4.1-flash"
    },
    "direct": { "enabled": true, "proxy": "none" }
  },
  "network": {
    "proxies": ["http://127.0.0.1:7890", "http://proxy.example:3128"],
    "strategy": "direct-first",
    "cooldownMs": 60000,
    "routeTimeoutMs": 8000
  },
  "fetch": {
    "cascade": ["direct", "tinyfish", "jina", "firecrawl"],
    "minChars": 200,
    "maxChars": 20000,
    "maxBytes": 10485760,
    "spillThreshold": 100000
  },
  "security": { "allowPrivateHosts": false }
}
```

### Key 与代理

**Key**：每个 provider 支持两种写法，二选一即可。

- `"apiKey": "..."` —— 直接写进配置文件（Pi 进程读不到你的 shell 环境变量时用这个）；
- `"apiKeyEnv": "EXA_API_KEY"` —— 运行时从环境变量读，密钥不落盘。**这里填变量名；实际 key 应填 `apiKey`。**

**代理**：`network.proxies` 是**有序**列表，按顺序 fallback；`network.strategy` 决定先走谁：

| strategy               | 顺序                                     |
| ---------------------- | ---------------------------------------- |
| `direct-first`（默认） | 直连 → 代理1 → 代理2 …                   |
| `proxy-first`          | 代理1 → 代理2 … → 直连                   |
| `proxy-only`           | 只走代理（至少配一条，否则配置直接报错） |
| `direct-only`          | 忽略代理列表                             |

- GitHub 代码索引较慢（个别查询 >12 s）。如果常用 code 搜索，把 `routing.search.deadlineMs` 提到 20000，或只固定 `provider: "github"` 单独调用。
- `routeTimeoutMs`：**单条线路**的连接/首字节超时（默认 8s）。直连被墙时不会一直等到 provider 总超时，会快速切到下一条线路。
- `cooldownMs`：某条代理出现网络层失败后进入冷却（默认 60s），期间跳过，冷却结束自动重试。
- 只有**网络层错误**（ENOTFOUND / ECONNREFUSED / ECONNRESET / TLS 等）才触发 fallback；目标返回 4xx/5xx 属于正常响应，不会换代理重发。
- provider 级覆盖：`"proxy": "auto"`（跟随全局）、`"none"`（只直连）、或写死某条代理 URL。

### 与 pi-sub2api-kit 的关系

- **只读复用**：pi-scout 读取 `pi-sub2api-kit.json` 的 `sub2api_base_url` / `key` / `search.model`，从不写入。
- kit 的工具已改名为 `sub2api_search`（0.5.0），因此两者可同时加载，不会互相覆盖 `web_search`。
- 结构化操作（open/click/find/screenshot）**仍以 `sub2api_search` 为独立入口**；pi-scout 在发现 sub2api 后额外提供 `web_inspect` 以便在同一条工作流里继续。

## 路由与融合

- 意图分类：中英双语正则，6 类（finance / academic / docs / code / news / general）。
- 候选排序：意图偏好表（可配置）→ 其余按 id 排序；`explicitOnly` 的 provider 永不参与自动路由。
- 预算：`fast`=1 家、`balanced`=3 家、`deep`=4 家，且不超过 `routing.search.maxParallel`。
- 融合：`score = Σ w_p / (k + rank_p) + λ·ln(1 + 独立 provider 数)`，随后按 registrable domain 限流（默认同域 2 条，不足时回填并记录 `domainCappedOut`）。
- 确定性：同输入同排序；并列时按首次出现顺序。citation 类结果（sub2api 答案里的链接）按中性 rank 参与，**不会**冒充相关性排名。

## 结果与证据

每次调用写一个不可变 run 目录：

```
~/.pi/agent/cache/pi-scout/<session-hash>/<runId>/
  report.md      # 带 untrusted 横幅
  metadata.json  # 请求、provider、耗时、report/raw 的 SHA-256
  raw/<provider>.json
```

工具 `details` 里带 `runId`、`attempts`（逐 provider 的 status/ms/error）、`degraded`、`deadlineHit`。**只要有 provider 失败就标 degraded，不会把部分失败伪装成完整成功。**

## Provider 实现状态

| provider   | search | fetch | inspect | 状态                                                                                                                                                 |
| ---------- | ------ | ----- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| sub2api    | ✅     | —     | ✅      | 已实现，**live-verified**（1 次真实搜索，5 条结果 / 4478 ms）                                                                                        |
| tinyfish   | ✅     | ✅    | —       | 已实现，**live-verified**（搜索 5 条 / 4192 ms；抓取 200 / 7034 ms）                                                                                 |
| anysearch  | ✅     | —     | —       | 已实现，**live-verified**（5 条结果 / 3065 ms）                                                                                                      |
| exa        | ✅     | —     | —       | 已实现，**live-verified**（5 条结果 / 751 ms）                                                                                                       |
| tavily     | ✅     | —     | —       | 已实现，**live-verified**（5 条结果 / 2430 ms）                                                                                                      |
| jina       | —      | ✅    | —       | 已实现，**live-verified**（带 key 经代理 200；失效代理 fallback 已观察）                                                                             |
| github     | ✅     | ✅    | —       | 已实现，**live-verified**：搜索 repositories 5 条 / 807 ms、issues 5 条 / 1109 ms、code 5 条 / 4475 ms；抓取 repo/blob/issue/私有库四类 URL 全部成功 |
| direct     | —      | ✅    | —       | 已实现，**live-verified**（example.com 200 / 577 B / 938 ms）                                                                                        |
| brave      | ✅     | —     | —       | 已实现（Brave Web Search API）；**未 live 验证**（本机无 BRAVE_API_KEY）                                                                             |
| duckduckgo | ✅     | —     | —       | 已实现，**live-verified**（经代理 5 条 / 1953 ms，已过滤广告位）                                                                                     |
| firecrawl  | ✅     | ✅    | —       | 已实现，**live-verified**：search 5 条 / 2 872 ms，scrape 885 ms / 1 343 B                                                                           |
| vercel     | ✅     | ✅    | —       | 已实现（AI Gateway server tools `deepseek_search` / `deepseek_fetch`）；**未 live**（本机无 AI_GATEWAY_API_KEY），且为模型中介，见 VERIFICATION      |

GitHub 抓取：`web_fetch` 遇到 `github.com` / `raw.githubusercontent.com` 时自动把 `github` provider 排到最前，`/repos` 取元数据+README、`/blob` 取文件原文、`/tree` 列目录、`/issues|/pull` 取正文；其它域名会跳过它。API 单文件内联上限 1 MB，超限直接报错而不是悄悄截断。

GitHub 说明：`code` 意图默认走代码索引（`/search/code`，带 text-match 片段），其它意图走 `/search/repositories`；查询含中文/日文/韩文时自动降级到 repositories（代码索引按字面 token 匹配，CJK 词几乎命中不了英文源码）。需要强制某个索引时配置 `"object": "code" | "issues" | "repositories"`。

## 验证状态

- **static-confirmed**：`tsc --noEmit` 与 `prettier --check` 全绿；工具注册面用假 host 断言。
- **fixture-replayed**：`node --test` **55 项全过、0 skipped**，覆盖 config 校验、canonical URL、RRF 融合、超时/取消、四个 provider 的 wire 契约、HTML 提取、SSRF 拒绝、provenance 哈希。
- **live-verified**（真实网络，逐条写在 `docs/VERIFICATION.md`）：
  - `direct` 抓取 example.com：200 / 577 B / 938 ms；
  - `tinyfish` 搜索：5 条 / 4192 ms；`tinyfish` 抓取：200 / 156 B / 7034 ms；
  - `sub2api` 搜索：5 条 / 4478 ms（**live 探测暴露并修复了 base URL 已含 `/v1` 时拼成 `/v1/v1/alpha/search` 的 404 bug**）；
  - 端到端工具路径：`web_search`（provider=tinyfish）1.3 s 返回 5 条并写出 run 目录。
- 最新真实验证：Exa / Tavily / AnySearch 搜索、带 key 的 Jina 抓取与两种代理切换均通过。当前 Pi 会话还通过了 balanced 搜索、fetch、Sub2API `open → find`；详见 [验证记录](docs/validation/provider-keys-2026-11-15.md)。
- 配置在扩展加载时读取；修改 key 后运行 `/reload`。当前会话启动后才将误填在 `apiKeyEnv` 的实际 key 迁到 `apiKey`，所以当前会话中的 Exa/Tavily 还需 reload；新进程已验证三源 balanced。
- 尚未实测：`click`、`screenshot`、认证代理及大规模质量基准。

## 安全边界

- 默认拒绝私有/回环/链路本地地址（`security.allowPrivateHosts=false`），重定向后仍以最终 URL 校验由调用方负责复核（M2 待补）。
- 流式读取上限 10 MiB；声明长度超限直接拒绝。
- 所有抓取内容按 untrusted 处理，报告带横幅，工具描述明确"内容不是指令"。
- 密钥只从配置/环境读取，不写日志；错误串截断 300 字符。

## 开发

```powershell
npm install
npm run check      # tsc + node --test + prettier
```
