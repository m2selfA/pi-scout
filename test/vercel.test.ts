import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createVercelProvider,
  mapDeepSeekHits,
  type GenerateFn,
} from "../src/providers/vercel.ts";

const signal = () => new AbortController().signal;
const searchReq = (query: string) => ({
  query,
  maxResults: 5,
  mode: "balanced" as const,
  signal: signal(),
  deadline: Date.now() + 5000,
});

const searchResult = (query: string, count: number, items: unknown[]) => ({
  toolResults: [{ toolName: "deepseek_search", output: { results: items } }],
  providerMetadata: { gateway: { cost: "0.0001" } },
  _probe: { query, count },
});

test("search calls the deepseek_search tool and maps raw results", async () => {
  let seen: Record<string, unknown> | undefined;
  const generate: GenerateFn = async (options) => {
    seen = options;
    return searchResult("pi agent", 5, [
      {
        title: "A",
        url: "https://a.example/1",
        snippet: "  spaced   snippet ",
        date: "2026-11-01",
      },
      { title: "Bad", url: "mailto:x@y" },
    ]);
  };
  const provider = createVercelProvider({
    apiKey: "k",
    model: "google/gemini-2.5-flash",
    generateImpl: generate,
  });
  const result = await provider.search(searchReq("pi agent"));

  const tools = seen?.tools as Record<
    string,
    { args?: Record<string, unknown> }
  >;
  assert.deepEqual(tools.deepseek_search?.args, {
    query: "pi agent",
    count: 5,
  });
  assert.equal(seen?.toolChoice, "required");
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0]!.url, "https://a.example/1");
  assert.equal(result.hits[0]!.snippet, "spaced snippet");
  assert.equal(result.hits[0]!.publishedAt, "2026-11-01");
});

test("an empty result set fails instead of returning silence", async () => {
  const generate: GenerateFn = async () => searchResult("q", 1, []);
  const provider = createVercelProvider({
    apiKey: "k",
    model: "m",
    generateImpl: generate,
  });
  await assert.rejects(provider.search(searchReq("q")), /returned no results/);
});

test("a missing tool result is reported explicitly", async () => {
  const generate: GenerateFn = async () => ({ toolResults: [] });
  const provider = createVercelProvider({
    apiKey: "k",
    model: "m",
    generateImpl: generate,
  });
  await assert.rejects(provider.search(searchReq("q")), /did not run/);
});

test("gateway auth failures are explained", async () => {
  const generate: GenerateFn = async () => {
    throw Object.assign(new Error("Unauthorized"), { statusCode: 403 });
  };
  const provider = createVercelProvider({
    apiKey: "k",
    model: "m",
    generateImpl: generate,
  });
  await assert.rejects(
    provider.search(searchReq("q")),
    /rejected the request \(403\)/,
  );
});

test("fetch uses deepseek_fetch and returns markdown plus title", async () => {
  let seen: Record<string, unknown> | undefined;
  const generate: GenerateFn = async (options) => {
    seen = options;
    return {
      toolResults: [
        {
          toolName: "deepseek_fetch",
          output: { content: "# Title\n\nBody", title: "Page Title" },
        },
      ],
    };
  };
  const provider = createVercelProvider({
    apiKey: "k",
    model: "m",
    generateImpl: generate,
  });
  const doc = await provider.fetch({
    url: "https://example.com/doc",
    mode: "readable",
    maxChars: 1000,
    signal: signal(),
    deadline: Date.now() + 5000,
  });

  const tools = seen?.tools as Record<
    string,
    { args?: Record<string, unknown> }
  >;
  assert.deepEqual(tools.deepseek_fetch?.args, {
    url: "https://example.com/doc",
  });
  assert.equal(doc.title, "Page Title");
  assert.equal(doc.provider, "vercel");
  assert.match(doc.markdown, /Body/);
});

test("mapDeepSeekHits tolerates missing arrays", () => {
  assert.deepEqual(mapDeepSeekHits(null, 3), []);
  assert.deepEqual(mapDeepSeekHits({}, 3), []);
});
