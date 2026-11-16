import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PREFERENCES,
  INTENTS,
  type PreferenceTable,
} from "./router.ts";
import type { Cost, RouteMode, SearchMode } from "./types.ts";

export const DEFAULT_CONFIG_PATH = join(
  homedir(),
  ".pi",
  "agent",
  "pi-scout.json",
);

export const KIT_CONFIG_PATH = join(
  homedir(),
  ".pi",
  "agent",
  "pi-sub2api-kit.json",
);

export type ProxyStrategy =
  "direct-first" | "proxy-first" | "proxy-only" | "direct-only";

export interface ProviderConfig {
  enabled: boolean;
  weight: number;
  cost: Cost;
  timeoutMs: number;
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  configPath?: string;
  model?: string;
  /** GitHub search object: repositories (default), issues or code. */
  object?: "repositories" | "issues" | "code";
  explicitOnly: boolean;
  /** "auto" follows network.strategy, "none" forces direct, a URL pins one proxy. */
  proxy?: "auto" | "none" | string;
}

export interface NetworkConfig {
  proxies: string[];
  strategy: ProxyStrategy;
  cooldownMs: number;
  routeTimeoutMs: number;
}

export interface ScoutConfig {
  version: 1;
  mode: SearchMode;
  toolNames: { search: string; fetch: string; inspect: string };
  routing: {
    search: {
      mode: RouteMode;
      maxParallel: number;
      hedgeMs: number;
      deadlineMs: number;
    };
    fetch: { mode: RouteMode; deadlineMs: number };
  };
  fusion: { k: number; consensus: number; domainCap: number };
  preferences: PreferenceTable;
  providers: Record<string, ProviderConfig>;
  fetch: {
    cascade: string[];
    minChars: number;
    maxBytes: number;
    maxChars: number;
    spillThreshold: number;
  };
  network: NetworkConfig;
  security: { allowPrivateHosts: boolean };
}

export interface LoadedConfig {
  config: ScoutConfig;
  path: string;
  exists: boolean;
}

const PROVIDER_IDS = [
  "sub2api",
  "tinyfish",
  "anysearch",
  "exa",
  "tavily",
  "github",
  "brave",
  "vercel",
  "duckduckgo",
  "jina",
  "direct",
  "firecrawl",
] as const;

type ProviderId = (typeof PROVIDER_IDS)[number];

const PROVIDER_TUNING: Record<
  ProviderId,
  {
    weight: number;
    cost: Cost;
    timeoutMs: number;
    explicitOnly: boolean;
    env?: string;
  }
> = {
  sub2api: { weight: 3, cost: 2, timeoutMs: 15000, explicitOnly: false },
  tinyfish: {
    weight: 2,
    cost: 0,
    timeoutMs: 15000,
    explicitOnly: false,
    env: "TINYFISH_API_KEY",
  },
  anysearch: {
    weight: 1,
    cost: 1,
    timeoutMs: 15000,
    explicitOnly: true,
    env: "ANYSEARCH_API_KEY",
  },
  exa: {
    weight: 2,
    cost: 1,
    timeoutMs: 15000,
    explicitOnly: false,
    env: "EXA_API_KEY",
  },
  tavily: {
    weight: 2,
    cost: 1,
    timeoutMs: 15000,
    explicitOnly: false,
    env: "TAVILY_API_KEY",
  },
  github: {
    weight: 2,
    cost: 0,
    timeoutMs: 15000,
    explicitOnly: false,
    env: "GITHUB_TOKEN",
  },
  vercel: {
    weight: 2,
    cost: 2,
    timeoutMs: 30000,
    explicitOnly: false,
    env: "AI_GATEWAY_API_KEY",
  },
  brave: {
    weight: 2,
    cost: 1,
    timeoutMs: 15000,
    explicitOnly: false,
    env: "BRAVE_API_KEY",
  },
  duckduckgo: { weight: 1, cost: 0, timeoutMs: 10000, explicitOnly: false },
  jina: {
    weight: 1,
    cost: 0,
    timeoutMs: 20000,
    explicitOnly: false,
    env: "JINA_API_KEY",
  },
  direct: { weight: 1, cost: 0, timeoutMs: 15000, explicitOnly: false },
  firecrawl: {
    weight: 1,
    cost: 2,
    timeoutMs: 20000,
    explicitOnly: false,
    env: "FIRECRAWL_API_KEY",
  },
};

