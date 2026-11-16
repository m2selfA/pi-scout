import { Agent, ProxyAgent, fetch as undiciFetch } from "undici";
import type { ProxyStrategy } from "./config.ts";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type Transport = (
  url: string,
  init: RequestInit | undefined,
  proxy: string | undefined,
) => Promise<Response>;

const NETWORK_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** True only for transport-level failures. An HTTP 4xx/5xx is an answer from
 *  the target, not a reason to re-send the request through another proxy. */
export function isNetworkError(error: unknown): boolean {
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    return false;
  }
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const candidate = current as {
      code?: unknown;
      errno?: unknown;
      cause?: unknown;
      name?: unknown;
    };
    const code = candidate.code ?? candidate.errno;
    if (typeof code === "string" && NETWORK_CODES.has(code)) return true;
    if (candidate.name === "AbortError") return false;
    current = candidate.cause;
  }
  return error instanceof TypeError && /fetch failed/i.test(error.message);
}

const directAgent = new Agent({ connect: { timeout: 10_000 } });
const proxyAgents = new Map<string, ProxyAgent>();

function agentFor(proxy: string | undefined): Agent | ProxyAgent {
  if (!proxy) return directAgent;
  let agent = proxyAgents.get(proxy);
  if (!agent) {
    agent = new ProxyAgent({ uri: proxy, requestTls: { timeout: 10_000 } });
    proxyAgents.set(proxy, agent);
  }
  return agent;
}

const defaultTransport: Transport = async (url, init, proxy) => {
  const response = await undiciFetch(url, {
    ...(init as Record<string, unknown>),
    dispatcher: agentFor(proxy),
  } as never);
  return response as unknown as Response;
};

export interface ProxyPoolOptions {
  proxies: string[];
  strategy: ProxyStrategy;
  cooldownMs: number;
  routeTimeoutMs: number;
  transport?: Transport;
  now?: () => number;
}

/** Ordered route attempts with per-route health. A proxy that failed at the
 *  transport layer is skipped for cooldownMs, then tried again. */
export class ProxyPool {
  private readonly downUntil = new Map<string, number>();
  private readonly transport: Transport;
  private readonly now: () => number;
  private readonly options: ProxyPoolOptions;

  constructor(options: ProxyPoolOptions) {
    this.options = options;
    this.transport = options.transport ?? defaultTransport;
    this.now = options.now ?? Date.now;
  }

  routes(pinned?: "auto" | "none" | string): Array<string | undefined> {
    if (pinned === "none") return [undefined];
    if (pinned && pinned !== "auto") return [pinned];
    const proxies = this.options.proxies;
    if (proxies.length === 0 || this.options.strategy === "direct-only") {
      return [undefined];
    }
    if (this.options.strategy === "proxy-only") return [...proxies];
    if (this.options.strategy === "proxy-first") return [...proxies, undefined];
    return [undefined, ...proxies];
  }

  private coolingDown(proxy: string): boolean {
    const until = this.downUntil.get(proxy) ?? 0;
    if (until <= this.now()) {
      this.downUntil.delete(proxy);
      return false;
    }
    return true;
  }

  private markDown(proxy: string): void {
    this.downUntil.set(proxy, this.now() + this.options.cooldownMs);
  }

  async fetch(
    url: string,
    init: RequestInit | undefined,
    pinned?: "auto" | "none" | string,
    routeTimeoutMs?: number,
  ): Promise<Response> {
    const routes = this.routes(pinned);
    const failures: string[] = [];

    for (const proxy of routes) {
      if (proxy && this.coolingDown(proxy)) {
        failures.push(`${proxy}: cooling down after a recent failure`);
        continue;
      }
      const controller = new AbortController();
      const outer = init?.signal;
      const onAbort = () => controller.abort(outer?.reason);
      if (outer) {
        if (outer.aborted) controller.abort(outer.reason);
        else outer.addEventListener("abort", onAbort, { once: true });
      }
      let routeTimedOut = false;
      const timer = setTimeout(
        () => {
          routeTimedOut = true;
          controller.abort(new Error("pi-scout route timeout"));
        },
        Math.max(1, routeTimeoutMs ?? this.options.routeTimeoutMs),
      );
      try {
        const response = await this.transport(
          url,
          { ...init, signal: controller.signal },
          proxy,
        );
        return response;
      } catch (error) {
        const networkLike =
          isNetworkError(error) || (routeTimedOut && !outer?.aborted);
        if (!networkLike) throw error;
        if (proxy) this.markDown(proxy);
        const reason = error instanceof Error ? error.message : String(error);
        failures.push(`${proxy ?? "direct"}: ${reason}`);
      } finally {
        clearTimeout(timer);
        if (outer) outer.removeEventListener("abort", onAbort);
      }
    }

    throw new Error(`all routes failed for ${url}: ${failures.join("; ")}`);
  }
}

export function createProxyPool(options: ProxyPoolOptions): ProxyPool {
  return new ProxyPool(options);
}
