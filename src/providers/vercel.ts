import type {
  FetchDoc,
  FetchProvider,
  FetchRequest,
  ProviderMeta,
  SearchHit,
  SearchProvider,
  SearchRequest,
} from "../types.ts";

export const VERCEL_META: ProviderMeta = {
  id: "vercel",
  label: "Vercel AI Gateway (DeepSeek search/fetch)",
  capabilities: ["search", "fetch"],
  auth: "key",
  envVar: "AI_GATEWAY_API_KEY",
  cost: 2,
  weight: 2,
  timeoutMs: 30000,
};

export const VERCEL_BASE = "https://ai-gateway.vercel.sh/v1";

const SEARCH_PROMPT =
  "You are a search backend. Use the deepseek search tool, then reply with ONLY a JSON array of the results you received. " +
  'Each item must be {"title": string, "url": string, "snippet": string}. No prose, no code fences.';
const FETCH_PROMPT =
  "Fetch the given URL with the deepseek fetch tool, then reply with the page content verbatim as Markdown. " +
  "Do not summarise, do not add commentary, do not wrap it in code fences.";

function stripFences(text: string): string {
  return text
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/, "")
    .trim();
}

/** The gateway returns a model answer, not raw tool output, so we ask for JSON
 *  and fall back to markdown links when the model ignores the instruction. */
export function parseVercelHits(text: string, limit: number): SearchHit[] {
  const body = stripFences(text);
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(body.slice(start, end + 1)) as Array<{
        title?: string;
        url?: string;
        snippet?: string;
      }>;
      const hits = parsed
        .filter(
          (item) => typeof item.url === "string" && item.url.startsWith("http"),
        )
        .map((item, index) => ({
          title: item.title ?? "",
          url: item.url as string,
          snippet: item.snippet ?? "",
          provider: "vercel",
          rank: index + 1,
        }));
      if (hits.length > 0) return hits.slice(0, limit);
    } catch {
      // fall through to link extraction
    }
  }
  const hits: SearchHit[] = [];
  for (const match of body.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)) {
    hits.push({
      title: match[1] ?? "",
      url: match[2] as string,
      snippet: "",
      provider: "vercel",
      rank: hits.length + 1,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

export interface VercelOptions {
  apiKey: string;
  /** Host model that drives the server tool, e.g. "deepseek/deepseek-v4.1-flash". */
  model: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export function createVercelProvider(
  options: VercelOptions,
): SearchProvider & FetchProvider {
  const doFetch = options.fetchImpl ?? fetch;
  const base = (options.baseUrl ?? VERCEL_BASE).replace(/\/+$/, "");

  const chat = async (
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string> => {
    const response = await doFetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error(`vercel: invalid AI Gateway key (${response.status})`);
    }
    if (response.status === 402) {
      throw new Error(
        "vercel: credit exhausted (402) — monthly free credit used up",
      );
    }
    if (response.status === 429) throw new Error("vercel: rate limited (429)");
    if (!response.ok) throw new Error(`vercel HTTP ${response.status}`);
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = payload.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) throw new Error("vercel: empty model response");
    return text;
  };

  const search: SearchProvider = {
    meta: VERCEL_META,
    async search(req: SearchRequest) {
      const text = await chat(
        {
          model: options.model,
          messages: [
            { role: "system", content: SEARCH_PROMPT },
            { role: "user", content: req.query },
          ],
          tools: [
            {
              type: "vercel:deepseek_search",
              config: {
                query: req.query,
                count: Math.min(50, Math.max(1, req.maxResults)),
              },
            },
          ],
          tool_choice: "required",
          max_tokens: 1500,
        },
        req.signal,
      );
      return { hits: parseVercelHits(text, req.maxResults), raw: { text } };
    },
  };

  const fetchPage = async (req: FetchRequest): Promise<FetchDoc> => {
    const text = await chat(
      {
        model: options.model,
        messages: [
          { role: "system", content: FETCH_PROMPT },
          { role: "user", content: req.url },
        ],
        tools: [{ type: "vercel:deepseek_fetch", config: { url: req.url } }],
        tool_choice: "required",
        max_tokens: 8000,
      },
      req.signal,
    );
    const markdown = stripFences(text);
    const clipped = markdown.slice(0, req.maxChars);
    return {
      url: req.url,
      finalUrl: req.url,
      title: new URL(req.url).hostname,
      markdown: clipped,
      mime: "text/markdown",
      status: 200,
      bytes: Buffer.byteLength(markdown),
      truncated: clipped.length < markdown.length,
      provider: "vercel",
    };
  };

  return Object.assign(search, { fetch: fetchPage }) as SearchProvider &
    FetchProvider;
}