function providerDefaults(id: ProviderId): ProviderConfig {
  const tuning = PROVIDER_TUNING[id];
  const base: ProviderConfig = {
    enabled: true,
    weight: tuning.weight,
    cost: tuning.cost,
    timeoutMs: tuning.timeoutMs,
    explicitOnly: tuning.explicitOnly,
  };
  if (tuning.env) base.apiKeyEnv = tuning.env;
  if (id === "sub2api") base.configPath = KIT_CONFIG_PATH;
  return base;
}

export function defaultConfig(): ScoutConfig {
  const providers: Record<string, ProviderConfig> = {};
  for (const id of PROVIDER_IDS) providers[id] = providerDefaults(id);
  return {
    version: 1,
    mode: "balanced",
    toolNames: {
      search: "web_search",
      fetch: "web_fetch",
      inspect: "web_inspect",
    },
    routing: {
      search: { mode: "fuse", maxParallel: 3, hedgeMs: 400, deadlineMs: 12000 },
      fetch: { mode: "cascade", deadlineMs: 25000 },
    },
    fusion: { k: 60, consensus: 0.15, domainCap: 2 },
    preferences: { intents: structuredClone(DEFAULT_PREFERENCES.intents) },
    providers,
    fetch: {
      cascade: ["direct", "tinyfish", "jina", "firecrawl"],
      minChars: 200,
      maxBytes: 10 * 1024 * 1024,
      maxChars: 20000,
      spillThreshold: 100000,
    },
    network: {
      proxies: [],
      strategy: "direct-first",
      cooldownMs: 60000,
      routeTimeoutMs: 8000,
    },
    security: { allowPrivateHosts: false },
  };
}

class ConfigError extends Error {}

