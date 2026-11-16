# Verification

## 0.7.3 (2026-11-15): Can DeepSeek search/fetch return raw results without new deps?

### What `gateway.tools.deepseekSearch()` actually is

Read from the AI SDK source (`packages/gateway/src/tool/deepseek-search.ts`, via GitHub API):

- It is a **provider-executed tool**: `createProviderExecutedToolFactory({ id: 'gateway.deepseek_search' })`, i.e. `{ type: 'provider', isProviderExecuted: true, id }`.
- Config args: `query?`, `count?`, `needContent?`, `oriQuestion?`, `localization?`; model-facing args are `query`, `count`, `need_content`, `ori_question`.
- Output schema: `{ results: DeepSeekSearchResult[] }` with `title`, `url`, `snippet`, `summary`, `content`, `date`, `site_name`, `authority`, `rerank_score`.
- `deepseek_fetch` returns `{ content, title? }` (Markdown).
- Docs show `console.log(result.toolResults)`, implying the AI SDK surfaces them; that path needs `ai` + `@ai-sdk/gateway` (AI SDK 6: gateway >=3.0.227, AI SDK 7: >=4.0.133).

### Three zero-dependency probes against the live gateway

| probe                              | result                                                                                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Chat Completions, non-stream       | `choices[0].message` has only `role`, `content`, `provider_metadata`; no `results`, no `tool_calls`                                                                                                          |
| Chat Completions, `stream: true`   | SSE chunks contain only `role` / `content` / `provider_metadata`; **prompt tokens jumped 120 -> 2 964**, proving the tool ran and its output was injected into model context, but no tool payload is emitted |
| `/v1/responses` with the same tool | `output` contains a single `message` item; no tool-result item                                                                                                                                               |

Conclusion: **the raw `{results}` array never leaves the gateway over REST.** Without the AI SDK, structured hits can only be obtained by asking the model to transcribe them (current implementation), which is lossy by construction.

### Cost metadata is available

`provider_metadata.gateway.cost` is present on every response (observed `0.0001035` USD for one search+answer call), alongside `gatewayCost`, `inferenceCost` and `generationId`. This could feed run provenance even without the SDK.

### Alternative with raw results and still no new deps

DeepSeek publishes the same capability as plain JSON Tool APIs (`https://api-docs.deepseek.com/guides/search`: "Both are raw JSON APIs. They use the same bearer authentication as the DeepSeek API."). Calling those directly returns structured results with no model in the loop - but bills the DeepSeek key, not the AI Gateway free credit.

## 0.7.2 (2026-11-15): Vercel live in host; web_fetch provider pinning

### Host verification after restart

`web_search` pinned to `vercel` succeeded in the live session: **5 hits, 7 798 ms**, results were the Vercel changelog, the DeepSeek Fetch model page and the AI SDK release notes. The previous 403 is gone, confirming the free-tier model switch took effect.

### "deepseek/search" and "deepseek/fetch" are not model ids

The user's phrasing implied these were models. Verified against the live gateway with a real key:

| attempted model id         | response              |
| -------------------------- | --------------------- |
| `deepseek/deepseek-search` | 404 `model_not_found` |
| `deepseek/deepseek-fetch`  | 404 `model_not_found` |
| `deepseek/search`          | 404 `model_not_found` |
| `deepseek/fetch`           | 404 `model_not_found` |

So there is no standalone endpoint; the correct integration is the server-tool form this provider already uses (`vercel:deepseek_search`, `vercel:deepseek_fetch`), with any tool-calling host model on the free credit.

### web_fetch gained provider pinning

Previously `web_fetch` only followed the cascade, so a provider like `vercel` (last in the cascade) could never be exercised from the host. It now accepts `provider` / `providers`, mirroring `web_search`, and rejects unknown ids with the available list. Verified through the real tool entry: pinned `vercel` fetch of `example.com` → `vercel:ok`, 1 300 bytes, 4 212 ms, single attempt.

### Fidelity caveat confirmed again

The pinned Vercel fetch of `example.com` returned the page **translated into Chinese**. Output is model-mediated: do not treat DeepSeek Fetch results as verbatim source text.

