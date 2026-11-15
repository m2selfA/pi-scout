import type {
  ProviderMeta,
  SearchHit,
  SearchProvider,
  SearchRequest,
} from "../types.ts";

export const EXA_META: ProviderMeta = {
  id: "exa",
  label: "Exa",
  capabilities: ["search"],
  auth: "key",
  envVar: "EXA_API_KEY",
  cost: 1,
  weight: 2,
  timeoutMs: 15000,
};

interface ExaResult {
  title?: string;
  url?: string;
  text?: string;
  publishedDate?: string;
  score?: number;
}

export function parseExa(payload: unknown, provider = "exa"): SearchHit[] {
  const items = (payload as { results?: ExaResult[] } | null)?.results ?? [];
  return items
    .filter((item) => typeof item.url === "string" && item.url)
    .map((item, index) => ({
      title: item.title ?? "",
      url: item.url as string,
      snippet: item.text ?? "",
      ...(item.publishedDate ? { publishedAt: item.publishedDate } : {}),
      provider,
      rank: index + 1,
    }));
}

export interface ExaOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export function createExaProvider(options: ExaOptions): SearchProvider {
  const doFetch = options.fetchImpl ?? fetch;
  return {
    meta: EXA_META,
    async search(req: SearchRequest) {
      const response = await doFetch("https://api.exa.ai/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": options.apiKey,
        },
        body: JSON.stringify({
          query: req.query,
          numResults: req.maxResults,
          type: "neural",
          contents: { text: { maxCharacters: 400 } },
        }),
        signal: req.signal,
      });
      if (!response.ok) throw new Error(`exa HTTP ${response.status}`);
      const payload: unknown = await response.json();
      return { hits: parseExa(payload).slice(0, req.maxResults), raw: payload };
    },
  };
}
