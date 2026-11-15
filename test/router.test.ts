import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyIntent, filterHits, planProviders } from "../src/router.ts";

test("intent classification handles English and Chinese", () => {
  assert.equal(classifyIntent("NVDA stock price today"), "finance");
  assert.equal(classifyIntent("今天的股价怎么样"), "finance");
  assert.equal(classifyIntent("arxiv paper on retrieval fusion"), "academic");
  assert.equal(classifyIntent("帮我找几篇论文"), "academic");
  assert.equal(classifyIntent("pi-coding-agent docs"), "docs");
  assert.equal(classifyIntent("github repo for pi extensions"), "code");
  assert.equal(
    classifyIntent("registerTool TypeScript extension implementation"),
    "code",
  );
  assert.equal(classifyIntent("写个插件扩展"), "code");
  assert.equal(classifyIntent("react hooks documentation"), "docs");
  assert.equal(classifyIntent("最新新闻"), "news");
  assert.equal(classifyIntent("how do magnets work"), "general");
});

test("requested providers must be available", () => {
  assert.throws(
    () =>
      planProviders({
        query: "x",
        mode: "balanced",
        maxParallel: 3,
        available: new Set(["exa"]),
        explicitOnly: new Set(),
        requested: "tavily",
      }),
    /not available: tavily/,
  );
});

test("explicit-only providers are never auto-selected", () => {
  const plan = planProviders({
    query: "what happened today",
    mode: "balanced",
    maxParallel: 3,
    available: new Set(["anysearch", "exa", "tavily"]),
    explicitOnly: new Set(["anysearch"]),
  });
  assert.ok(!plan.providers.includes("anysearch"));
});

test("balanced mode caps the provider count at maxParallel", () => {
  const plan = planProviders({
    query: "general question",
    mode: "balanced",
    maxParallel: 2,
    available: new Set(["sub2api", "tavily", "tinyfish", "exa"]),
    explicitOnly: new Set(),
  });
  assert.equal(plan.providers.length, 2);
});

test("filters drop excluded domains and keep unknown dates", () => {
  const now = Date.parse("2026-11-15T00:00:00Z");
  const hits = [
    {
      title: "a",
      url: "https://keep.example/1",
      snippet: "",
      provider: "x",
      rank: 1,
    },
    {
      title: "b",
      url: "https://drop.example/1",
      snippet: "",
      provider: "x",
      rank: 2,
    },
    {
      title: "c",
      url: "https://keep.example/2",
      snippet: "",
      provider: "x",
      rank: 3,
      publishedAt: "2020-01-01T00:00:00Z",
    },
  ];
  const kept = filterHits(
    hits,
    { excludeDomains: ["drop.example"], recency: "month" },
    now,
  );
  assert.deepEqual(
    kept.map((h) => h.url),
    ["https://keep.example/1"],
  );
});
