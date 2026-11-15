import assert from "node:assert/strict";
import { test } from "node:test";
import { createBraveProvider, parseBrave } from "../src/providers/brave.ts";
import {
  createDuckDuckGoProvider,
  parseDuckDuckGo,
  unwrapDdgUrl,
} from "../src/providers/duckduckgo.ts";
import {
  createFirecrawlProvider,
  parseFirecrawlSearch,
} from "../src/providers/firecrawl.ts";

const signal = () => new AbortController().signal;
const req = (query: string, extra: Record<string, unknown> = {}) => ({
  query,
  maxResults: 5,
  mode: "balanced" as const,
  signal: signal(),
  deadline: Date.now() + 5000,
  ...extra,
});

test("brave sends the subscription token and maps results", async () => {
  let seen: { url: string; init?: RequestInit } | undefined;
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(url), init };
    return new Response(
      JSON.stringify({
        web: {
          results: [
            {
              title: "A",
              url: "https://a.example",
              description: "<b>snippet</b>",
              page_age: "2026-11-01",
            },
          ],
        },
      }),
    );
  }) as unknown as typeof fetch;

  const provider = createBraveProvider({
    apiKey: "brave-key",
    fetchImpl: fake,
  });
  const result = await provider.search(req("pi agent", { recency: "week" }));
  const url = new URL(seen!.url);
  assert.equal(url.searchParams.get("q"), "pi agent");
  assert.equal(url.searchParams.get("count"), "5");
  assert.equal(url.searchParams.get("freshness"), "pw");
  assert.equal(
    (seen!.init?.headers as Record<string, string>)["x-subscription-token"],
    "brave-key",
  );
  assert.equal(result.hits[0]!.snippet, "snippet");
});

test("brave reports invalid subscription tokens", async () => {
  const provider = createBraveProvider({
    apiKey: "x",
    fetchImpl: (async () =>
      new Response("{}", { status: 401 })) as unknown as typeof fetch,
  });
  await assert.rejects(provider.search(req("q")), /invalid subscription token/);
});

test("duckduckgo unwraps redirect links and parses titles/snippets", () => {
  const html = `
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=1">Example <b>A</b></a>
    <a class="result__snippet" href="#">First <i>snippet</i></a>
    <a rel="nofollow" class="result__a" href="https://example.org/b">Example B</a>
    <a class="result__snippet" href="#">Second snippet</a>`;
  const hits = parseDuckDuckGo(html);
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.url, "https://example.com/a");
  assert.equal(hits[0]!.title, "Example A");
  assert.equal(hits[0]!.snippet, "First snippet");
  assert.equal(unwrapDdgUrl("https://example.com/x"), "https://example.com/x");
});

test("duckduckgo drops sponsored redirect slots", () => {
  const html = `
    <a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=ad.example&u=3">Ad</a>
    <a class="result__a" href="https://real.example/page">Real</a>`;
  const hits = parseDuckDuckGo(html);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.url, "https://real.example/page");
});

test("duckduckgo uses GET and surfaces challenges", async () => {
  let init: RequestInit | undefined;
  let seenUrl = "";
  const ok = createDuckDuckGoProvider({
    fetchImpl: (async (url: string | URL | Request, options?: RequestInit) => {
      seenUrl = String(url);
      init = options;
      return new Response(
        '<a class="result__a" href="https://x.example">X</a>',
      );
    }) as unknown as typeof fetch,
  });
  const result = await ok.search(req("pi agent"));
  assert.equal(init?.method, "GET");
  assert.match(seenUrl, /q=pi\+agent/);
  assert.equal(result.hits.length, 1);

  const blocked = createDuckDuckGoProvider({
    fetchImpl: (async () =>
      new Response("anomaly detected", {
        status: 202,
      })) as unknown as typeof fetch,
  });
  await assert.rejects(blocked.search(req("q")), /challenge or rate limit/);
});

test("firecrawl search maps data arrays", () => {
  const hits = parseFirecrawlSearch({
    success: true,
    data: [
      {
        title: "F",
        url: "https://f.example",
        description: "desc",
        markdown: "md",
      },
    ],
  });
  assert.equal(hits[0]!.title, "F");
  assert.equal(hits[0]!.snippet, "desc");
});

test("firecrawl scrape returns markdown and metadata", async () => {
  let body: Record<string, unknown> | undefined;
  const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          markdown: "# Title\n\nBody",
          metadata: {
            title: "T",
            sourceURL: "https://f.example/final",
            statusCode: 200,
          },
        },
      }),
    );
  }) as unknown as typeof fetch;

  const provider = createFirecrawlProvider({ apiKey: "fc", fetchImpl: fake });
  const doc = await provider.fetch({
    url: "https://f.example",
    mode: "readable",
    maxChars: 1000,
    signal: signal(),
    deadline: Date.now() + 5000,
  });
  assert.deepEqual(body?.formats, ["markdown"]);
  assert.equal(doc.title, "T");
  assert.equal(doc.finalUrl, "https://f.example/final");
  assert.match(doc.markdown, /Body/);
});

test("firecrawl reports payment and auth failures distinctly", async () => {
  const provider = createFirecrawlProvider({
    apiKey: "fc",
    fetchImpl: (async () =>
      new Response("{}", { status: 402 })) as unknown as typeof fetch,
  });
  await assert.rejects(provider.search(req("q")), /payment required/);
});
