/** URL identity helpers. Fusion merges results by canonical URL, so this must
 * be deterministic and must not lose meaningful path information. */

const TRACKING = [
  /^utm_/i,
  /^gclid$/i,
  /^fbclid$/i,
  /^msclkid$/i,
  /^mc_cid$/i,
  /^mc_eid$/i,
  /^ref$/i,
  /^ref_src$/i,
  /^spm$/i,
  /^igshid$/i,
  /^yclid$/i,
  /^_hsenc$/i,
  /^_hsmi$/i,
];

export function canonicalUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return input.trim();
  }
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  url.protocol = url.protocol.toLowerCase();
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING.some((re) => re.test(key))) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.pathname !== "/" && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  if (
    (url.protocol === "https:" && url.port === "443") ||
    (url.protocol === "http:" && url.port === "80")
  ) {
    url.port = "";
  }
  return url.toString();
}

export function registrableDomain(input: string): string {
  let host: string;
  try {
    host = new URL(input).hostname.toLowerCase();
  } catch {
    return input.toLowerCase();
  }
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const twoLevel = new Set([
    "co.uk",
    "com.cn",
    "net.cn",
    "org.cn",
    "gov.cn",
    "edu.cn",
    "co.jp",
    "com.au",
    "com.br",
    "co.kr",
    "com.tw",
    "co.in",
  ]);
  const tail = parts.slice(-2).join(".");
  if (twoLevel.has(tail)) return parts.slice(-3).join(".");
  return tail;
}

export function isHttpUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".internal") || host.endsWith(".local")) return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (host.includes(":")) {
    if (host === "::1" || host === "::") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
    if (host.startsWith("::ffff:")) {
      const mapped = host.slice("::ffff:".length);
      return isPrivateHost(mapped);
    }
  }
  return false;
}

export type HostResolver = (hostname: string) => Promise<string[]>;

/** Resolves a hostname and rejects if any address is private. Catches DNS names
 *  that point at loopback/RFC1918 even when the literal hostname looks public. */
export async function assertResolvablePublic(
  url: string,
  allowPrivateHosts: boolean,
  resolveHost?: HostResolver,
): Promise<URL> {
  const parsed = assertFetchable(url, allowPrivateHosts);
  if (allowPrivateHosts) return parsed;
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (isPrivateHost(host)) return parsed;
  const addresses = await (resolveHost ?? defaultResolveHost)(host);
  for (const address of addresses) {
    if (isPrivateHost(address)) {
      throw new Error(
        `Refusing to fetch ${parsed.hostname}: it resolves to private address ${address}`,
      );
    }
  }
  return parsed;
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const { lookup } = await import("node:dns/promises");
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((entry) => entry.address);
}

export function assertFetchable(url: string, allowPrivateHosts: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Not an absolute URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Only http(s) URLs are fetchable, got ${parsed.protocol}`);
  }
  if (!allowPrivateHosts && isPrivateHost(parsed.hostname)) {
    throw new Error(
      `Refusing to fetch private or loopback host ${parsed.hostname} (security.allowPrivateHosts is false)`,
    );
  }
  return parsed;
}