function fail(path: string, where: string, message: string): never {
  throw new ConfigError(
    `pi-scout config ${path}: ${where ? where + ": " : ""}${message}`,
  );
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function object(
  x: unknown,
  path: string,
  where: string,
): Record<string, unknown> {
  if (!isRecord(x)) fail(path, where, "must be an object");
  return x;
}

function only(
  x: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  where: string,
): void {
  for (const key of Object.keys(x)) {
    if (!allowed.includes(key)) fail(path, where, `unknown field "${key}"`);
  }
}

function num(
  x: unknown,
  path: string,
  where: string,
  min: number,
  max: number,
): number {
  if (typeof x !== "number" || !Number.isFinite(x) || x < min || x > max) {
    fail(path, where, `must be a number between ${min} and ${max}`);
  }
  return x;
}

function str(x: unknown, path: string, where: string): string {
  if (typeof x !== "string" || !x.trim()) {
    fail(path, where, "must be a nonempty string");
  }
  return x.trim();
}

function bool(x: unknown, path: string, where: string): boolean {
  if (typeof x !== "boolean") fail(path, where, "must be boolean");
  return x;
}

function oneOf<T extends string>(
  x: unknown,
  allowed: readonly T[],
  path: string,
  where: string,
): T {
  if (typeof x !== "string" || !allowed.includes(x as T)) {
    fail(path, where, `must be one of ${allowed.join(", ")}`);
  }
  return x as T;
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

export function parseConfig(raw: unknown, path: string): ScoutConfig {
  const cfg = defaultConfig();
  const root = object(raw, path, "");
  only(
    root,
    [
      "version",
      "mode",
      "toolNames",
      "routing",
      "fusion",
      "preferences",
      "providers",
      "fetch",
      "network",
      "security",
    ],
    path,
    "",
  );

  if (root.version !== undefined && root.version !== 1) {
    fail(path, "version", "must be 1");
  }
  if (root.mode !== undefined) {
    cfg.mode = oneOf(root.mode, ["fast", "balanced", "deep"], path, "mode");
  }

  if (root.toolNames !== undefined) {
    const t = object(root.toolNames, path, "toolNames");
    only(t, ["search", "fetch", "inspect"], path, "toolNames");
    if (t.search !== undefined) {
      cfg.toolNames.search = str(t.search, path, "toolNames.search");
    }
    if (t.fetch !== undefined) {
      cfg.toolNames.fetch = str(t.fetch, path, "toolNames.fetch");
    }
    if (t.inspect !== undefined) {
      cfg.toolNames.inspect = str(t.inspect, path, "toolNames.inspect");
    }
  }

  if (root.routing !== undefined) {
    const r = object(root.routing, path, "routing");
    only(r, ["search", "fetch", "intents"], path, "routing");
    if (r.intents !== undefined) {
      const intents = object(r.intents, path, "routing.intents");
      for (const [name, value] of Object.entries(intents)) {
        if (!(INTENTS as readonly string[]).includes(name)) {
          fail(path, "routing.intents", `unknown intent "${name}"`);
        }
        if (
          !Array.isArray(value) ||
          value.some((v) => typeof v !== "string" || !v.trim())
        ) {
          fail(
            path,
            `routing.intents.${name}`,
            "must be an array of provider ids",
          );
        }
        cfg.preferences.intents[name as keyof PreferenceTable["intents"]] = (
          value as string[]
        ).map((v) => v.trim().toLowerCase());
      }
    }
    if (r.search !== undefined) {
      const s = object(r.search, path, "routing.search");
      only(
        s,
        ["mode", "maxParallel", "hedgeMs", "deadlineMs"],
        path,
        "routing.search",
      );
      if (s.mode !== undefined) {
        cfg.routing.search.mode = oneOf(
          s.mode,
          ["single", "auto", "race", "fuse", "cascade"],
          path,
          "routing.search.mode",
        );
      }
      if (s.maxParallel !== undefined) {
        cfg.routing.search.maxParallel = Math.round(
          num(s.maxParallel, path, "routing.search.maxParallel", 1, 4),
        );
      }
      if (s.hedgeMs !== undefined) {
        cfg.routing.search.hedgeMs = Math.round(
          num(s.hedgeMs, path, "routing.search.hedgeMs", 0, 5000),
        );
      }
      if (s.deadlineMs !== undefined) {
        cfg.routing.search.deadlineMs = Math.round(
          num(s.deadlineMs, path, "routing.search.deadlineMs", 1000, 60000),
        );
      }
    }
    if (r.fetch !== undefined) {
      const f = object(r.fetch, path, "routing.fetch");
      only(f, ["mode", "deadlineMs"], path, "routing.fetch");
      if (f.mode !== undefined) {
        cfg.routing.fetch.mode = oneOf(
          f.mode,
          ["cascade", "race"],
          path,
          "routing.fetch.mode",
        );
      }
      if (f.deadlineMs !== undefined) {
        cfg.routing.fetch.deadlineMs = Math.round(
          num(f.deadlineMs, path, "routing.fetch.deadlineMs", 1000, 120000),
        );
      }
    }
  }

  if (root.fusion !== undefined) {
    const f = object(root.fusion, path, "fusion");
    only(f, ["k", "consensus", "domainCap"], path, "fusion");
    if (f.k !== undefined) {
      cfg.fusion.k = Math.round(num(f.k, path, "fusion.k", 1, 1000));
    }
    if (f.consensus !== undefined) {
      cfg.fusion.consensus = num(f.consensus, path, "fusion.consensus", 0, 5);
    }
    if (f.domainCap !== undefined) {
      cfg.fusion.domainCap = Math.round(
        num(f.domainCap, path, "fusion.domainCap", 1, 10),
      );
    }
  }

  if (root.providers !== undefined) {
    const p = object(root.providers, path, "providers");
    for (const [id, value] of Object.entries(p)) {
      if (!(PROVIDER_IDS as readonly string[]).includes(id)) {
        fail(path, "providers", `unknown provider "${id}"`);
      }
      const where = `providers.${id}`;
      const item = object(value, path, where);
      only(
        item,
        [
          "enabled",
          "weight",
          "cost",
          "timeoutMs",
          "apiKey",
          "apiKeyEnv",
          "proxy",
          "baseUrl",
          "configPath",
          "model",
          "object",
          "explicitOnly",
        ],
        path,
        where,
      );
      const target = cfg.providers[id]!;
      if (item.enabled !== undefined) {
        target.enabled = bool(item.enabled, path, `${where}.enabled`);
      }
      if (item.weight !== undefined) {
        target.weight = num(item.weight, path, `${where}.weight`, 0.01, 100);
      }
      if (item.cost !== undefined) {
        target.cost = num(item.cost, path, `${where}.cost`, 0, 3) as Cost;
      }
      if (item.timeoutMs !== undefined) {
        target.timeoutMs = Math.round(
          num(item.timeoutMs, path, `${where}.timeoutMs`, 500, 120000),
        );
      }
      if (item.apiKey !== undefined) {
        target.apiKey = str(item.apiKey, path, `${where}.apiKey`);
      }
      if (item.apiKeyEnv !== undefined) {
        const envName = str(item.apiKeyEnv, path, `${where}.apiKeyEnv`);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
          fail(
            path,
            `${where}.apiKeyEnv`,
            "must be an environment variable NAME; put the key itself in apiKey",
          );
        }
        target.apiKeyEnv = envName;
      }
      if (item.baseUrl !== undefined) {
        target.baseUrl = str(item.baseUrl, path, `${where}.baseUrl`);
      }
      if (item.configPath !== undefined) {
        target.configPath = str(item.configPath, path, `${where}.configPath`);
      }
      if (item.model !== undefined) {
        target.model = str(item.model, path, `${where}.model`);
      }
      if (item.object !== undefined) {
        target.object = oneOf(
          item.object,
          ["repositories", "issues", "code"] as const,
          path,
          `${where}.object`,
        );
      }
      if (item.proxy !== undefined) {
        const proxy = str(item.proxy, path, `${where}.proxy`);
        if (
          proxy !== "auto" &&
          proxy !== "none" &&
          !/^https?:\/\//.test(proxy)
        ) {
          fail(
            path,
            `${where}.proxy`,
            'must be "auto", "none", or an http(s) proxy URL',
          );
        }
        target.proxy = proxy;
      }
      if (item.explicitOnly !== undefined) {
        target.explicitOnly = bool(
          item.explicitOnly,
          path,
          `${where}.explicitOnly`,
        );
      }
    }
  }

  if (root.fetch !== undefined) {
    const f = object(root.fetch, path, "fetch");
    only(
      f,
      ["cascade", "minChars", "maxBytes", "maxChars", "spillThreshold"],
      path,
      "fetch",
    );
    if (f.cascade !== undefined) {
      if (
        !Array.isArray(f.cascade) ||
        f.cascade.some((x) => typeof x !== "string")
      ) {
        fail(path, "fetch.cascade", "must be an array of provider ids");
      }
      for (const id of f.cascade as string[]) {
        if (!(PROVIDER_IDS as readonly string[]).includes(id)) {
          fail(path, "fetch.cascade", `unknown provider "${id}"`);
        }
      }
      cfg.fetch.cascade = f.cascade as string[];
    }
    if (f.minChars !== undefined) {
      cfg.fetch.minChars = Math.round(
        num(f.minChars, path, "fetch.minChars", 0, 10000),
      );
    }
    if (f.maxBytes !== undefined) {
      cfg.fetch.maxBytes = Math.round(
        num(f.maxBytes, path, "fetch.maxBytes", 1024, 100 * 1024 * 1024),
      );
    }
    if (f.maxChars !== undefined) {
      cfg.fetch.maxChars = Math.round(
        num(f.maxChars, path, "fetch.maxChars", 100, 200000),
      );
    }
    if (f.spillThreshold !== undefined) {
      cfg.fetch.spillThreshold = Math.round(
        num(f.spillThreshold, path, "fetch.spillThreshold", 1000, 1000000),
      );
    }
  }

  if (root.network !== undefined) {
    const n = object(root.network, path, "network");
    only(
      n,
      ["proxies", "strategy", "cooldownMs", "routeTimeoutMs"],
      path,
      "network",
    );
    if (n.proxies !== undefined) {
      if (
        !Array.isArray(n.proxies) ||
        n.proxies.some((v) => typeof v !== "string")
      ) {
        fail(path, "network.proxies", "must be an array of proxy URLs");
      }
      for (const proxy of n.proxies as string[]) {
        if (!/^https?:\/\/[^\s]+$/.test(proxy)) {
          fail(path, "network.proxies", `invalid proxy URL "${proxy}"`);
        }
      }
      cfg.network.proxies = (n.proxies as string[]).map((v) => v.trim());
    }
    if (n.strategy !== undefined) {
      cfg.network.strategy = oneOf(
        n.strategy,
        ["direct-first", "proxy-first", "proxy-only", "direct-only"],
        path,
        "network.strategy",
      );
    }
    if (n.cooldownMs !== undefined) {
      cfg.network.cooldownMs = Math.round(
        num(n.cooldownMs, path, "network.cooldownMs", 0, 600000),
      );
    }
    if (n.routeTimeoutMs !== undefined) {
      cfg.network.routeTimeoutMs = Math.round(
        num(n.routeTimeoutMs, path, "network.routeTimeoutMs", 500, 60000),
      );
    }
    if (
      cfg.network.strategy === "proxy-only" &&
      cfg.network.proxies.length === 0
    ) {
      fail(
        path,
        "network.proxies",
        "proxy-only strategy needs at least one proxy",
      );
    }
  }

  if (root.security !== undefined) {
    const s = object(root.security, path, "security");
    only(s, ["allowPrivateHosts"], path, "security");
    if (s.allowPrivateHosts !== undefined) {
      cfg.security.allowPrivateHosts = bool(
        s.allowPrivateHosts,
        path,
        "security.allowPrivateHosts",
      );
    }
  }

  return cfg;
}

export function loadConfig(
  path = process.env.PI_SCOUT_CONFIG ?? DEFAULT_CONFIG_PATH,
): LoadedConfig {
  try {
    const text = readFileSync(path, "utf8");
    return { config: parseConfig(JSON.parse(text), path), path, exists: true };
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { config: defaultConfig(), path, exists: false };
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`pi-scout config ${path}: ${message}`);
  }
}