## 0.7.1 (2026-11-15): Vercel provider live + free-tier model constraint

### Free tier does not include DeepSeek host models

With a real AI Gateway key, `deepseek/deepseek-v4.1-flash` returned **403 `no_providers_available`**: "Free tier users do not have access to this model." Probing ten cheap models showed only two working on the free credit: `alibaba/qwen-3-14b` (200) and `google/gemini-2.5-flash` (200); `deepseek/deepseek-v3.2`, `deepseek/deepseek-v4-flash`, `anthropic/claude-haiku-4.5` and `claude-haiku-5.5` all returned 403.

The DeepSeek **search/fetch tools** work regardless of the host model — the tool is independent of it. Config model changed to `google/gemini-2.5-flash`.

### Timeout defect found and fixed

A long fetch failed with `all routes failed … pi-scout route timeout`: the pool armed an 8 s per-route timer that stayed until headers arrived, and a 31 s model call never got there. `ProxyPool.fetch` now takes a per-call `routeTimeoutMs`, and the registry passes the provider's own `timeoutMs` (vercel = 60 s). Normal fetches keep the 8 s default.

### Live-verified

| call                                                | result                                                                                         |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `web_search` pinned `vercel` (DeepSeek search tool) | 5 hits, **6.1 s** (Vercel changelog, docs, GitHub PR)                                          |
| `vercel` fetch `example.com`                        | 3.0 s, 1 300 bytes — **the model translated the page into Chinese**, so output is not verbatim |
| `vercel` fetch Vercel docs                          | **31.4 s**, 28 772 bytes, English preserved                                                    |

### Limits

- Host-model tokens bill on top of the $0.75/1k tool fee; both draw on the $5/month free credit.
- `deepseek_fetch` fidelity depends on the model obeying "verbatim" — the example.com run shows translation/reformatting.
- Free-tier model availability can change without notice; a 403 `no_providers_available` is surfaced as-is instead of being retried.

## 0.7.0 (2026-11-15): Vercel AI Gateway (DeepSeek search/fetch)

### What the service actually is (researched, not assumed)

Vercel AI Gateway exposes DeepSeek's search and fetch as **server tools**, not as standalone models:

- Chat Completions: `POST https://ai-gateway.vercel.sh/v1/chat/completions` with `tools: [{ "type": "vercel:deepseek_search", "config": { "query": "...", "count": 1-50 } }]` and `tool_choice: "required"`. Fetch uses `"type": "vercel:deepseek_fetch", "config": { "url": "..." }`.
- The gateway executes the tool **inside** the request, injects results into the model context, and returns only the model's final answer — the docs state the response has no client-facing `tool_calls` or raw search results, only `provider_metadata.gateway.gatewayToolCalls` counts and cost.
- Pricing: DeepSeek Search **$0.75 / 1,000** billable requests, DeepSeek Fetch **$0.75 / 1,000**; empty results, failures and timeouts are not billed. Host-model tokens are billed separately. A `/v1/models` probe returned 508 models and **no** model id containing "search" or "fetch", confirming there is no direct model endpoint.

### Implementation

Provider `vercel` (search + fetch), key `AI_GATEWAY_API_KEY`, config `model` = host model that drives the tool (default suggestion `deepseek/deepseek-v4.1-flash`).

Because raw tool output is not exposed, the provider asks the host model for strict JSON (`[{title,url,snippet}]`) and falls back to markdown-link extraction when the model disobeys. Fetch asks for verbatim Markdown.

### Honest limitations

- This is **model-mediated**: token cost and quality depend on the host model, and long pages may be summarised or truncated despite the "verbatim" instruction.
- Structured results are best-effort JSON, not the gateway's raw tool payload.
- Fixture tests only: **no `AI_GATEWAY_API_KEY` on this host**, so nothing was executed against the service. `unconfigured` until a key is added.

## 0.6.1 (2026-11-15): Brave and Firecrawl live

### Credential placement

Both keys had been pasted into `apiKeyEnv`, which is read as an environment-variable **name**, so both providers stayed in `unconfigured`. Migrated literal values to `apiKey` (config backup `pi-scout.json.backup-1794758270680`).

