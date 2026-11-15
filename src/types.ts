/** Shared shapes for pi-scout. No runtime imports here on purpose: every module
 * (Pi extension, MCP server, tests) depends on these types instead of on Pi. */

export type Capability = "search" | "fetch" | "inspect";
export type Cost = 0 | 1 | 2 | 3;
export type SearchMode = "fast" | "balanced" | "deep";
export type Recency = "day" | "week" | "month" | "year";
export type FetchMode = "readable" | "raw";
export type RouteMode = "single" | "auto" | "race" | "fuse" | "cascade";
export type AttemptStatus = "ok" | "empty" | "error" | "timeout" | "skipped";

export interface ProviderMeta {
  id: string;
  label: string;
  capabilities: Capability[];
  auth: "none" | "key" | "gateway";
  envVar?: string;
  cost: Cost;
  weight: number;
  timeoutMs: number;
  /** Never selected by automatic routing, only by an explicit provider request. */
  explicitOnly?: boolean;
}

export interface SearchRequest {
  query: string;
  maxResults: number;
  recency?: Recency;
  domains?: string[];
  excludeDomains?: string[];
  mode: SearchMode;
  /** Router intent, when known. Providers may use it to pick a sub-index. */
  intent?: string;
  signal: AbortSignal;
  deadline: number;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
  provider: string;
  /** 1-based position inside this provider's own result list. */
  rank: number;
  /** "result" is a ranked search hit; "citation" is a URL parsed out of an
   * answer-style provider (Sub2API), whose order is not a relevance ranking. */
  kind?: "result" | "citation";
}

export interface ProviderSearchResult {
  hits: SearchHit[];
  raw?: unknown;
}

export interface SearchProvider {
  meta: ProviderMeta;
  search(req: SearchRequest): Promise<ProviderSearchResult>;
}

export interface FetchRequest {
  url: string;
  mode: FetchMode;
  maxChars: number;
  signal: AbortSignal;
  deadline: number;
}

export interface FetchDoc {
  url: string;
  finalUrl: string;
  title: string;
  markdown: string;
  mime: string;
  status: number;
  bytes: number;
  truncated: boolean;
  provider: string;
}

export interface FetchProvider {
  meta: ProviderMeta;
  fetch(req: FetchRequest): Promise<FetchDoc>;
}

export type InspectAction = "open" | "click" | "find" | "screenshot";

export interface InspectRequest {
  action: InspectAction;
  refId: string;
  id?: number;
  pattern?: string;
  pageno?: number;
  lineno?: number;
  signal: AbortSignal;
  deadline: number;
}

export interface InspectResult {
  action: InspectAction;
  text: string;
  referenceIds: string[];
  raw: unknown;
}

export interface InspectProvider {
  meta: ProviderMeta;
  inspect(req: InspectRequest): Promise<InspectResult>;
}

export interface Attempt {
  provider: string;
  capability: Capability;
  status: AttemptStatus;
  ms: number;
  error?: string;
  resultCount?: number;
}
