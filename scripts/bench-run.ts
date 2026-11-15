import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.ts";
import { buildRegistry } from "../src/registry.ts";
import {
  evaluate,
  formatStats,
  runBench,
  writeBenchReport,
  type BenchQuery,
} from "../src/bench.ts";
const providers = (process.argv[2] ?? "tinyfish,exa,tavily,github").split(",");
const limit = Number(process.argv[3] ?? "40");
const loaded = loadConfig();
const registry = buildRegistry(loaded.config, loaded.path);
const queries = (
  JSON.parse(
    readFileSync(new URL("../bench/queries.json", import.meta.url), "utf8"),
  ) as BenchQuery[]
).slice(0, limit);
const selected = providers.filter((id) => registry.search.has(id));
console.log(
  "running",
  queries.length,
  "queries x",
  selected.length,
  "providers",
);
const started = Date.now();
const results = await runBench({
  queries,
  providers: selected.map((id) => registry.search.get(id)!),
  maxResults: 5,
  timeoutMs: 20000,
});
const stats = evaluate(results);
const artifact = await writeBenchReport(results, stats, {
  providers: selected,
  queries: queries.length,
  maxResults: 5,
  elapsedMs: Date.now() - started,
});
console.log(formatStats(stats));
console.log(
  JSON.stringify({
    report: artifact.reportPath,
    results: artifact.resultsPath,
    elapsedMs: Date.now() - started,
  }),
);