Guard added: `apiKeyEnv` must match `^[A-Za-z_][A-Za-z0-9_]*$`; a value with dashes or other key-like characters now fails config validation with "must be an environment variable NAME; put the key itself in apiKey". This catches the exact mistake that happened twice. Limitation: a purely alphanumeric key would still look like a valid name.

### Live-verified

| provider  | call                               | result                                                                                            |
| --------- | ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| brave     | search `pi coding agent extension` | 5 hits, **1032 ms** (`pi.dev/packages`, `awesome-pi.site/extensions`, `narumiruna/pi-extensions`) |
| firecrawl | search, same query                 | 5 hits, **2872 ms**                                                                               |
| firecrawl | scrape `https://example.com`       | **885 ms**, 1343 bytes, title `Example Domain`                                                    |

All three used the migrated inline keys and the configured proxy pool.

### Host verification after restart

| call                                | provider                    | attempts              | result                                                             |
| ----------------------------------- | --------------------------- | --------------------- | ------------------------------------------------------------------ |
| `web_search` pinned `brave`         | brave                       | `brave:ok@683ms`      | 5 hits                                                             |
| `web_search` pinned `firecrawl`     | firecrawl                   | `firecrawl:ok@2585ms` | 5 hits                                                             |
| `web_search` news query (no pin)    | tinyfish + sub2api + tavily | all ok                | brave sat 4th, outside the 3-provider budget — intended            |
| `web_fetch https://pi.dev/packages` | direct                      | `direct:ok@1531ms`    | Firecrawl was never reached because direct already returned 204 KB |

Firecrawl's fetch path was verified in a fresh process (scrape of example.com, 885 ms), not in the host: with `direct` first and succeeding, the cascade never escalates.

### Host status

The running Pi session built its registry before the migration, so `brave`/`firecrawl` are still absent there. This is a **config-only** change: `/scout-reload` is enough, no restart.

## 0.6.0 (2026-11-15): Brave / DuckDuckGo / Firecrawl

### Wire contracts (static-confirmed + fixture-replayed)

- **Brave**: `GET https://api.search.brave.com/res/v1/web/search` with `X-Subscription-Token`, `count`, optional `freshness=pd/pw/pm/py`; 401/403 → invalid token, 429 → rate limited; results mapped from `web.results[]`, HTML tags stripped from descriptions.
- **DuckDuckGo**: `GET https://html.duckduckgo.com/html/?q=...` with a desktop UA; parses `result__a` / `result__snippet`, unwraps `/l/?uddg=` redirects, drops sponsored `duckduckgo.com/y.js` slots. 202/429 → explicit "challenge or rate limit".
- **Firecrawl**: `POST /v1/search` (`{query, limit}`) and `POST /v1/scrape` (`{url, formats:["markdown"], onlyMainContent:true}`); 401/402/429 mapped separately; scrape returns markdown + metadata.

94 tests total, 0 failed, 0 skipped (8 new).

### Defect found by live probing

DDG's **POST form** endpoint returns HTTP **202** with an anti-bot page from this network (even through the proxy), while **GET** returns 200 with 10 result anchors. Switched the provider to GET; a regression test asserts the method.

### Live-verified

| provider   | result                                                                                 |
| ---------- | -------------------------------------------------------------------------------------- |
| duckduckgo | 5 hits, **1953 ms** through the proxy pool; first hit `pi.dev` after ad-slot filtering |

### Live-blocked

- `brave` and `firecrawl` have **no API key on this host** — only fixture tests ran. Add `BRAVE_API_KEY` / `FIRECRAWL_API_KEY` (or inline `apiKey`) and `/scout-reload` to activate.
- DDG is HTML scraping: it can break when DuckDuckGo changes markup or serves challenges; it is a keyless fallback, not a primary provider.

## 0.5.0 (2026-11-15): M3 — redirect SSRF, PDF, benchmark

### Redirect and DNS hardening (direct provider)

