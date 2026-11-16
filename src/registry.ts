import {
  readSub2apiEndpoint,
  resolveApiKey,
  type ProviderConfig,
  type ScoutConfig,
} from "./config.ts";
import {
  createAnySearchProvider,
  ANYSEARCH_META,
} from "./providers/anysearch.ts";
import { createBraveProvider, BRAVE_META } from "./providers/brave.ts";
import {
  createDuckDuckGoProvider,
  DUCKDUCKGO_META,
} from "./providers/duckduckgo.ts";
import {
  createFirecrawlProvider,
  FIRECRAWL_META,
} from "./providers/firecrawl.ts";
import { createProxyPool } from "./network.ts";
import { createDirectProvider, DIRECT_META } from "./providers/direct.ts";
import { createExaProvider, EXA_META } from "./providers/exa.ts";
import {
  createGitHubFetch,
  createGitHubProvider,
  GITHUB_META,
} from "./providers/github.ts";
import { createTavilyProvider, TAVILY_META } from "./providers/tavily.ts";
import { createVercelProvider, VERCEL_META } from "./providers/vercel.ts";
import { createTinyFishProvider, TINYFISH_META } from "./providers/tinyfish.ts";
import { createJinaProvider, JINA_META } from "./providers/jina.ts";
import { createSub2apiProvider, SUB2API_META } from "./providers/sub2api.ts";
import type {
  FetchProvider,
  InspectProvider,
  ProviderMeta,
  SearchProvider,
} from "./types.ts";

export interface Registry {
  search: Map<string, SearchProvider>;
  fetch: Map<string, FetchProvider>;
  inspect: Map<string, InspectProvider>;
  meta: Map<string, ProviderMeta>;
  warnings: string[];
  /** Enabled but missing credentials; shown by /scout, not an error. */
  unconfigured: string[];
}

export interface RegistryOptions {
  fetchImpl?: typeof fetch;
  sessionId?: string;
  env?: NodeJS.ProcessEnv;
}

function metaFor(
  id: string,
  base: ProviderMeta,
  config: ProviderConfig,
): ProviderMeta {
  return {
    ...base,
    weight: config.weight,
    cost: config.cost,
    timeoutMs: config.timeoutMs,
    ...(config.explicitOnly ? { explicitOnly: true } : {}),
  };
}

/** Instantiates only providers that are both configured and usable. A provider
 *  that fails discovery becomes a warning, never a silent absence. */
