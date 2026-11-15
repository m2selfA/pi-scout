/** Free, no-key live probe for the fetch path, routed through the configured
 *  proxy pool. Run: node scripts/smoke-fetch.ts [url] */
import { createHash } from "node:crypto";
import { loadConfig } from "../src/config.ts";
import { buildRegistry } from "../src/registry.ts";

const url = process.argv[2] ?? "https://example.com";
const loaded = loadConfig();
const registry = buildRegistry(loaded.config, loaded.path);

const results: Array<Record<string, unknown>> = [];
for (const id of loaded.config.fetch.cascade) {
  const provider = registry.fetch.get(id);
  if (!provider) continue;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("probe timeout")),
    40000,
  );
  const started = Date.now();
  try {
    const doc = await provider.fetch({
      url,
      mode: "readable",
      maxChars: 4000,
      signal: controller.signal,
      deadline: Date.now() + 40000,
    });
    results.push({
      provider: id,
      ok: doc.markdown.trim().length > 0,
      status: doc.status,
      ms: Date.now() - started,
      bytes: doc.bytes,
      title: doc.title,
      chars: doc.markdown.length,
      sha256: createHash("sha256")
        .update(doc.markdown)
        .digest("hex")
        .slice(0, 16),
      sample: doc.markdown.replace(/\s+/g, " ").slice(0, 100),
    });
  } catch (error) {
    results.push({
      provider: id,
      ok: false,
      ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timer);
  }
}

for (const result of results) console.log(JSON.stringify(result));
process.exitCode = results.some((r) => r.ok) ? 0 : 1;
