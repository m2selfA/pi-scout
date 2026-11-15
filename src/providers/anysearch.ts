import type {
  ProviderMeta,
  SearchHit,
  SearchProvider,
  SearchRequest,
} from "../types.ts";

export const ANYSEARCH_META: ProviderMeta = {
  id: "anysearch",
  label: "AnySearch",
  capabilities: ["search"],
  auth: "key",
  envVar: "ANYSEARCH_API_KEY",
  cost: 1,
  weight: 1,
  timeoutMs: 15000,
  explicitOnly: true,
};

/** AnySearch answers through MCP with a markdown blob, one section per result. */
export function parseAnySearch(
  text: string,
  provider = "anysearch",
): SearchHit[] {
  const sections = text.split(/^### \d+\. /m).slice(1);
  const hits: SearchHit[] = [];
  for (const section of sections) {
    const lines = section.trim().split("\n");
    const title = (lines[0] ?? "").trim();
    const urlLine = lines.find((line) => line.startsWith("- **URL**:"));
    const url = (urlLine ?? "")
      .replace("- **URL**:", "")
      .replace(/\*\*/g, "")
      .trim();
    const snippet = lines
      .filter(
        (line) =>
          !line.startsWith("- **URL**:") &&
          line.trim() &&
          !line.startsWith("#"),
      )
      .join(" ")
      .slice(0, 300);
    if (title && url) {
      hits.push({ title, url, snippet, provider, rank: hits.length + 1 });
    }
  }
  return hits;
}

export interface AnySearchOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export function createAnySearchProvider(
  options: AnySearchOptions,
): SearchProvider {
  const doFetch = options.fetchImpl ?? fetch;
  return {
    meta: ANYSEARCH_META,
    async search(req: SearchRequest) {
      const response = await doFetch("https://api.anysearch.com/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "search",
            arguments: { query: req.query, max_results: req.maxResults },
          },
        }),
        signal: req.signal,
      });
      if (!response.ok) throw new Error(`anysearch HTTP ${response.status}`);
      const payload = (await response.json()) as {
        result?: { content?: Array<{ text?: string }> };
        error?: { message?: string };
      };
      if (payload.error?.message) {
        throw new Error(`anysearch: ${payload.error.message}`);
      }
      const text = payload.result?.content?.[0]?.text ?? "";
      return {
        hits: parseAnySearch(text).slice(0, req.maxResults),
        raw: payload,
      };
    },
  };
}