- Redirects are followed **manually** (`redirect: "manual"`), every hop is re-validated with `assertResolvablePublic`: scheme check, literal private-host check, and a DNS lookup that rejects any address in loopback/RFC1918/link-local/ULA ranges. A public name resolving to `127.0.0.1` is refused before the request.
- Limit 5 hops; a loop throws `Too many redirects`. The final URL is reported as `finalUrl`.
- Tests: relative redirect chain, redirect into `127.0.0.1` (second request never sent), DNS-rebinding host, redirect loop, plus a live `http://github.com/...` → `https://github.com/...` hop (2 020 ms, finalUrl updated).

**Residual risk:** the DNS answer is checked before connect, so a TOCTOU race (DNS changes between check and connect) is not fully eliminated. Closing it needs a pinning dispatcher; recorded as an open item, not silently claimed as solved.

### PDF extraction

- `unpdf` (pdf.js based) extracts page text; PDFs are detected by content type or `%PDF` magic, and bypass the HTML path entirely.
- Fixture `test/fixtures/dummy.pdf` (13 264 bytes, sha256 `3df79d34abbca99308e79cb94461c1893582604d68329a41fd4bec1885e6adb4`, from w3.org) is committed for replay tests.
- Live: `web_fetch` on the W3C dummy PDF → 200, `application/pdf`, 13 264 bytes, text `--- page 1 --- Dummy PDF file`, 956 ms.
- Page text is concatenated with `--- page N ---` separators; the 10 MiB byte cap still applies before parsing.

### Host test follow-up: PDF vs minChars

First host run after the restart showed `web_fetch` on the W3C PDF falling through `direct:empty → tinyfish:empty → jina:ok`. The PDF extraction itself worked (30 characters: `--- page 1 --- Dummy PDF file`), but the cascade's `minChars = 200` heuristic rejected it as "too short", and Jina then returned a 239-character non-PDF payload.

Fix: PDFs are exempt from `minChars` — success is any non-empty extracted text; an empty PDF reports "PDF produced no extractable text". Jina now also rejects `application/pdf` responses outright instead of returning garbage.

Fresh-process verification after the fix: `web_fetch` on the same PDF → **provider direct, 13 264 bytes, single `direct:ok` attempt**, title `dummy.pdf`. `example.com` still falls through to Jina (173/156 characters, legitimately short HTML), unchanged.

**Host status:** verified after restart — `web_fetch` on the W3C PDF returned `provider: direct`, 13 264 bytes, single `direct:ok` attempt, title `dummy.pdf`; `example.com` still falls through to Jina; `http://www.w3.org/` followed the redirect to `https://www.w3.org/` (49 319 bytes, `finalUrl` updated).

### 40-query benchmark

`/scout-bench` runs `bench/queries.json` (40 queries across finance/academic/docs/code/news/general, bilingual) against selected providers, scores coverage of the per-query URL union and latency, and writes `report.md` + `results.json` under `~/.pi/agent/cache/pi-scout/bench/`.

Run of 2026-11-15 (40 queries × 4 providers = 160 calls, 103.8 s, providers run concurrently per query):

| provider | ok%   | p50  | p95  | coverage | unique/query | jaccard | score | weight |
| -------- | ----- | ---- | ---- | -------- | ------------ | ------- | ----- | ------ |
| exa      | 100.0 | 384  | 994  | 32.4%    | 3.8          | 7.3%    | 0.288 | **3**  |
| tavily   | 100.0 | 1700 | 2866 | 33.1%    | 3.4          | 9.7%    | 0.211 | 2      |
| github   | 72.5  | 601  | 806  | 24.0%    | 3.9          | 0.3%    | 0.200 | 2      |
| tinyfish | 100.0 | 1996 | 3818 | 33.1%    | 3.5          | 9.3%    | 0.199 | 2      |

Observations:

- Pairwise Jaccard is **7–10 %**: the four providers return largely disjoint result sets, which is the empirical justification for fusion rather than single-provider search.
- GitHub's 72.5 % success rate reflects repository search returning nothing for news/finance queries — it is a code/tech provider, not a general one.
- `sub2api` was **excluded** from this run (paid, ~5 s/call); its weight stays 3 pending a separate cost-approved run. `anysearch` is explicit-only and also excluded.
- Weights applied to the user config: `exa 2 → 3`, others unchanged (backup `pi-scout.json.backup-1794754322408`).

