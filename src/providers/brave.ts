import type {
  ProviderMeta,
  SearchHit,
  SearchProvider,
  SearchRequest,
} from "../types.ts";

export const BRAVE_META: ProviderMeta = {
  id: "brave",
  label: "Brave Search",
  capabilities: ["search"],
  auth: "key",
  envVar: "BRAVE_API_KEY",
  cost: 1,
  weight: 2,
  timeoutMs: 15000,
};

export const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

const FRESHNESS: Record<string, string> = {
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py",
};

interface BraveResult {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
  page_age?: string;
}

export function parseBrave(payload: unknown): SearchHit[] {
  const items =
    (payload as { web?: { results?: BraveResult[] } } | null)?.web?.results ??
    [];
  return items
    .filter((item) => Boolean(item.url))
    .map((item, index) => ({
      title: item.title ?? "",
      url: item.url as string,
      snippet: (item.description ?? "").replace(/<[^>]+>/g, "").trim(),
      ...((item.page_age ?? item.age)
        ? { publishedAt: item.page_age ?? item.age }
        : {}),
      provider: "brave",
      rank: index + 1,
    }));
}

export interface BraveOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export function createBraveProvider(options: BraveOptions): SearchProvider {
  const doFetch = options.fetchImpl ?? fetch;
  return {
    meta: BRAVE_META,
    async search(req: SearchRequest) {
      const params = new URLSearchParams({
        q: req.query,
        count: String(Math.min(20, Math.max(1, req.maxResults))),
      });
      if (req.recency) params.set("freshness", FRESHNESS[req.recency] ?? "");
      if (req.domains?.length) params.set("site", req.domains[0]!);
      const response = await doFetch(`${BRAVE_ENDPOINT}?${params.toString()}`, {
        headers: {
          accept: "application/json",
          "accept-encoding": "gzip",
          "x-subscription-token": options.apiKey,
        },
        signal: req.signal,
      });
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          `brave: invalid subscription token (${response.status})`,
        );
      }
      if (response.status === 429) {
        throw new Error("brave: rate limited (429)");
      }
      if (!response.ok) throw new Error(`brave HTTP ${response.status}`);
      const payload: unknown = await response.json();
      return {
        hits: parseBrave(payload).slice(0, req.maxResults),
        raw: payload,
      };
    },
  };
}
