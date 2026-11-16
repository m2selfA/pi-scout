import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createVercelProvider,
  parseVercelHits,
} from "../src/providers/vercel.ts";

const signal = () => new AbortController().signal;
const req = (query: string) => ({
  query,
  maxResults: 5,
  mode: "balanced" as const,
  signal: signal(),
  deadline: Date.now() + 5000,
});

const reply = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

test("search sends the deepseek_search server tool and parses fenced JSON", async () => {
  let body: Record<string, unknown> | undefined;
  const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return reply(
      '\u0060\u0060\u0060json\n[{"title":"A","url":"https://a.example/1","snippet":"s1"}]\n\u0060\u0060\u0060',
    );
  }) as unknown as typeof fetch;

  const provider = createVercelProvider({
    apiKey: "k",
    model: "deepseek/deepseek-v4.1-flash",
    fetchImpl: fake,
  });
  const result = await provider.search(req("pi coding agent"));

  assert.equal(body?.model, "deepseek/deepseek-v4.1-flash");
  const tools = body?.tools as Array<{
    type: string;
    config: { query: string; count: number };
  }>;
  assert.equal(tools[0]!.type, "vercel:deepseek_search");
  assert.deepEqual(tools[0]!.config, { query: "pi coding agent", count: 5 });
  assert.equal(body?.tool_choice, "required");
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0]!.url, "https://a.example/1");
});

test("markdown link fallback keeps results when the model ignores the JSON request", () => {
  const hits = parseVercelHits(
    "Here are results:\n- [Example](https://example.com/a) and [Two](https://2.example/b)",
    5,
  );
  assert.deepEqual(
    hits.map((h) => h.url),
    ["https://example.com/a", "https://2.example/b"],
  );
});

test("fetch pins the URL in deepseek_fetch config and returns markdown", async () => {
  let body: Record<string, unknown> | undefined;
  const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return reply("# Title\n\nBody text");
  }) as unknown as typeof fetch;

  const provider = createVercelProvider({
    apiKey: "k",
    model: "m",
    fetchImpl: fake,
  });
  const doc = await provider.fetch({
    url: "https://example.com/doc",
    mode: "readable",
    maxChars: 1000,
    signal: signal(),
    deadline: Date.now() + 5000,
  });

  const tools = body?.tools as Array<{ type: string; config: { url: string } }>;
  assert.equal(tools[0]!.type, "vercel:deepseek_fetch");
  assert.equal(tools[0]!.config.url, "https://example.com/doc");
  assert.equal(doc.provider, "vercel");
  assert.match(doc.markdown, /Body text/);
});

test("exhausted credit is reported distinctly", async () => {
  const provider = createVercelProvider({
    apiKey: "k",
    model: "m",
    fetchImpl: (async () =>
      new Response("{}", { status: 402 })) as unknown as typeof fetch,
  });
  await assert.rejects(provider.search(req("q")), /credit exhausted/);
});