**Caveat:** coverage is measured against the union of the four providers, so it rewards providers that return more of what the others also return; it is not a relevance judgement. No human or model grading was applied. Treat the weights as a prior, not ground truth.

## 0.4.0 (2026-11-15): GitHub as a fetch provider

### Static-confirmed

- `parseGitHubUrl` maps `github.com/{owner}/{repo}`, `/blob/{ref}/{path}`, `/tree/{ref}/{path}`, `/issues|/pull/{n}` and `raw.githubusercontent.com/...` to an API operation; every other URL returns null.
- `createGitHubFetch` uses `/repos` (metadata + README via `application/vnd.github.raw+json`), `/contents` with raw media type for blobs, `/contents` JSON for trees, `/issues/{n}` for issues and PRs. 404 is reported as "private or missing", 401 as bad credentials, 403/429 as rate limiting.
- Blobs above **1 MiB** are rejected by an explicit `HEAD`/content-length check before download.
- `orderFetchCascade` puts `github` first for GitHub hosts and removes it for every other host, so the cascade never wastes an attempt on a provider that would reject the URL.

### Fixture-replayed

`node --test`: **74 tests, 0 failed, 0 skipped** (9 new): URL mapping, cascade ordering, repo metadata+README (two calls), blob raw text, blob size rejection, tree listing, issue rendering, 404 mapping, non-GitHub rejection.

### Live-verified (this host)

| URL                                                          | result                                                          |
| ------------------------------------------------------------ | --------------------------------------------------------------- |
| `github.com/earendil-works/pi`                               | repo + README, **1069 ms**, title `earendil-works/pi`, ★ 122115 |
| `github.com/mattzcarey/hono-mcp-server/blob/main/src/mcp.ts` | raw file text, **900 ms**, title `…/src/mcp.ts@main`            |
| `github.com/JetBrains/ytdb-slate/issues/52`                  | issue body, **580 ms**                                          |
| `github.com/your-org/private-repo` (**private**)             | repo + README, **903 ms** — PAT grants access                   |

Tool path: `web_fetch` on a GitHub URL produced **only** the `github` attempt (`ok`), while `example.com` skipped GitHub and used `direct → tinyfish → jina`.

### Limits

- GitHub contents API is used for blob text; files > 1 MiB intentionally fail instead of silently truncating.
- Only the default branch is inferred when the URL has no ref; explicit `/blob/{ref}` is honoured.
- The running host session predates this change: `/scout-reload` picks up the new fetch provider (config unchanged), but the code itself needs a restart.

### Host verification after restart

| call                                                   | provider      | attempts                                   | bytes  |
| ------------------------------------------------------ | ------------- | ------------------------------------------ | ------ |
| `web_fetch github.com/earendil-works/pi`               | github        | `github:ok`                                | 10 823 |
| `web_fetch …/blob/main/src/mcp.ts`                     | github        | `github:ok`                                | 18 322 |
| `web_fetch github.com/your-org/private-repo` (private) | github        | `github:ok`                                | 9 517  |
| `web_fetch example.com`                                | jina          | `direct:empty → tinyfish:empty → jina:ok`  | 1 465  |
| one call with `[issue URL, example.com]`               | github / jina | `github:ok` and `direct → tinyfish → jina` | —      |

The mixed call confirms the cascade is ordered **per URL**, not per batch: the GitHub issue used a single GitHub attempt while the non-GitHub URL skipped GitHub entirely.

## 0.3.0 (2026-11-15): GitHub search provider

### Static-confirmed