export interface Sub2apiEndpoint {
  baseUrl: string;
  key: string;
  model?: string;
  configPath: string;
}

/** Reads the kit config without ever writing to it. Secrets stay in memory. */
export function readSub2apiEndpoint(
  provider: ProviderConfig,
  configPath: string,
): Sub2apiEndpoint {
  const kitPath = expandHome(provider.configPath ?? KIT_CONFIG_PATH);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(kitPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(
      configPath,
      "providers.sub2api.configPath",
      `cannot read ${kitPath}: ${message}`,
    );
  }
  if (!isRecord(raw))
    fail(
      configPath,
      "providers.sub2api.configPath",
      `${kitPath} must contain an object`,
    );
  const baseUrl = raw.sub2api_base_url;
  const key = raw.key;
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    fail(kitPath, "sub2api_base_url", "must be a nonempty string");
  }
  if (typeof key !== "string" || !key.trim()) {
    fail(kitPath, "key", "must be a nonempty string");
  }
  const search = isRecord(raw.search) ? raw.search : {};
  if (search.enabled === false) {
    fail(
      kitPath,
      "search.enabled",
      "remote search is disabled in the kit config",
    );
  }
  const model =
    typeof search.model === "string" && search.model.trim()
      ? search.model.trim()
      : typeof provider.model === "string"
        ? provider.model
        : undefined;
  return {
    baseUrl: baseUrl.trim().replace(/\/+$/, ""),
    key: key.trim(),
    model,
    configPath: kitPath,
  };
}

export function resolveApiKey(
  provider: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (provider.apiKey) return provider.apiKey;
  if (provider.apiKeyEnv && env[provider.apiKeyEnv]) {
    return env[provider.apiKeyEnv];
  }
  return undefined;
}
