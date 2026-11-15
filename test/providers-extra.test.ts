import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAnySearchProvider,
  parseAnySearch,
} from "../src/providers/anysearch.ts";
import { createExaProvider } from "../src/providers/exa.ts";
import { createTavilyProvider } from "../src/providers/tavily.ts";
import {
  createTinyFishProvider,
  parseTinyFishSearch,
} from "../src/providers/tinyfish.ts";

const signal = () => new AbortController().signal;
const req = (query: string, extra: Record<string, unknown> = {}) => ({
  query,
  maxResults: 5,
  mode: "balanced" as const,
  signal: signal(),
  deadline: Date.now() + 5000,
  ...extra,
});

test("tinyfish search uses GET with x-api-key and recency/domain params", async () => {
  let seen: { url: string; init?: RequestInit } | undefined;
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(url), init };
    return new Response(
      JSON.stringify({
        results: [
          {
            title: "A",
            url: "https://a.example/1",
            snippet: "s1",
            date: "2026-11-01",
          },
          { title: "B", url: "https://b.example/2", snippet: "s2" },
        ],
      }),
    );
  }) as unknown as typeof fetch;

  const provider = createTinyFishProvider({
    apiKey: "tf-key",
    fetchImpl: fake,
  });
  const result = await provider.search(
    req("pi agent", { recency: "week", domains: ["github.com"] }),
  );
  const url = new URL(seen!.url);
  assert.equal(url.origin, "https://api.search.tinyfish.ai");
  assert.equal(url.pathname, "/");
  assert.equal(url.searchParams.get("query"), "pi agent");
  assert.equal(url.searchParams.get("recency_minutes"), "10080");
  assert.equal(url.searchParams.get("include_domains"), "github.com");
  assert.equal(
    (seen!.init?.headers as Record<string, string>)["x-api-key"],
    "tf-key",
  );
  assert.equal(result.hits.length, 2);
  assert.equal(result.hits[0]!.publishedAt, "2026-11-01");
});

test("tinyfish fetch posts urls and maps markdown", async () => {
  let body: Record<string, unknown> | undefined;
  const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        results: [
          {
            url: "https://a.example",
            final_url: "https://a.example/",
            title: "A",
            text: "# hi\nbody",
          },
        ],
      }),
    );
  }) as unknown as typeof fetch;
  const provider = createTinyFishProvider({ apiKey: "k", fetchImpl: fake });
  const doc = await provider.fetch({
    url: "https://a.example",
    mode: "readable",
    maxChars: 1000,
    signal: signal(),
    deadline: Date.now() + 5000,
  });
  assert.deepEqual(body?.urls, ["https://a.example"]);
  assert.equal(body?.format, "markdown");
  assert.equal(doc.title, "A");
  assert.match(doc.markdown, /body/);
});

test("exa sends x-api-key and maps text to snippet", async () => {
  let init: RequestInit | undefined;
  const fake = (async (_url: string | URL | Request, options?: RequestInit) => {
    init = options;
    return new Response(
      JSON.stringify({
        results: [
          {
            title: "E",
            url: "https://e.example",
            text: "exa text",
            publishedDate: "2026-10-01",
          },
        ],
      }),
    );
  }) as unknown as typeof fetch;
  const provider = createExaProvider({ apiKey: "exa-key", fetchImpl: fake });
  const result = await provider.search(req("q"));
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  assert.equal(body.numResults, 5);
  assert.equal(body.type, "neural");
  assert.equal(
    (init?.headers as Record<string, string>)["x-api-key"],
    "exa-key",
  );
  assert.equal(result.hits[0]!.snippet, "exa text");
});

test("tavily sends api_key in body and maps content", async () => {
  let body: Record<string, unknown> | undefined;
  const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        results: [{ title: "T", url: "https://t.example", content: "c" }],
      }),
    );
  }) as unknown as typeof fetch;
  const provider = createTavilyProvider({ apiKey: "tv-key", fetchImpl: fake });
  const result = await provider.search(req("q"));
  assert.equal(body?.api_key, "tv-key");
  assert.equal(body?.max_results, 5);
  assert.equal(result.hits[0]!.snippet, "c");
});

test("anysearch parses its markdown MCP answer", () => {
  const text = [
    "### 1. Example One",
    "- **URL**: https://one.example/a",
    "First snippet line.",
    "",
    "### 2. Example Two",
    "- **URL**: https://two.example/b",
    "Second snippet.",
  ].join("\n");
  const hits = parseAnySearch(text);
  assert.deepEqual(
    hits.map((h) => [h.title, h.url]),
    [
      ["Example One", "https://one.example/a"],
      ["Example Two", "https://two.example/b"],
    ],
  );
  assert.match(hits[0]!.snippet, /First snippet/);
});

test("anysearch sends a JSON-RPC tools/call envelope", async () => {
  let body: Record<string, unknown> | undefined;
  const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        result: {
          content: [{ text: "### 1. X\n- **URL**: https://x.example\nx" }],
        },
      }),
    );
  }) as unknown as typeof fetch;
  const provider = createAnySearchProvider({
    apiKey: "as-key",
    fetchImpl: fake,
  });
  const result = await provider.search(req("stock price"));
  assert.equal(body?.method, "tools/call");
  assert.equal((body?.params as any).name, "search");
  assert.equal(result.hits.length, 1);
});

test("tinyfish parser tolerates missing urls", () => {
  assert.deepEqual(parseTinyFishSearch({ results: [{ title: "no url" }] }), []);
});
