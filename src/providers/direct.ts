import { extractText } from "unpdf";
import type {
  FetchDoc,
  FetchProvider,
  FetchRequest,
  ProviderMeta,
} from "../types.ts";
import { assertResolvablePublic, type HostResolver } from "../url.ts";

export const DIRECT_META: ProviderMeta = {
  id: "direct",
  label: "Direct HTTP + readable extraction",
  capabilities: ["fetch"],
  auth: "none",
  cost: 0,
  weight: 1,
  timeoutMs: 15000,
};

const UA = "pi-scout/0.4 (+https://github.com/inter/pi-scout)";
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const PDF_FALLBACK_CHARS = 20000;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) {
      const code = Number.parseInt(name.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (name.startsWith("#")) {
      const code = Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

export function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1] ?? "").trim() : "";
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const withBreaks = withoutNoise
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(
      /<\/(p|div|li|tr|h[1-6]|section|article|header|footer|blockquote)>/gi,
      "\n",
    )
    .replace(/<li[^>]*>/gi, "- ");
  const text = decodeEntities(withBreaks.replace(/<[^>]+>/g, " "))
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

async function readCappedBytes(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; total: number; truncated: boolean }> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(
      `Response declares ${declared} bytes, above the ${maxBytes} byte cap`,
    );
  }
  if (!response.body) {
    return { bytes: new Uint8Array(), total: 0, truncated: false };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      const room = maxBytes - (total - value.byteLength);
      chunks.push(value.subarray(0, Math.max(0, room)));
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, total, truncated };
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function isPdf(mime: string, bytes: Uint8Array): boolean {
  if (mime.includes("application/pdf")) return true;
  return (
    bytes.length > 4 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  );
}

async function pdfToText(
  bytes: Uint8Array,
): Promise<{ title: string; text: string; pages: number }> {
  const result = await extractText(bytes, { mergePages: false });
  const pages = Array.isArray(result.text) ? result.text : [result.text];
  const text = pages
    .map((page, index) => `\n\n--- page ${index + 1} ---\n\n${page}`)
    .join("")
    .trim();
  return { title: "", text, pages: pages.length };
}

export interface DirectOptions {
  fetchImpl?: typeof fetch;
  maxBytes: number;
  allowPrivateHosts?: boolean;
  resolveHost?: HostResolver;
}

interface Hop {
  url: string;
  status: number;
}

export function createDirectProvider(options: DirectOptions): FetchProvider {
  const doFetch = options.fetchImpl ?? fetch;
  const allowPrivate = options.allowPrivateHosts ?? false;

  return {
    meta: DIRECT_META,
    async fetch(req: FetchRequest): Promise<FetchDoc> {
      const hops: Hop[] = [];
      let current = req.url;
      let response: Response | undefined;

      for (let index = 0; index <= MAX_REDIRECTS; index += 1) {
        await assertResolvablePublic(
          current,
          allowPrivate,
          options.resolveHost,
        );
        const hopResponse = await doFetch(current, {
          redirect: "manual",
          headers: {
            "user-agent": UA,
            accept:
              "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.5",
          },
          signal: req.signal,
        });
        hops.push({ url: current, status: hopResponse.status });
        const location = hopResponse.headers.get("location");
        if (!REDIRECTS.has(hopResponse.status) || !location) {
          response = hopResponse;
          break;
        }
        await hopResponse.body?.cancel().catch(() => undefined);
        current = new URL(location, current).toString();
        if (index === MAX_REDIRECTS) {
          throw new Error(`Too many redirects (> ${MAX_REDIRECTS})`);
        }
      }
      if (!response) throw new Error("No response after redirect handling");

      const mime = (response.headers.get("content-type") ?? "").toLowerCase();
      if (
        !/\.(html|htm|txt|md|json|xml|pdf)/.test(current) &&
        !/text\/|json|xml|html|pdf/.test(mime)
      ) {
        throw new Error(`Unsupported content type: ${mime || "unknown"}`);
      }

      const { bytes, total, truncated } = await readCappedBytes(
        response,
        options.maxBytes,
      );

      if (isPdf(mime, bytes)) {
        const pdf = await pdfToText(bytes);
        const clipped = pdf.text.slice(0, req.maxChars);
        return {
          url: req.url,
          finalUrl: current,
          title:
            pdf.title ||
            new URL(current).pathname.split("/").filter(Boolean).pop() ||
            new URL(current).hostname,
          markdown: clipped.slice(0, PDF_FALLBACK_CHARS),
          mime: "application/pdf",
          status: response.status,
          bytes: total,
          truncated: truncated || clipped.length < pdf.text.length,
          provider: "direct",
        };
      }

      const text = decodeUtf8(bytes);
      const isHtml = /html/.test(mime) || /^\s*<!doctype html/i.test(text);
      const parsed = isHtml
        ? htmlToText(text)
        : { title: "", text: text.trim() };
      const body =
        req.mode === "raw"
          ? text
          : parsed.text.length > 0
            ? parsed.text
            : text.trim();
      const clipped = body.slice(0, req.maxChars);
      return {
        url: req.url,
        finalUrl: current,
        title: parsed.title || new URL(current).hostname,
        markdown: clipped,
        mime: mime || (isHtml ? "text/html" : "text/plain"),
        status: response.status,
        bytes: total,
        truncated: truncated || clipped.length < body.length,
        provider: "direct",
      };
    },
  };
}
