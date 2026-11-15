import type {
  InspectAction,
  InspectProvider,
  InspectRequest,
  InspectResult,
  ProviderMeta,
  SearchHit,
  SearchProvider,
  SearchRequest,
} from "../types.ts";
import type { Sub2apiEndpoint } from "../config.ts";
import { canonicalUrl } from "../url.ts";

/** The kit config stores a base URL that may already end in /v1 (it is used
 *  for /models); alpha/search then lives at <base>/alpha/search, not
 *  <base>/v1/alpha/search. Normalising here keeps both shapes working. */
export function alphaSearchUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/v1")
    ? base + "/alpha/search"
    : base + "/v1/alpha/search";
}

export const SUB2API_META: ProviderMeta = {
  id: "sub2api",
  label: "Sub2API Codex remote search",
  capabilities: ["search", "inspect"],
  auth: "gateway",
  cost: 2,
  weight: 3,
  timeoutMs: 15000,
};

const LINK = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
const BARE = /https?:\/\/[^\s<>"')\]]+/g;
const REF_ID = /\bturn\d+[a-z][a-z0-9_-]*\d+\b/gi;

const RECENCY_DAYS: Record<string, number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
};

function lineAround(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? undefined : end);
}

function cleanSnippet(line: string): string {
  return line
    .replace(LINK, "$1")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Sub2API returns an answer-shaped report, not a ranked result list. URLs are
 *  citations in reading order; callers must not treat the order as relevance. */
export function parseCitations(markdown: string, limit = 20): SearchHit[] {
  const found: Array<{ title: string; url: string; index: number }> = [];
  const seen = new Set<string>();

  const push = (title: string, url: string, index: number) => {
    const key = canonicalUrl(url);
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ title: title.trim() || hostOf(url), url: url.trim(), index });
  };

  for (const match of markdown.matchAll(LINK)) {
    push(match[1] ?? "", match[2] ?? "", match.index ?? 0);
  }
  for (const match of markdown.matchAll(BARE)) {
    const url = (match[0] ?? "").replace(/[.,;:]+$/, "");
    push("", url, match.index ?? 0);
  }

  return found
    .sort((a, b) => a.index - b.index)
    .slice(0, limit)
    .map((item, index) => ({
      title: item.title,
      url: item.url,
      snippet: cleanSnippet(lineAround(markdown, item.index)),
      provider: "sub2api",
      rank: index + 1,
      kind: "citation" as const,
    }));
}

export function parseReferenceIds(text: string): string[] {
  return [...new Set(text.match(REF_ID) ?? [])];
}

interface Sub2apiCommand {
  ref_id?: string;
  id?: number;
  pattern?: string;
  pageno?: number;
  lineno?: number;
}

export function inspectCommand(
  action: InspectAction,
  req: InspectRequest,
): Array<Sub2apiCommand> {
  if (!req.refId.trim()) {
    throw new Error(
      `web_inspect ${action} requires ref_id from a previous sub2api search`,
    );
  }
  if (action === "click") {
    if (!Number.isInteger(req.id)) {
      throw new Error(
        "web_inspect click requires the numeric id from the open result",
      );
    }
    return [{ ref_id: req.refId, id: req.id }];
  }
  if (action === "find") {
    if (!req.pattern?.trim())
      throw new Error("web_inspect find requires pattern");
    return [{ ref_id: req.refId, pattern: req.pattern }];
  }
  if (action === "screenshot") {
    return [
      {
        ref_id: req.refId,
        ...(Number.isInteger(req.pageno) ? { pageno: req.pageno } : {}),
      },
    ];
  }
  return [
    {
      ref_id: req.refId,
      ...(Number.isInteger(req.lineno) ? { lineno: req.lineno } : {}),
    },
  ];
}

export interface Sub2apiOptions {
  endpoint: Sub2apiEndpoint;
  model: string;
  sessionId?: string;
  fetchImpl?: typeof fetch;
  maxOutputTokens?: number;
}

export function createSub2apiProvider(
  options: Sub2apiOptions,
): SearchProvider & InspectProvider {
  const doFetch = options.fetchImpl ?? fetch;

  const call = async (
    commands: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ output: string; payload: unknown }> => {
    const body = {
      id: options.sessionId ?? "pi-scout",
      model: options.model,
      commands,
      settings: {
        allowed_callers: ["direct"],
        external_web_access: true,
        search_context_size: "medium",
      },
      max_output_tokens: options.maxOutputTokens ?? 4096,
    };
    const response = await doFetch(alphaSearchUrl(options.endpoint.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.endpoint.key}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(
        `sub2api HTTP ${response.status}${detail ? ": " + detail : ""}`,
      );
    }
    const payload: unknown = await response.json();
    if (
      typeof payload !== "object" ||
      payload === null ||
      typeof (payload as { output?: unknown }).output !== "string" ||
      !(payload as { output: string }).output.trim()
    ) {
      throw new Error("sub2api response lacks a nonempty text output");
    }
    return { output: (payload as { output: string }).output, payload };
  };

  return {
    meta: SUB2API_META,
    async search(req: SearchRequest) {
      const entry: Record<string, unknown> = { q: req.query };
      if (req.recency) entry.recency = RECENCY_DAYS[req.recency];
      if (req.domains?.length) entry.domains = req.domains;
      const { output, payload } = await call(
        { search_query: [entry] },
        req.signal,
      );
      return { hits: parseCitations(output, req.maxResults), raw: payload };
    },
    async inspect(req: InspectRequest): Promise<InspectResult> {
      const { output, payload } = await call(
        { [req.action]: inspectCommand(req.action, req) },
        req.signal,
      );
      return {
        action: req.action,
        text: output,
        referenceIds: parseReferenceIds(output),
        raw: payload,
      };
    },
  };
}
