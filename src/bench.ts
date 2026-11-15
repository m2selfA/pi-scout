import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cacheRoot } from "./provenance.ts";
import { canonicalUrl } from "./url.ts";
import type { SearchHit, SearchProvider } from "./types.ts";

export interface BenchQuery {
  id: string;
  query: string;
  intent: string;
}

export interface BenchRun {
  provider: string;
  ok: boolean;
  ms: number;
  hits: SearchHit[];
  error?: string;
}

export interface BenchQueryResult {
  id: string;
  query: string;
  intent: string;
  runs: BenchRun[];
}

export interface ProviderStats {
  provider: string;
  queries: number;
  okRate: number;
  p50: number;
  p95: number;
  avgHits: number;
  /** Mean share of the per-query URL union that this provider returned. */
  coverage: number;
  /** Mean number of URLs per query that only this provider returned. */
  uniqueOnly: number;
  /** Mean Jaccard overlap with the other providers. */
  meanJaccard: number;
  score: number;
  suggestedWeight: number;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
}

export function evaluate(results: BenchQueryResult[]): ProviderStats[] {
  const names = [
    ...new Set(results.flatMap((r) => r.runs.map((x) => x.provider))),
  ];
  const stats: ProviderStats[] = [];

  for (const provider of names) {
    const latencies: number[] = [];
    let okRuns = 0;
    let totalRuns = 0;
    let hitTotal = 0;
    let coverageSum = 0;
    let coverageQueries = 0;
    let uniqueSum = 0;
    let jaccardSum = 0;
    let jaccardCount = 0;

    for (const result of results) {
      const run = result.runs.find((x) => x.provider === provider);
      if (!run) continue;
      totalRuns += 1;
      if (!run.ok) continue;
      okRuns += 1;
      latencies.push(run.ms);
      hitTotal += run.hits.length;
      const mine = new Set(run.hits.map((h) => canonicalUrl(h.url)));
      const others = result.runs.filter((x) => x.provider !== provider && x.ok);
      const union = new Set(mine);
      for (const other of others)
        for (const h of other.hits) union.add(canonicalUrl(h.url));
      if (union.size > 0) {
        coverageSum += mine.size / union.size;
        coverageQueries += 1;
      }
      uniqueSum += [...mine].filter(
        (u) =>
          !others.some((o) => o.hits.some((h) => canonicalUrl(h.url) === u)),
      ).length;
      for (const other of others) {
        const theirs = new Set(other.hits.map((h) => canonicalUrl(h.url)));
        const inter = [...mine].filter((u) => theirs.has(u)).length;
        const uni = new Set([...mine, ...theirs]).size;
        if (uni > 0) {
          jaccardSum += inter / uni;
          jaccardCount += 1;
        }
      }
    }

    const p50 = percentile(latencies, 50);
    const coverage = coverageQueries ? coverageSum / coverageQueries : 0;
    const score = coverage * (1 / (1 + p50 / 3000));
    stats.push({
      provider,
      queries: totalRuns,
      okRate: totalRuns ? okRuns / totalRuns : 0,
      p50,
      p95: percentile(latencies, 95),
      avgHits: okRuns ? hitTotal / okRuns : 0,
      coverage,
      uniqueOnly: coverageQueries ? uniqueSum / coverageQueries : 0,
      meanJaccard: jaccardCount ? jaccardSum / jaccardCount : 0,
      score,
      suggestedWeight: 1,
    });
  }

  const max = Math.max(...stats.map((s) => s.score), 0.0001);
  for (const s of stats) {
    s.suggestedWeight = Math.max(
      1,
      Math.min(3, Math.round(1 + (s.score / max) * 2)),
    );
  }
  return stats.sort((a, b) => b.score - a.score);
}

export interface RunBenchOptions {
  queries: BenchQuery[];
  providers: SearchProvider[];
  maxResults: number;
  timeoutMs: number;
  onProgress?: (done: number, total: number) => void;
}

export async function runBench(
  options: RunBenchOptions,
): Promise<BenchQueryResult[]> {
  const results: BenchQueryResult[] = [];
  for (const query of options.queries) {
    // Providers run concurrently so one slow provider does not inflate the
    // latency measured for the others. Bench numbers are single-shot probes.
    const runs = await Promise.all(
      options.providers.map(async (provider): Promise<BenchRun> => {
        const started = Date.now();
        try {
          const response = await provider.search({
            query: query.query,
            maxResults: options.maxResults,
            mode: "balanced",
            signal: AbortSignal.timeout(options.timeoutMs),
            deadline: Date.now() + options.timeoutMs,
          });
          return {
            provider: provider.meta.id,
            ok: response.hits.length > 0,
            ms: Date.now() - started,
            hits: response.hits,
          };
        } catch (error) {
          return {
            provider: provider.meta.id,
            ok: false,
            ms: Date.now() - started,
            hits: [],
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    runs.sort((a, b) => a.provider.localeCompare(b.provider));
    results.push({
      id: query.id,
      query: query.query,
      intent: query.intent,
      runs,
    });
    options.onProgress?.(results.length, options.queries.length);
  }
  return results;
}

export interface BenchArtifact {
  dir: string;
  reportPath: string;
  resultsPath: string;
}

export async function writeBenchReport(
  results: BenchQueryResult[],
  stats: ProviderStats[],
  meta: Record<string, unknown>,
): Promise<BenchArtifact> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(cacheRoot(), "bench", stamp);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const reportPath = join(dir, "report.md");
  const resultsPath = join(dir, "results.json");
  const report = [
    "# pi-scout bench",
    "",
    "```json",
    JSON.stringify(meta, null, 2),
    "```",
    "",
    formatStats(stats),
    "",
    "Scores: coverage x (1 / (1 + p50/3000)); weight is a 1-3 suggestion, not applied automatically.",
    "",
  ].join("\n");
  await writeFile(reportPath, report, { mode: 0o600 });
  await writeFile(
    resultsPath,
    JSON.stringify({ meta, stats, results }, null, 2) + "\n",
    { mode: 0o600 },
  );
  return { dir, reportPath, resultsPath };
}

export function formatStats(stats: ProviderStats[]): string {
  const lines = [
    "| provider | ok% | p50 | p95 | hits | coverage | unique | jaccard | score | weight |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const s of stats) {
    lines.push(
      `| ${s.provider} | ${(s.okRate * 100).toFixed(1)} | ${Math.round(s.p50)} | ${Math.round(s.p95)} | ${s.avgHits.toFixed(1)} | ${(s.coverage * 100).toFixed(1)}% | ${s.uniqueOnly.toFixed(1)} | ${(s.meanJaccard * 100).toFixed(1)}% | ${s.score.toFixed(3)} | ${s.suggestedWeight} |`,
    );
  }
  return lines.join("\n");
}
