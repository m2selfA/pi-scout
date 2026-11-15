import assert from "node:assert/strict";
import { test } from "node:test";
import { fuse } from "../src/fusion.ts";
import type { SearchHit } from "../src/types.ts";

const hit = (url: string, rank: number, provider: string): SearchHit => ({
  title: "T " + rank,
  url,
  snippet: "snippet " + rank,
  provider,
  rank,
});

test("same page from two providers becomes one entry with both attributed", () => {
  const result = fuse(
    [
      {
        provider: "a",
        weight: 1,
        hits: [hit("https://example.com/x?utm_source=z", 1, "a")],
      },
      {
        provider: "b",
        weight: 1,
        hits: [hit("https://www.example.com/x", 1, "b")],
      },
    ],
    { k: 60, consensus: 0.15, domainCap: 2, limit: 10 },
  );
  assert.equal(result.hits.length, 1);
  assert.deepEqual(result.hits[0]!.providers.sort(), ["a", "b"]);
  assert.ok(result.hits[0]!.consensus > 0);
});

test("RRF prefers the provider with the higher weight", () => {
  const result = fuse(
    [
      {
        provider: "strong",
        weight: 3,
        hits: [hit("https://a.example/1", 1, "strong")],
      },
      {
        provider: "weak",
        weight: 1,
        hits: [hit("https://b.example/1", 1, "weak")],
      },
    ],
    { k: 60, consensus: 0, domainCap: 2, limit: 10 },
  );
  assert.equal(result.hits[0]!.canonicalUrl, "https://a.example/1");
});

test("citations cannot outrank ranked results at equal weight", () => {
  const citation: SearchHit = {
    ...hit("https://c.example/1", 1, "sub2api"),
    kind: "citation",
  };
  const ranked = hit("https://r.example/1", 1, "exa");
  const result = fuse(
    [
      { provider: "sub2api", weight: 1, hits: [citation] },
      { provider: "exa", weight: 1, hits: [ranked] },
    ],
    { k: 60, consensus: 0, domainCap: 2, limit: 10 },
  );
  assert.equal(result.hits[0]!.canonicalUrl, "https://r.example/1");
});

test("domain cap is a preference, not a truncation", () => {
  const hits = [1, 2, 3].map((n) => hit("https://same.example/" + n, n, "a"));
  const result = fuse([{ provider: "a", weight: 1, hits }], {
    k: 60,
    consensus: 0,
    domainCap: 1,
    limit: 3,
  });
  assert.equal(result.hits.length, 3);
  assert.equal(result.domainCappedOut, 0);
});

test("fusion is deterministic", () => {
  const inputs = [
    {
      provider: "a",
      weight: 2,
      hits: [
        hit("https://x.example/1", 1, "a"),
        hit("https://x.example/2", 2, "a"),
      ],
    },
    { provider: "b", weight: 1, hits: [hit("https://x.example/2", 1, "b")] },
  ];
  const one = fuse(inputs, { k: 60, consensus: 0.15, domainCap: 2, limit: 5 });
  const two = fuse(inputs, { k: 60, consensus: 0.15, domainCap: 2, limit: 5 });
  assert.deepEqual(one, two);
});
