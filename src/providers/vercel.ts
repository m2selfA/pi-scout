import { generateText } from "ai";
import { createGateway } from "@ai-sdk/gateway";
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
  label: "Vercel AI Gateway (DeepSeek search/fetch tools)",
  capabilities: ["search", "fetch"],
  auth: "key",
  envVar: "AI_GATEWAY_API_KEY",
  cost: 2,
  weight: 2,
  timeoutMs: 60000,
};

interface DeepSeekSearchItem {
  title?: string | null;
  url?: string | null;
  snippet?: string | null;
  summary?: string | null;
  content?: string | null;
  date?: string | null;
  site_name?: string | null;
}

interface ToolResultLike {
  toolName?: string;
  output?: unknown;
}

/** Injected so tests can replay recorded tool results without the network. */
export type GenerateFn = (options: Record<string, unknown>) => Promise<{
  toolResults?: ToolResultLike[];
  providerMetadata?: Record<string, unknown>;
}>;

export function mapDeepSeekHits(payload: unknown, limit: number): SearchHit[] {
  const results = (payload as { results?: DeepSeekSearchItem[] } | null)
    ?.results;
  if (!Array.isArray(results)) return [];
  return results
    .filter(
      (item) => typeof item.url === "string" && item.url.startsWith("http"),
    )
    .slice(0, limit)
    .map((item, index) => ({
      title: item.title ?? "",
      url: item.url as string,
      snippet: (item.snippet ?? item.summary ?? item.content ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 400),
      ...(item.date ? { publishedAt: item.date } : {}),
      provider: "vercel",
      rank: index + 1,
    }));
}

export interface VercelOptions {
  apiKey: string;
  /** Host model that drives the server tool, e.g. "google/gemini-2.5-flash". */
  model: string;
  /** Overrides the SDK base URL (default https://ai-gateway.vercel.sh/v4/ai). */
  baseUrl?: string;
  /** Proxy-aware fetch, so gateway calls honour the pi-scout route pool. */
  fetch?: typeof fetch;
  generateImpl?: GenerateFn;
}

function statusOf(error: unknown): number | undefined {
  const candidate = error as {
    statusCode?: unknown;
    cause?: { statusCode?: unknown };
  };
  const raw = candidate?.statusCode ?? candidate?.cause?.statusCode;
  return typeof raw === "number" ? raw : undefined;
}

function explain(error: unknown): Error {
  const status = statusOf(error);
  if (status === 401 || status === 403) {
    return new Error(
      `vercel: AI Gateway rejected the request (${status}); check the key and whether the host model is available on the free tier`,
    );
  }
  if (status === 402) {
    return new Error(
      "vercel: credit exhausted (402) — monthly free credit used up",
    );
  }
  if (status === 429) return new Error("vercel: rate limited (429)");
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`vercel: ${message.slice(0, 300)}`);
}

export function createVercelProvider(
  options: VercelOptions,
): SearchProvider & FetchProvider {
  const gateway = createGateway({
    apiKey: options.apiKey,
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    ...(options.fetch ? { fetch: options.fetch as never } : {}),
  });
  const generate: GenerateFn =
    options.generateImpl ??
    ((request) =>
      generateText(request as never) as unknown as ReturnType<GenerateFn>);

  const run = async (
    tool: Record<string, unknown>,
    prompt: string,
    signal: AbortSignal,
    toolName: string,
  ): Promise<unknown> => {
    let response: Awaited<ReturnType<GenerateFn>>;
    try {
      response = await generate({
        model: gateway(options.model),
        prompt,
        tools: tool,
        toolChoice: "required",
        // Gemini-class hosts spend reasoning tokens before the tool call, so a
        // tight cap produces ToolChoiceViolationError instead of a result.
        maxOutputTokens: 300,
        maxRetries: 0,
        abortSignal: signal,
      });
    } catch (error) {
      throw explain(error);
    }
    const match = (response.toolResults ?? []).find(
      (result) => result.toolName === toolName,
    );
    if (!match) {
      throw new Error(
        `vercel: ${toolName} did not run (model returned no tool result)`,
      );
    }
    return match.output;
  };

  const search: SearchProvider = {
    meta: VERCEL_META,
    async search(req: SearchRequest) {
      const output = await run(
        {
          deepseek_search: gateway.tools.deepseekSearch({
            query: req.query,
            count: Math.min(50, Math.max(1, req.maxResults)),
          }),
        },
        req.query,
        req.signal,
        "deepseek_search",
      );
      const hits = mapDeepSeekHits(output, req.maxResults);
      if (hits.length === 0) {
        throw new Error("vercel: deepseek_search returned no results");
      }
      return { hits, raw: output };
    },
  };

  const fetchPage = async (req: FetchRequest): Promise<FetchDoc> => {
    const output = (await run(
      { deepseek_fetch: gateway.tools.deepseekFetch({ url: req.url }) },
      `Fetch ${req.url}`,
      req.signal,
      "deepseek_fetch",
    )) as { content?: string; title?: string } | null;
    const markdown = (output?.content ?? "").trim();
    if (!markdown)
      throw new Error("vercel: deepseek_fetch returned empty content");
    const clipped = markdown.slice(0, req.maxChars);
    return {
      url: req.url,
      finalUrl: req.url,
      title: output?.title?.trim() || new URL(req.url).hostname,
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
