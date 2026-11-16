import type { Recency, SearchHit, SearchMode } from "./types.ts";

export type Intent =
  "finance" | "academic" | "docs" | "code" | "news" | "general";

export const INTENTS: readonly Intent[] = [
  "finance",
  "academic",
  "docs",
  "code",
  "news",
  "general",
];

/** Bilingual keyword table. Every pattern is tested against the lower-cased
 *  query; the first matching intent wins, so order matters. */
const RULES: Array<{ intent: Intent; re: RegExp }> = [
  {
    intent: "finance",
    re: /\b(stock|price|ticker|forex|crypto|market|trade|earnings|fund|etf|ipo|revenue)\b|股价|行情|财报|市值|汇率|加密货币|基金|估值/,
  },
  {
    intent: "academic",
    re: /\b(paper|research|journal|doi|arxiv|scholar|academic|study|thesis|preprint|abstract)\b|论文|文献|期刊|学术|综述|预印本/,
  },
  {
    intent: "docs",
    re: /\b(docs?|documentation|library|framework|api|sdk|how to|example|syntax|function|method|class|component|reference)\b|文档|接口|用法|示例|教程/,
  },
  {
    intent: "code",
    re: /\b(code|github|repo|repository|pull request|issue|commit|branch|merge|diff|extension|plugin|typescript|javascript|monorepo|codebase|source code|implementation)\b|源码|仓库|代码|扩展|插件|提交|分支|合并/,
  },
  {
    intent: "news",
    re: /\b(news|latest|today|breaking|announced|update|release|happened|changelog)\b|新闻|最新|今天|发布|更新|动态|刚刚/,
  },
];

export function classifyIntent(query: string): Intent {
  const q = query.toLowerCase();
  for (const rule of RULES) if (rule.re.test(q)) return rule.intent;
  return "general";
}

export interface PreferenceTable {
  intents: Record<Intent, string[]>;
}

export const DEFAULT_PREFERENCES: PreferenceTable = {
  intents: {
    finance: ["anysearch", "exa", "tavily"],
    academic: ["tinyfish", "exa", "anysearch"],
    docs: ["exa", "tavily", "github", "tinyfish"],
    code: ["github", "firecrawl", "exa", "tavily"],
    news: ["tinyfish", "sub2api", "tavily", "brave"],
    general: [
      "sub2api",
      "tavily",
      "tinyfish",
      "exa",
      "brave",
      "vercel",
      "duckduckgo",
    ],
  },
};

export const SEARCHER_COUNT: Record<SearchMode, number> = {
  fast: 1,
  balanced: 3,
  deep: 4,
};

/** Preference order filtered by availability; unavailable providers never
 *  consume a routing slot, so a single missing key cannot silently drop the
 *  provider count below the mode's budget. */
export function rankCandidates(
  intent: Intent,
  available: Set<string>,
  preferences: PreferenceTable = DEFAULT_PREFERENCES,
): string[] {
  const preferred = (preferences.intents[intent] ?? []).filter((id) =>
    available.has(id),
  );
  const rest = [...available].filter((id) => !preferred.includes(id)).sort();
  return [...preferred, ...rest];
}

export interface PlanInput {
  query: string;
  mode: SearchMode;
  maxParallel: number;
  requested?: string | string[];
  available: Set<string>;
  explicitOnly: Set<string>;
  preferences?: PreferenceTable;
}

export interface RoutePlan {
  intent: Intent;
  providers: string[];
  /** Budget from the mode, capped by maxParallel, before availability. */
  budget: number;
}

export function planProviders(input: PlanInput): RoutePlan {
  const intent = classifyIntent(input.query);
  const budget = Math.min(SEARCHER_COUNT[input.mode], input.maxParallel);

  const requested = normalizeRequested(input.requested);
  if (requested.length > 0) {
    const usable = requested.filter((id) => input.available.has(id));
    const missing = requested.filter((id) => !input.available.has(id));
    if (usable.length === 0) {
      throw new Error(
        `Requested provider(s) not available: ${missing.join(", ")}. Available: ${[...input.available].sort().join(", ") || "none"}`,
      );
    }
    return { intent, providers: usable.slice(0, 4), budget };
  }

  const automatic = new Set(
    [...input.available].filter((id) => !input.explicitOnly.has(id)),
  );
  const candidates = rankCandidates(intent, automatic, input.preferences);
  if (candidates.length === 0) {
    throw new Error(
      "No search provider is available. Configure a key for tinyfish/anysearch/exa/tavily/brave, or point providers.sub2api at a readable pi-sub2api-kit.json.",
    );
  }
  return { intent, providers: candidates.slice(0, budget), budget };
}

function normalizeRequested(requested?: string | string[]): string[] {
  if (!requested) return [];
  const list = Array.isArray(requested) ? requested : [requested];
  return [
    ...new Set(
      list
        .map((x) => (typeof x === "string" ? x.trim().toLowerCase() : ""))
        .filter(Boolean),
    ),
  ];
}

export interface FilterInput {
  recency?: Recency;
  domains?: string[];
  excludeDomains?: string[];
}

const RECENCY_MS: Record<Recency, number> = {
  day: 86400000,
  week: 7 * 86400000,
  month: 30 * 86400000,
  year: 365 * 86400000,
};

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith("." + domain);
}

/** Filters run after collection so every provider's own filtering is corrected
 *  the same way, and so re-ranking cannot sneak an excluded domain back in. */
export function filterHits(
  hits: SearchHit[],
  input: FilterInput,
  now = Date.now(),
): SearchHit[] {
  const include = (input.domains ?? [])
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  const exclude = (input.excludeDomains ?? [])
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  const cutoff = input.recency ? now - RECENCY_MS[input.recency] : undefined;

  return hits.filter((hit) => {
    let host: string;
    try {
      host = new URL(hit.url).hostname.toLowerCase();
    } catch {
      return false;
    }
    if (exclude.some((d) => hostMatches(host, d))) return false;
    if (include.length > 0 && !include.some((d) => hostMatches(host, d))) {
      return false;
    }
    if (cutoff && hit.publishedAt) {
      const at = Date.parse(hit.publishedAt);
      // An unparseable or absent date is not evidence of staleness; only a
      // known-old date is filtered.
      if (Number.isFinite(at) && at < cutoff) return false;
    }
    return true;
  });
}