export function buildRegistry(
  config: ScoutConfig,
  configPath: string,
  options: RegistryOptions = {},
): Registry {
  const pool = createProxyPool({
    proxies: config.network.proxies,
    strategy: config.network.strategy,
    cooldownMs: config.network.cooldownMs,
    routeTimeoutMs: config.network.routeTimeoutMs,
  });
  const fetchFor = (providerId: string): typeof fetch => {
    if (options.fetchImpl) return options.fetchImpl;
    const pinned = config.providers[providerId]?.proxy;
    const routeTimeout = config.providers[providerId]?.timeoutMs;
    return ((url: string | URL | Request, init?: RequestInit) =>
      pool.fetch(
        String(url),
        init,
        pinned,
        routeTimeout,
      )) as unknown as typeof fetch;
  };

  const registry: Registry = {
    search: new Map(),
    fetch: new Map(),
    inspect: new Map(),
    meta: new Map(),
    warnings: [],
    unconfigured: [],
  };

  for (const [id, providerConfig] of Object.entries(config.providers)) {
    if (!providerConfig.enabled) continue;

    if (id === "sub2api") {
      try {
        const endpoint = readSub2apiEndpoint(providerConfig, configPath);
        if (!endpoint.model) {
          registry.warnings.push(
            `sub2api disabled: set search.model in ${endpoint.configPath} (pi-scout has no model context of its own)`,
          );
          continue;
        }
        const provider = createSub2apiProvider({
          endpoint,
          model: endpoint.model,
          sessionId: options.sessionId,
          fetchImpl: fetchFor(id),
        });
        registry.search.set(id, provider);
        registry.inspect.set(id, provider);
        registry.meta.set(id, metaFor(id, SUB2API_META, providerConfig));
      } catch (error) {
        registry.warnings.push(
          `sub2api disabled: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      continue;
    }

    if (id === "tinyfish") {
      const key = resolveApiKey(providerConfig, options.env ?? process.env);
      if (!key) {
        registry.unconfigured.push(id);
        continue;
      }
      const provider = createTinyFishProvider({
        apiKey: key,
        fetchImpl: fetchFor(id),
      });
      registry.search.set(id, provider);
      registry.fetch.set(id, provider);
      registry.meta.set(id, metaFor(id, TINYFISH_META, providerConfig));
      continue;
    }

    if (id === "exa" || id === "tavily" || id === "anysearch") {
      const key = resolveApiKey(providerConfig, options.env ?? process.env);
      if (!key) {
        registry.unconfigured.push(id);
        continue;
      }
      const provider =
        id === "exa"
          ? createExaProvider({ apiKey: key, fetchImpl: fetchFor(id) })
          : id === "tavily"
            ? createTavilyProvider({
                apiKey: key,
                fetchImpl: fetchFor(id),
              })
            : createAnySearchProvider({
                apiKey: key,
                fetchImpl: fetchFor(id),
              });
      registry.search.set(id, provider);
      registry.meta.set(
        id,
        metaFor(
          id,
          id === "exa"
            ? EXA_META
            : id === "tavily"
              ? TAVILY_META
              : ANYSEARCH_META,
          providerConfig,
        ),
      );
      continue;
    }

    if (id === "github") {
      const key = resolveApiKey(providerConfig, options.env ?? process.env);
      if (!key) {
        registry.unconfigured.push(id);
        continue;
      }
      const provider = createGitHubProvider({
        token: key,
        ...(providerConfig.object ? { object: providerConfig.object } : {}),
        fetchImpl: fetchFor(id),
      });
      registry.search.set(id, provider);
      registry.fetch.set(
        id,
        createGitHubFetch({ token: key, fetchImpl: fetchFor(id) }),
      );
      registry.meta.set(id, metaFor(id, GITHUB_META, providerConfig));
      continue;
    }

    if (id === "duckduckgo") {
      registry.search.set(
        id,
        createDuckDuckGoProvider({ fetchImpl: fetchFor(id) }),
      );
      registry.meta.set(id, metaFor(id, DUCKDUCKGO_META, providerConfig));
      continue;
    }

    if (id === "brave" || id === "firecrawl") {
      const key = resolveApiKey(providerConfig, options.env ?? process.env);
      if (!key) {
        registry.unconfigured.push(id);
        continue;
      }
      if (id === "brave") {
        registry.search.set(
          id,
          createBraveProvider({ apiKey: key, fetchImpl: fetchFor(id) }),
        );
        registry.meta.set(id, metaFor(id, BRAVE_META, providerConfig));
      } else {
        const provider = createFirecrawlProvider({
          apiKey: key,
          fetchImpl: fetchFor(id),
        });
        registry.search.set(id, provider);
        registry.fetch.set(id, provider);
        registry.meta.set(id, metaFor(id, FIRECRAWL_META, providerConfig));
      }
      continue;
    }

    if (id === "vercel") {
      const key = resolveApiKey(providerConfig, options.env ?? process.env);
      if (!key) {
        registry.unconfigured.push(id);
        continue;
      }
      if (!providerConfig.model) {
        registry.warnings.push(
          'vercel disabled: set providers.vercel.model (host model id, e.g. "deepseek/deepseek-v4.1-flash")',
        );
        continue;
      }
      const provider = createVercelProvider({
        apiKey: key,
        model: providerConfig.model,
        ...(providerConfig.baseUrl ? { baseUrl: providerConfig.baseUrl } : {}),
        fetchImpl: fetchFor(id),
      });
      registry.search.set(id, provider);
      registry.fetch.set(id, provider);
      registry.meta.set(id, metaFor(id, VERCEL_META, providerConfig));
      continue;
    }

    if (id === "jina") {
      const provider = createJinaProvider({
        fetchImpl: fetchFor(id),
        apiKey: resolveApiKey(providerConfig, options.env ?? process.env),
      });
      registry.fetch.set(id, provider);
      registry.meta.set(id, metaFor(id, JINA_META, providerConfig));
      continue;
    }

    if (id === "direct") {
      const provider = createDirectProvider({
        fetchImpl: fetchFor(id),
        maxBytes: config.fetch.maxBytes,
        allowPrivateHosts: config.security.allowPrivateHosts,
      });
      registry.fetch.set(id, provider);
      registry.meta.set(id, metaFor(id, DIRECT_META, providerConfig));
      continue;
    }

    registry.warnings.push(
      `provider "${id}" is enabled in config but not implemented in this build (0.1.0); skipped`,
    );
  }

  return registry;
}