- `providers.github` added to the config schema with `object: repositories | issues | code` (default `repositories`); unknown values rejected with the field path.
- `createGitHubProvider` sends `Authorization: Bearer <PAT>`, `X-GitHub-Api-Version: 2022-11-28`, and `Accept: application/vnd.github.text-match+json` for code search. 401 / 403 / 429 / 422 map to distinct messages; the rate-limit message reports `x-ratelimit-remaining` and reset time.
- `github` ranks first for the `code` intent; `docs` adds it in third place. The `code` keyword table now covers extension/plugin/TypeScript/JavaScript/monorepo/codebase/source code/implementation (plus 扩展/插件/代码).
- Unless `object` is pinned, a `code`-intent request uses the **code index** (text-match fragments); other intents use repositories. Repository search only matches name/description/topics and returns nothing for many technical phrases.
- CJK queries (`hasCjk`: Han, kana, Hangul, compatibility ideographs) fall back to **repositories** even under `code` intent, because GitHub code search matches literal tokens and CJK phrases rarely match English source. `object` still overrides.
- The GitHub entry was originally pinned to `object: "repositories"` in the user config, which silently disabled the intent-based selection. The pin was removed (config backed up). Verified in a fresh process: English `code` query returns file-level titles (`…/src/mcp.ts`), Chinese query returns repository-level titles.
- Added `/scout-reload`: re-reads the config file and rebuilds the registry in-process. Config-only changes (keys, proxies, provider toggles) no longer need a Pi restart; tool-name or code changes still do. Covered by a test that flips the provider set between two reloads.
- Live A/B on `中文 代码 仓库`: auto (repositories) returned 5 repository hits led by `ShusenTang/Deep-Learning-with-PyTorch-Chinese`; forcing `object: "code"` returned 5 unrelated file hits led by `swoole/rfc/ROLE.md`. Both indexes answer, but only the repository index answers at repository granularity.

### Fixture-replayed

`node --test`: **62 tests, 0 failed, 0 skipped** (7 new): repository/issue/code parsers, query encoding and `per_page` cap, auth/version/media-type headers, credential vs rate-limit error mapping, config validation of `object`.

### Live-verified (this host, PAT from `gh auth token`)

| object         | query                                    | result                                                                         |
| -------------- | ---------------------------------------- | ------------------------------------------------------------------------------ |
| `repositories` | `pi coding agent extension`              | 5 hits, **807 ms** (`narumiruna/pi-extensions`, `nicobailon/pi-web-access`, …) |
| `issues`       | `web_search tool collision pi extension` | 5 hits, **1109 ms**                                                            |
| `code`         | `registerTool language:typescript`       | 5 hits, **4475 ms**, text-match fragments present                              |

Each probe wrote a normal run directory. The PAT lives in `~/.pi/agent/pi-scout.json` (`providers.github.apiKey`), never in this repository; the config was backed up before the edit.

### Live-blocked / limits

- Post-restart host check: `web_search provider=github` returned 5 hits in **753 ms** in the live session; `web_fetch` and `web_inspect` stayed healthy.
- The routing refinements (broadened code keywords + intent-based index selection) were verified in a fresh process: `registerTool language:typescript` planned `github → exa → tavily` and GitHub returned 5 hits in 747 ms. The already-running session needs another `/reload` to pick up that routing change; the GitHub provider itself is live in the host.
- Rate-limit behavior was exercised only by a synthetic 403 fixture, not by exhausting the real quota.
- Code search depends on token scopes and GitHub's code index; only public repositories were probed.

## Current: credential migration and live validation (2026-11-15)

See [the validation record](validation/provider-keys-2026-11-15.md) for run IDs and hashes. Exa, Tavily and AnySearch each returned five live hits; authenticated Jina succeeded with observed direct-to-proxy and failed-proxy-to-next-proxy fallback. Current Pi tools succeeded for balanced search, fetch and Sub2API open → find. After the user restarted Pi, the host exposes all five search providers and pinned Exa/Tavily/AnySearch, balanced fusion, multi-query, `web_fetch` and the `web_inspect` open→find chain all succeeded live; see the post-restart table in the same record. A fresh process exercised three-source balanced fusion successfully. Older sections below preserve historical evidence and limitations at their recording time.

### Post-restart routing verification (host)

All four calls ran in the live Pi session after a restart, no provider pinned:

