import type {
  FetchDoc,
  FetchProvider,
  FetchRequest,
  ProviderMeta,
} from "../types.ts";

export const JINA_META: ProviderMeta = {
  id: "jina",
  label: "Jina Reader",
  capabilities: ["fetch"],
  auth: "none",
  cost: 0,
  weight: 1,
  timeoutMs: 20000,
};

export interface JinaOptions {
  fetchImpl?: typeof fetch;
  apiKey?: string;
  baseUrl?: string;
}

export function createJinaProvider(options: JinaOptions = {}): FetchProvider {
  const doFetch = options.fetchImpl ?? fetch;
  const base = (options.baseUrl ?? "https://r.jina.ai").replace(/\/+$/, "");
  return {
    meta: JINA_META,
    async fetch(req: FetchRequest): Promise<FetchDoc> {
      const headers: Record<string, string> = {
        accept: "text/plain, text/markdown;q=0.9",
      };
      if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
      const response = await doFetch(`${base}/${req.url}`, {
        headers,
        signal: req.signal,
      });
      const contentType = (
        response.headers.get("content-type") ?? ""
      ).toLowerCase();
      if (contentType.includes("application/pdf")) {
        throw new Error(
          "jina returned a PDF payload; use the direct provider for PDFs",
        );
      }
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 200);
        throw new Error(
          `jina HTTP ${response.status}${detail ? ": " + detail : ""}`,
        );
      }
      const text = await response.text();
      const titleMatch = text.match(/^Title:\s*(.+)$/m);
      const body = text.replace(
        /^(Title|URL Source|Markdown Content):.*$/gm,
        "",
      );
      const clipped = body.trim().slice(0, req.maxChars);
      return {
        url: req.url,
        finalUrl: req.url,
        title: titleMatch?.[1]?.trim() || new URL(req.url).hostname,
        markdown: clipped,
        mime: "text/markdown",
        status: response.status,
        bytes: Buffer.byteLength(text),
        truncated: clipped.length < body.trim().length,
        provider: "jina",
      };
    },
  };
}
