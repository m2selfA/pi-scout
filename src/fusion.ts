import { canonicalUrl, registrableDomain } from "./url.ts";
import type { SearchHit } from "./types.ts";

export interface FusionInput {
  provider: string;
  weight: number;
  hits: SearchHit[];
}

export interface FusionContribution {
  provider: string;
  rank: number;
  weight: number;
  rrf: number;
}

export interface RankedHit {
  title: string;
  url: string;
  canonicalUrl: string;
  snippet: string;
  publishedAt?: string;
  score: number;
  rrf: number;
  consensus: number;
  providers: string[];
  contributions: FusionContribution[];
  kind: "result" | "citation";
}

export interface FusionOptions {
  k: number;
  consensus: number;
  domainCap: number;
  limit: number;
}

export interface FusionResult {
  hits: RankedHit[];
  /** Entries dropped by the per-domain cap. Reported, never silently discarded. */
  domainCappedOut: number;
  distinctUrls: number;
}

/** A citation list is not a relevance ranking, so it may not outrank a real
 *  ranked result list. Citations enter the fusion at a fixed neutral rank. */
const CITATION_RANK = 3;

export function fuse(
  inputs: FusionInput[],
  options: FusionOptions,
): FusionResult {
  const merged = new Map<string, RankedHit>();

  for (const input of inputs) {
    for (const hit of input.hits) {
      if (!hit.url) continue;
      const key = canonicalUrl(hit.url);
      const rank =
        hit.kind === "citation" ? Math.max(hit.rank, CITATION_RANK) : hit.rank;
      const rrf = input.weight / (options.k + rank);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, {
          title: hit.title,
          url: hit.url,
          canonicalUrl: key,
          snippet: hit.snippet,
          publishedAt: hit.publishedAt,
          score: 0,
          rrf,
          consensus: 0,
          providers: [input.provider],
          contributions: [
            { provider: input.provider, rank, weight: input.weight, rrf },
          ],
          kind: hit.kind === "citation" ? "citation" : "result",
        });
        continue;
      }
      const previous = existing.contributions.find(
        (c) => c.provider === input.provider,
      );
      if (previous) {
        // One provider returning the same URL twice: keep the better rank only.
        if (previous.rank <= rank) continue;
        existing.rrf -= previous.rrf;
        previous.rank = rank;
        previous.rrf = rrf;
      } else {
        existing.contributions.push({
          provider: input.provider,
          rank,
          weight: input.weight,
          rrf,
        });
        existing.providers.push(input.provider);
      }
      existing.rrf += rrf;
      if (hit.snippet.length > existing.snippet.length) {
        existing.snippet = hit.snippet;
      }
      if (!existing.publishedAt && hit.publishedAt) {
        existing.publishedAt = hit.publishedAt;
      }
      if (existing.title.length < hit.title.length) existing.title = hit.title;
      if (existing.kind === "citation" && hit.kind !== "citation") {
        existing.kind = "result";
      }
    }
  }

  const firstSeen = new Map<string, number>();
  let index = 0;
  for (const key of merged.keys()) firstSeen.set(key, index++);

  for (const entry of merged.values()) {
    entry.consensus =
      options.consensus * Math.log(1 + new Set(entry.providers).size);
    entry.score = entry.rrf + entry.consensus;
  }

  const sorted = [...merged.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (
      (firstSeen.get(a.canonicalUrl) ?? 0) -
      (firstSeen.get(b.canonicalUrl) ?? 0)
    );
  });

  const perDomain = new Map<string, number>();
  const kept: RankedHit[] = [];
  const overflow: RankedHit[] = [];
  for (const hit of sorted) {
    const domain = registrableDomain(hit.canonicalUrl);
    const used = perDomain.get(domain) ?? 0;
    if (used >= options.domainCap) {
      overflow.push(hit);
      continue;
    }
    perDomain.set(domain, used + 1);
    kept.push(hit);
    if (kept.length >= options.limit) break;
  }

  // The cap is a quality preference, not a hard truncation: if it starved the
  // result set, top up from the overflow in fused order and report the count.
  let domainCappedOut = 0;
  for (const hit of overflow) {
    if (kept.length >= options.limit) {
      domainCappedOut += 1;
      continue;
    }
    kept.push(hit);
  }
  kept.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (
      (firstSeen.get(a.canonicalUrl) ?? 0) -
      (firstSeen.get(b.canonicalUrl) ?? 0)
    );
  });

  return { hits: kept, domainCappedOut, distinctUrls: merged.size };
}