| query                               | intent | planned                       | result                                                              |
| ----------------------------------- | ------ | ----------------------------- | ------------------------------------------------------------------- |
| `registerTool language:typescript`  | code   | `github → exa → tavily`       | 5 + 5 + 5 hits; GitHub **762 ms**                                   |
| `pi 扩展 插件 代码`                 | code   | `github → exa → tavily`       | GitHub **1** hit (Chinese terms match literally), exa/tavily 5 each |
| `latest AI industry news this week` | news   | `tinyfish → sub2api → tavily` | 5 + 5 + 5 hits                                                      |
| `react hooks documentation`         | docs   | `exa → tavily → github`       | 5 + 5 + 5 hits; GitHub **654 ms**                                   |

The control queries confirm the change is scoped: `news` keeps its own order, and `docs` gains GitHub only as the third candidate. The Chinese code query returning a single GitHub hit is expected — the code index matches literal tokens, so Chinese phrasing rarely matches English source code.

### Host verification after unpinning `object`

| query                                              | intent | GitHub result                                                           |
| -------------------------------------------------- | ------ | ----------------------------------------------------------------------- |
| `registerTool language:typescript` (pinned github) | code   | 5 hits, **799 ms**, titles are file paths (`…/mcp/lib.ts`) → code index |
| `中文 代码 仓库` (pinned github)                   | code   | 5 hits, **735 ms**, titles are `owner/repo` → repository fallback       |

A balanced code query (`typescript monorepo extension implementation`) exposed two things:

1. GitHub code search can exceed the 12 s overall search deadline (it was still running at 12 015 ms while Exa/Tavily returned in ~1 s). Result quality was unaffected, but GitHub contributed nothing for that query. If code search matters, raise `routing.search.deadlineMs` (e.g. 20000) or pin fewer providers.
2. Reporting bug found: a provider cut off by the deadline was recorded as `skipped`, and `degraded` stayed **false** even though `deadlineHit` was true. Fixed in `src/executor.ts`: `degraded` is now true when the deadline fires and any provider was skipped. Race losers (cancelled after a winner) are still not counted as degraded.

## 0.2.0 (2026-11-15): provider keys + proxy pool

### Static-confirmed

- `network.proxies` / `network.strategy` / `cooldownMs` / `routeTimeoutMs` validated in `src/config.ts`; unknown fields and invalid proxy URLs fail with file + field path. `proxy-only` without any proxy is a hard config error.
- Per-provider `proxy`: `"auto" | "none" | <http(s) URL>` validated and threaded through `buildRegistry → fetchFor(id) → ProxyPool.fetch`.
- `ProxyPool` (src/network.ts): ordered fallback, per-route connect/headers timeout, failure cooldown, and fallback **only** on transport errors (`isNetworkError`); an HTTP 4xx/5xx from the target is returned as-is and never re-sent through another route.

### Fixture-replayed

`node --test`: **55 tests, 0 failed, 0 skipped**. New coverage: route ordering for `direct-first` / `proxy-first` / pinned `none`, cooldown skip + recovery, non-network error short-circuit, hanging-route timeout, config validation, and a **real local forward proxy** (HTTP CONNECT implementation in the test) proving `ProxyAgent` traffic flows end to end.

### Live-verified (this host)

| probe                                                                              | result                                                                                                                        |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `curl -x <proxy> https://r.jina.ai/https://example.com` for four candidate proxies | all **200**: proxy-a:7890 **1.06 s**, proxy-b:7890 **1.07 s**, proxy-c:17897 **5.73 s**, proxy-d:17897 **5.58 s**             |
| `https://r.jina.ai` **direct**                                                     | fails after 15 s (blocked); `curl` exit 28                                                                                    |
| `scripts/smoke-fetch.ts https://example.com` through the pool                      | `direct` 200/577 B/862 ms; `tinyfish` 200/156 B/1552 ms; **`jina` 200/1465 B/1324 ms**, text sha256 prefix `24a9212f6992697f` |

The Jina result is the proof that fallback works: direct fails at the transport layer, the pool advances to the first healthy proxy, and the same provider returns a normal document. Proxy order in the user config is fastest-first, with the two slower proxies as further fallbacks.

### Live-blocked

