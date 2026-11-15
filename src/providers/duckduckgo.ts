import type {
  ProviderMeta,
  SearchHit,
  SearchProvider,
  SearchRequest,
} from "../types.ts";

export const DUCKDUCKGO_META: ProviderMeta = {
  id: "duckduckgo",
  label: "DuckDuckGo HTML",
  capabilities: ["search"],
  auth: "none",
  cost: 0,
  weight: 1,
  timeoutMs: 15000,
};

export const DDG_ENDPOINT = "https://html.duckduckgo.com/html/";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** DDG wraps results in /l/?uddg=<urlencoded target>&rut=... */
export function unwrapDdgUrl(href: string): string {
  try {
    const url = new URL(href, "https://duckduckgo.com");
    const target = url.searchParams.get("uddg");
    return target ? decodeURIComponent(target) : url.toString();
  } catch {
    return href;
  }
}

export function parseDuckDuckGo(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const linkRe =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe =
    /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets = [...html.matchAll(snippetRe)].map((match) =>
    stripTags(match[1] ?? ""),
  );
  let index = 0;
  for (const match of html.matchAll(linkRe)) {
    const url = unwrapDdgUrl(match[1] ?? "");
    const title = stripTags(match[2] ?? "");
    if (!url.startsWith("http")) continue;
    // Sponsored slots are wrapped in duckduckgo.com/y.js redirects with ad
    // metadata; they are never useful as evidence.
    if (/^https?:\/\/duckduckgo\.com\/y\.js/.test(url)) continue;
    if (/[?&]ad_provider=|ad_domain=/.test(url)) continue;
    hits.push({
      title,
      url,
      snippet: snippets[index] ?? "",
      provider: "duckduckgo",
      rank: index + 1,
    });
    index += 1;
  }
  return hits;
}

export interface DuckDuckGoOptions {
  fetchImpl?: typeof fetch;
}

export function createDuckDuckGoProvider(
  options: DuckDuckGoOptions = {},
): SearchProvider {
  const doFetch = options.fetchImpl ?? fetch;
  return {
    meta: DUCKDUCKGO_META,
    async search(req: SearchRequest) {
      // GET is served; the POST form triggers a 202 anti-bot challenge.
      const params = new URLSearchParams({ q: req.query });
      const response = await doFetch(`${DDG_ENDPOINT}?${params.toString()}`, {
        method: "GET",
        headers: { "user-agent": UA, accept: "text/html" },
        signal: req.signal,
      });
      if (response.status === 202 || response.status === 429) {
        throw new Error(
          `duckduckgo: challenge or rate limit (HTTP ${response.status}); try a proxy or another provider`,
        );
      }
      if (!response.ok) throw new Error(`duckduckgo HTTP ${response.status}`);
      const html = await response.text();
      const hits = parseDuckDuckGo(html);
      if (hits.length === 0 && /anomaly|challenge/i.test(html)) {
        throw new Error("duckduckgo: anti-bot challenge page returned");
      }
      return { hits: hits.slice(0, req.maxResults), raw: { html } };
    },
  };
}
