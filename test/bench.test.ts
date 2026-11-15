import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate, formatStats, percentile } from "../src/bench.ts";
import type { BenchQueryResult } from "../src/bench.ts";
import type { SearchHit } from "../src/types.ts";

const hit = (url: string, provider: string, rank = 1): SearchHit => ({
  title: url,
  url,
  snippet: "",
  provider,
  rank,
});

const results: BenchQueryResult[] = [
  {
    id: "q1",
    query: "one",
    intent: "general",
    runs: [
      {
        provider: "a",
        ok: true,
        ms: 100,
        hits: [hit("https://x/1", "a"), hit("https://x/2", "a")],
      },
      {
        provider: "b",
        ok: true,
        ms: 500,
        hits: [hit("https://x/2", "b"), hit("https://x/3", "b")],
      },
    ],
  },
  {
    id: "q2",
    query: "two",
    intent: "code",
    runs: [
      { provider: "a", ok: true, ms: 300, hits: [hit("https://y/1", "a")] },
      { provider: "b", ok: false, ms: 900, hits: [], error: "boom" },
    ],
  },
];

test("percentile picks nearest-rank values", () => {
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([100], 95), 100);
  assert.equal(percentile([10, 20, 30, 40], 50), 20);
  assert.equal(percentile([10, 20, 30, 40], 95), 40);
});

test("evaluation reports ok rate, latency, coverage and uniqueness", () => {
  const stats = evaluate(results);
  const a = stats.find((s) => s.provider === "a")!;
  const b = stats.find((s) => s.provider === "b")!;

  assert.equal(a.okRate, 1);
  assert.equal(b.okRate, 0.5);
  assert.equal(a.queries, 2);

  assert.equal(a.p50, 100);
  assert.equal(b.p50, 500);

  // q1 union = 3 URLs, A covers 2; q2 A is alone so coverage is 1 → mean 0.833
  assert.ok(Math.abs(a.coverage - 0.8333) < 0.001);
  assert.ok(Math.abs(b.coverage - 0.6667) < 0.001);

  // A contributes one URL nobody else has in both queries
  assert.equal(a.uniqueOnly, 1);
  assert.equal(b.uniqueOnly, 1);

  assert.ok(a.meanJaccard > 0 && a.meanJaccard < 1);
  assert.ok(Math.abs(b.meanJaccard - 0.3333) < 0.001);
});

test("scores rank coverage and speed, and weights stay within 1-3", () => {
  const stats = evaluate(results);
  assert.equal(stats[0]!.provider, "a");
  for (const s of stats) {
    assert.ok(s.suggestedWeight >= 1 && s.suggestedWeight <= 3);
  }
});

test("formatStats emits a markdown table with every provider", () => {
  const table = formatStats(evaluate(results));
  assert.match(table, /\| provider \|/);
  assert.match(table, /\| a \|/);
  assert.match(table, /\| b \|/);
});
