import type {
  ProviderMeta,
  SearchHit,
  SearchProvider,
  SearchRequest,
} from "../types.ts";

export const TAVILY_META: ProviderMeta = {
  id: "tavily",
  label: "Tavily",
  capabilities: ["search"],
  auth: "key",
  envVar: "TAVILY_API_KEY",
  cost: 1,
  weight: 2,
  timeoutMs: 15000,
};

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
}

export function parseTavily(
  payload: unknown,
  provider = "tavily",
): SearchHit[] {
  const items = (payload as { results?: TavilyResult[] } | null)?.results ?? [];
  return items
    .filter((item) => typeof item.url === "string" && item.url)
    .map((item, index) => ({
      title: item.title ?? "",
      url: item.url as string,
      snippet: item.content ?? "",
      provider,
      rank: index + 1,
    }));
}

export interface TavilyOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export function createTavilyProvider(options: TavilyOptions): SearchProvider {
  const doFetch = options.fetchImpl ?? fetch;
  return {
    meta: TAVILY_META,
    async search(req: SearchRequest) {
      const response = await doFetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: options.apiKey,
          query: req.query,
          max_results: req.maxResults,
          search_depth: "basic",
        }),
        signal: req.signal,
      });
      if (!response.ok) throw new Error(`tavily HTTP ${response.status}`);
      const payload: unknown = await response.json();
      return {
        hits: parseTavily(payload).slice(0, req.maxResults),
        raw: payload,
      };
    },
  };
}
