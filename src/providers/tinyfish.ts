import type {
  FetchDoc,
  FetchProvider,
  FetchRequest,
  ProviderMeta,
  SearchHit,
  SearchProvider,
  SearchRequest,
} from "../types.ts";

export const TINYFISH_META: ProviderMeta = {
  id: "tinyfish",
  label: "TinyFish",
  capabilities: ["search", "fetch"],
  auth: "key",
  envVar: "TINYFISH_API_KEY",
  cost: 0,
  weight: 2,
  timeoutMs: 15000,
};

export const TINYFISH_SEARCH_URL = "https://api.search.tinyfish.ai";
export const TINYFISH_FETCH_URL = "https://api.fetch.tinyfish.ai";

const RECENCY_MINUTES: Record<string, number> = {
  day: 1440,
  week: 10080,
  month: 43200,
  year: 525600,
};

interface TinyFishItem {
  title?: string;
  url?: string;
  snippet?: string;
  date?: string;
  cited_by_count?: number;
}

export function parseTinyFishSearch(
  payload: unknown,
  provider = "tinyfish",
): SearchHit[] {
  const items = (payload as { results?: TinyFishItem[] } | null)?.results ?? [];
  return items
    .filter((item) => typeof item.url === "string" && item.url.length > 0)
    .map((item, index) => ({
      title: item.title ?? "",
      url: item.url as string,
      snippet: item.snippet ?? "",
      ...(item.date ? { publishedAt: item.date } : {}),
      provider,
      rank: index + 1,
    }));
}

export interface TinyFishOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export function createTinyFishProvider(
  options: TinyFishOptions,
): SearchProvider & FetchProvider {
  const doFetch = options.fetchImpl ?? fetch;

  const searchProvider: SearchProvider = {
    meta: TINYFISH_META,
    async search(req: SearchRequest) {
      const params = new URLSearchParams({ query: req.query });
      if (req.recency) {
        const minutes = RECENCY_MINUTES[req.recency];
        if (minutes) params.set("recency_minutes", String(minutes));
      }
      if (req.domains?.length)
        params.set("include_domains", req.domains.join(","));
      if (req.excludeDomains?.length) {
        params.set("exclude_domains", req.excludeDomains.join(","));
      }
      const response = await doFetch(
        `${TINYFISH_SEARCH_URL}?${params.toString()}`,
        { headers: { "x-api-key": options.apiKey }, signal: req.signal },
      );
      if (!response.ok) {
        throw new Error(`tinyfish search HTTP ${response.status}`);
      }
      const payload: unknown = await response.json();
      return {
        hits: parseTinyFishSearch(payload).slice(0, req.maxResults),
        raw: payload,
      };
    },
  };

  const fetchProvider: FetchProvider = {
    meta: TINYFISH_META,
    async fetch(req: FetchRequest): Promise<FetchDoc> {
      const response = await doFetch(TINYFISH_FETCH_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": options.apiKey,
        },
        body: JSON.stringify({
          urls: [req.url],
          format: "markdown",
          per_url_timeout_ms: Math.max(1000, req.deadline - Date.now()),
        }),
        signal: req.signal,
      });
      if (!response.ok) {
        throw new Error(`tinyfish fetch HTTP ${response.status}`);
      }
      const payload = (await response.json()) as {
        results?: Array<{
          url?: string;
          final_url?: string;
          title?: string | null;
          text?: string | null;
          latency_ms?: number | null;
        }>;
        errors?: Array<{ url: string; error: string }>;
      };
      const first = payload.results?.[0];
      if (!first?.text) {
        const reason = payload.errors?.[0]?.error ?? "no text in response";
        throw new Error(`tinyfish fetch failed: ${reason}`);
      }
      const text = first.text;
      const clipped = text.slice(0, req.maxChars);
      return {
        url: req.url,
        finalUrl: first.final_url ?? first.url ?? req.url,
        title: first.title?.trim() || new URL(req.url).hostname,
        markdown: clipped,
        mime: "text/markdown",
        status: response.status,
        bytes: Buffer.byteLength(text),
        truncated: clipped.length < text.length,
        provider: "tinyfish",
      };
    },
  };

  return Object.assign(searchProvider, {
    fetch: fetchProvider.fetch.bind(fetchProvider),
  }) as SearchProvider & FetchProvider;
}
