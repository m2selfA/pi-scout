import { loadConfig } from "../src/config.ts";
import { buildRegistry } from "../src/registry.ts";
const loaded = loadConfig();
const registry = buildRegistry(loaded.config, loaded.path);
console.log(
  JSON.stringify(
    {
      config: loaded.path,
      exists: loaded.exists,
      search: [...registry.search.keys()],
      fetch: [...registry.fetch.keys()],
      inspect: [...registry.inspect.keys()],
      unconfigured: registry.unconfigured,
      warnings: registry.warnings,
      network: loaded.config.network,
    },
    null,
    1,
  ),
);
