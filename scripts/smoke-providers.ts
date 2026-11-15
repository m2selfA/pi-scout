/** One live provider probe, pinned to a single provider. Usage:
 *    node scripts/smoke-providers.ts <provider> "<query>"
 * Writes a normal pi-scout run directory and prints one JSON line. */
import { loadConfig } from "../src/config.ts";
import { buildRegistry } from "../src/registry.ts";
import { writeRun } from "../src/provenance.ts";
import { createHash } from "node:crypto";

const provider = process.argv[2];
const query = process.argv[3] ?? "pi coding agent";
if (!provider) {
  console.error("usage: node scripts/smoke-providers.ts <provider> [query]");
  process.exit(2);
}

const loaded = loadConfig();
const registry = buildRegistry(loaded.config, loaded.path);
const impl = registry.search.get(provider);
if (!impl) {
  console.error(
    JSON.stringify({
      provider,
      error: "not available",
      available: [...registry.search.keys()],
      unconfigured: registry.unconfigured,
      warnings: registry.warnings,
    }),
  );
  process.exit(1);
}

const controller = new AbortController();
const timer = setTimeout(
  () => controller.abort(new Error("probe timeout")),
  30000,
);
const started = Date.now();
try {
  const result = await impl.search({
    query,
    maxResults: 5,
    mode: "balanced",
    signal: controller.signal,
    deadline: Date.now() + 30000,
  });
  const run = await writeRun({
    sessionId: "smoke-" + provider,
    kind: "search",
    request: { provider, query },
    report: result.hits
      .map((h, i) => `${i + 1}. ${h.title} — ${h.url}\n   ${h.snippet}`)
      .join("\n"),
    raw: { [provider]: result.raw ?? { hits: result.hits } },
  });
  console.log(
    JSON.stringify({
      provider,
      ok: result.hits.length > 0,
      ms: Date.now() - started,
      hits: result.hits.length,
      sample: result.hits.slice(0, 3).map((h) => ({
        title: h.title.slice(0, 80),
        url: h.url,
        snippet: h.snippet.slice(0, 120),
      })),
      hitsSha256: createHash("sha256")
        .update(JSON.stringify(result.hits))
        .digest("hex")
        .slice(0, 16),
      reportPath: run.reportPath,
      reportSha256: run.reportSha256.slice(0, 16),
    }),
  );
  process.exitCode = result.hits.length > 0 ? 0 : 1;
} catch (error) {
  console.log(
    JSON.stringify({
      provider,
      ok: false,
      ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
}