- Proxies that require authentication were not tested (no credentials provided).
- SOCKS proxies are **not supported** (undici `ProxyAgent` speaks HTTP(S) CONNECT only); `socks5://` is rejected by config validation.
- `exa` / `tavily` still have no keys; `anysearch` still not live-probed (paid).

## 0.1.0 (2026-11-15)

### Static-confirmed

- `tsc --noEmit` passes with `strict` + `noUncheckedIndexedAccess`; `prettier --check` passes for `src`, `test`, `scripts`, `*.json`, `*.md`.
- Tool registration surface asserted against a fake host (`test/index.test.ts`): `web_search` + `web_fetch` always; `web_inspect` only when a readable `pi-sub2api-kit.json` with `search.model` is discovered.
- Wire contracts asserted field-by-field for sub2api (`model`, `id`, `commands.search_query[0]`, `settings.allowed_callers`), tinyfish (query params + `x-api-key`), exa (`x-api-key`, `numResults`, `type`), tavily (`api_key`, `max_results`), anysearch (JSON-RPC `tools/call`).
- Install recorded by the host: `pi list` shows `E:/inter/Documents/Repos/pi-scout`.

### Fixture-replayed

`node --test`: **44 tests, 0 failed, 0 skipped**. Coverage: config defaults/validation/error paths, canonical URL, SSRF guard, RRF fusion determinism/consensus/domain cap, EN+ZH intent classification, mode budgets, serial/parallel/deadline execution, provider parsers and wire bodies, HTML extraction, provenance hashing and session-path hashing.

### Live-verified (real network from this host)

| probe                                                                                                           | result                                                                                               |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `scripts/smoke-fetch.ts https://example.com` → `direct`                                                         | 200, 577 bytes, title `Example Domain`, 938 ms, text sha256 prefix `ea44d332f3bac7c1`                |
| `scripts/smoke-providers.ts tinyfish "pi coding agent plugins"`                                                 | 5 hits, 4192 ms, hits sha256 prefix `2ef45c5399e7510e`, report sha256 prefix `70d83b6e5fd63c83`      |
| `scripts/smoke-fetch-tinyfish.ts https://example.com`                                                           | 200, 156 bytes, title `Example Domain`, 7034 ms                                                      |
| `scripts/smoke-providers.ts sub2api "pi coding agent extensions 2026"`                                          | 5 hits, 4478 ms, hits sha256 prefix `6c3dc51a48918729`, report sha256 prefix `4ff5991882dc1736`      |
| `scripts/smoke-tool.ts tinyfish "pi coding agent plugins"` (full `web_search` path through the extension entry) | `isError:false`, 1281 ms, 5 hits, runId `run_f92f61b1-c799-4077-b008-31565b04d6ea`, `degraded:false` |

### Defect found by the live probe (fixed)

The kit config stores `sub2api_base_url = https://…/v1` (it is used for `/models`). Both packages appended `/v1/alpha/search`, producing `…/v1/v1/alpha/search` → **HTTP 404**. Probing the normalized shape returned **400 `Missing required parameter: 'id'`**, i.e. the route exists and only the body was incomplete. Fix: `alphaSearchUrl()` in `src/providers/sub2api.ts` (and the same fix in pi-sub2api-kit 0.5.1), with unit tests for base URLs with/without `/v1`.

### Live-blocked

- `jina`: `fetch failed` after 228 ms from this host; default cascade is `direct → tinyfish? no → jina`, Jina stays unverified.
- `anysearch`: key present but **no authorization for a paid probe**; parser and JSON-RPC envelope are fixture-tested only.
- `exa`, `tavily`: no API key on this host; fixture-tested only.
- Real Pi session tool call: not executed. The extension is installed and listed, and the full tool path was exercised through the real entry point with a fake host, which is not the same as a live Pi turn.

## Evidence rules

- "static-confirmed" = source/types asserted, never executed against the live service.
- "fixture-replayed" = recorded or synthesized wire bytes replayed locally.
- "live-verified" = real network call from this host, with byte counts and hashes recorded above.
- Never upgrade a claim across tiers; a passing fixture is not a live pass.
