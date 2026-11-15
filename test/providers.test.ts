import assert from "node:assert/strict";
import { test } from "node:test";
import {
  alphaSearchUrl,
  createSub2apiProvider,
  inspectCommand,
  parseCitations,
  parseReferenceIds,
} from "../src/providers/sub2api.ts";
import { createDirectProvider, htmlToText } from "../src/providers/direct.ts";
import type { InspectRequest } from "../src/types.ts";

const markdown = [
  "A report with [Example A](https://a.example/page?utm_source=x) and a bare link https://b.example/doc.",
  "Another mention of [Example A again](https://a.example/page).",
].join("\n\n");

test("citations are parsed in reading order and deduplicated", () => {
  const hits = parseCitations(markdown, 10);
  assert.deepEqual(
    hits.map((h) => h.url),
    ["https://a.example/page?utm_source=x", "https://b.example/doc"],
  );
  assert.equal(hits[0]!.kind, "citation");
  assert.equal(hits[0]!.rank, 1);
  assert.ok(!hits[0]!.snippet.includes("](http"));
});

test("reference ids are extracted from answer text", () => {
  assert.deepEqual(parseReferenceIds("see turn0search1 and turn2news7"), [
    "turn0search1",
    "turn2news7",
  ]);
});

test("inspect command mapping is explicit about required arguments", () => {
  const base: InspectRequest = {
    action: "open",
    refId: "turn0search1",
    signal: new AbortController().signal,
    deadline: 0,
  };
  assert.deepEqual(inspectCommand("open", { ...base, lineno: 3 }), [
    { ref_id: "turn0search1", lineno: 3 },
  ]);
  assert.deepEqual(
    inspectCommand("click", { ...base, action: "click", id: 2 }),
    [{ ref_id: "turn0search1", id: 2 }],
  );
  assert.throws(
    () => inspectCommand("click", { ...base, action: "click" }),
    /requires the numeric id/,
  );
  assert.throws(
    () => inspectCommand("find", { ...base, action: "find" }),
    /requires pattern/,
  );
  assert.throws(
    () => inspectCommand("open", { ...base, refId: " " }),
    /requires ref_id/,
  );
});

test("alpha/search URL tolerates a base that already ends in /v1", () => {
  assert.equal(
    alphaSearchUrl("https://gw.example"),
    "https://gw.example/v1/alpha/search",
  );
  assert.equal(
    alphaSearchUrl("https://gw.example/v1"),
    "https://gw.example/v1/alpha/search",
  );
  assert.equal(
    alphaSearchUrl("https://gw.example/v1/"),
    "https://gw.example/v1/alpha/search",
  );
});

test("sub2api search sends the alpha/search wire contract", async () => {
  let seen: { url: string; init?: RequestInit } | undefined;
  const fakeFetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    seen = { url: String(url), init };
    return new Response(JSON.stringify({ output: markdown }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const provider = createSub2apiProvider({
    endpoint: { baseUrl: "https://gw.example", key: "k", configPath: "x" },
    model: "gpt-6.1-sol",
    sessionId: "session-1",
    fetchImpl: fakeFetch,
  });
  const result = await provider.search({
    query: "pi coding agent",
    maxResults: 5,
    recency: "week",
    domains: ["github.com"],
    mode: "balanced",
    signal: new AbortController().signal,
    deadline: Date.now() + 1000,
  });

  assert.equal(seen?.url, "https://gw.example/v1/alpha/search");
  const body = JSON.parse(String(seen?.init?.body)) as Record<string, unknown>;
  assert.equal(body.model, "gpt-6.1-sol");
  assert.equal(body.id, "session-1");
  const commands = body.commands as {
    search_query: Array<Record<string, unknown>>;
  };
  assert.deepEqual(commands.search_query[0], {
    q: "pi coding agent",
    recency: 7,
    domains: ["github.com"],
  });
  const settings = body.settings as Record<string, unknown>;
  assert.deepEqual(settings.allowed_callers, ["direct"]);
  assert.equal(settings.external_web_access, true);
  assert.equal(result.hits.length, 2);
});

test("sub2api reports non-2xx without leaking the key", async () => {
  const fakeFetch = (async () =>
    new Response("denied", { status: 403 })) as unknown as typeof fetch;
  const provider = createSub2apiProvider({
    endpoint: {
      baseUrl: "https://gw.example",
      key: "super-secret",
      configPath: "x",
    },
    model: "m",
    fetchImpl: fakeFetch,
  });
  await assert.rejects(
    provider.search({
      query: "q",
      maxResults: 1,
      mode: "fast",
      signal: new AbortController().signal,
      deadline: Date.now() + 1000,
    }),
    (error: Error) =>
      error.message.includes("403") && !error.message.includes("super-secret"),
  );
});

test("html extraction drops scripts and keeps readable text", () => {
  const html = `<html><head><title>Hi &amp; bye</title><style>x{}</style></head>
    <body><script>alert(1)</script><h1>Head</h1><p>One&nbsp;two</p><ul><li>a</li></ul></body></html>`;
  const parsed = htmlToText(html);
  assert.equal(parsed.title, "Hi & bye");
  assert.ok(parsed.text.includes("Head"));
  assert.ok(parsed.text.includes("One two"));
  assert.ok(!parsed.text.includes("alert"));
  assert.ok(!parsed.text.includes("<"));
});

test("direct fetch refuses private hosts before any request", async () => {
  let called = false;
  const provider = createDirectProvider({
    maxBytes: 1024,
    fetchImpl: (async () => {
      called = true;
      return new Response("x");
    }) as unknown as typeof fetch,
  });
  await assert.rejects(
    provider.fetch({
      url: "http://127.0.0.1:8080/x",
      mode: "readable",
      maxChars: 1000,
      signal: new AbortController().signal,
      deadline: Date.now() + 1000,
    }),
    /Refusing to fetch private/,
  );
  assert.equal(called, false);
});
