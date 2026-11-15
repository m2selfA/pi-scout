import type {
  FetchDoc,
  FetchProvider,
  FetchRequest,
  ProviderMeta,
  SearchHit,
  SearchProvider,
  SearchRequest,
} from "../types.ts";

export const FIRECRAWL_META: ProviderMeta = {
  id: "firecrawl",
  label: "Firecrawl",
  capabilities: ["search", "fetch"],
  auth: "key",
  envVar: "FIRECRAWL_API_KEY",
  cost: 2,
  weight: 1,
  timeoutMs: 20000,
};

export const FIRECRAWL_API = "https://api.firecrawl.dev/v1";

interface FirecrawlItem {
  title?: string;
  url?: string;
  description?: string;
  markdown?: string;
}

function itemsOf(payload: unknown): FirecrawlItem[] {
  const data = (payload as { data?: unknown } | null)?.data;
  if (Array.isArray(data)) return data as FirecrawlItem[];
  const web = (data as { web?: FirecrawlItem[] } | null)?.web;
  return Array.isArray(web) ? web : [];
}

export function parseFirecrawlSearch(payload: unknown): SearchHit[] {
  return itemsOf(payload)
    .filter((item) => Boolean(item.url))
    .map((item, index) => ({
      title: item.title ?? "",
      url: item.url as string,
      snippet: (item.description ?? item.markdown ?? "").slice(0, 300),
      provider: "firecrawl",
      rank: index + 1,
    }));
}

export interface FirecrawlOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
}

function errorFor(status: number): string {
  if (status === 401) return "firecrawl: invalid API key (401)";
  if (status === 402)
    return "firecrawl: payment required (402) — check credits";
  if (status === 429) return "firecrawl: rate limited (429)";
  return `firecrawl HTTP ${status}`;
}

export function createFirecrawlProvider(
  options: FirecrawlOptions,
): SearchProvider & FetchProvider {
  const doFetch = options.fetchImpl ?? fetch;
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${options.apiKey}`,
  };

  const search: SearchProvider = {
    meta: FIRECRAWL_META,
    async search(req: SearchRequest) {
      const response = await doFetch(`${FIRECRAWL_API}/search`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          query: req.query,
          limit: Math.min(20, Math.max(1, req.maxResults)),
        }),
        signal: req.signal,
      });
      if (!response.ok) throw new Error(errorFor(response.status));
      const payload: unknown = await response.json();
      return {
        hits: parseFirecrawlSearch(payload).slice(0, req.maxResults),
        raw: payload,
      };
    },
  };

  const fetchPage = async (req: FetchRequest): Promise<FetchDoc> => {
    const response = await doFetch(`${FIRECRAWL_API}/scrape`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        url: req.url,
        formats: ["markdown"],
        onlyMainContent: true,
      }),
      signal: req.signal,
    });
    if (!response.ok) throw new Error(errorFor(response.status));
    const payload = (await response.json()) as {
      success?: boolean;
      data?: {
        markdown?: string;
        metadata?: {
          title?: string;
          sourceURL?: string;
          statusCode?: number;
          contentType?: string;
        };
      };
    };
    const markdown = payload.data?.markdown ?? "";
    if (!markdown.trim()) throw new Error("firecrawl: empty markdown result");
    const clipped = markdown.slice(0, req.maxChars);
    return {
      url: req.url,
      finalUrl: payload.data?.metadata?.sourceURL ?? req.url,
      title: payload.data?.metadata?.title ?? new URL(req.url).hostname,
      markdown: clipped,
      mime: payload.data?.metadata?.contentType ?? "text/markdown",
      status: payload.data?.metadata?.statusCode ?? 200,
      bytes: Buffer.byteLength(markdown),
      truncated: clipped.length < markdown.length,
      provider: "firecrawl",
    };
  };

  return Object.assign(search, { fetch: fetchPage }) as SearchProvider &
    FetchProvider;
}
