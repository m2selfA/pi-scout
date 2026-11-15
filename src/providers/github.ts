import type {
  FetchDoc,
  FetchRequest,
  ProviderMeta,
  SearchHit,
  SearchProvider,
  SearchRequest,
} from "../types.ts";

export type GitHubObject = "repositories" | "issues" | "code";

export const GITHUB_META: ProviderMeta = {
  id: "github",
  label: "GitHub",
  capabilities: ["search", "fetch"],
  auth: "key",
  envVar: "GITHUB_TOKEN",
  cost: 0,
  weight: 2,
  timeoutMs: 15000,
};

export const GITHUB_API = "https://api.github.com";

/** Han, kana, Hangul and compatibility ideographs. GitHub idea search matches
 *  literal tokens, so a CJK query against the code index almost always returns
 *  nothing; callers should fall back to repository search for these. */
export function hasCjk(text: string): boolean {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/.test(
    text,
  );
}

interface RepositoryItem {
  full_name?: string;
  html_url?: string;
  description?: string | null;
  stargazers_count?: number;
  language?: string | null;
  updated_at?: string;
  topics?: string[];
}

interface IssueItem {
  title?: string;
  html_url?: string;
  body?: string | null;
  state?: string;
  updated_at?: string;
  number?: number;
  repository_url?: string;
}

interface CodeItem {
  name?: string;
  path?: string;
  html_url?: string;
  repository?: { full_name?: string };
  text_matches?: Array<{ fragment?: string }>;
}

function repoName(repositoryUrl?: string): string {
  if (!repositoryUrl) return "";
  const parts = repositoryUrl.split("/");
  return parts.slice(-2).join("/");
}

function clip(text: string, max = 300): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

export function parseGitHubRepositories(payload: unknown): SearchHit[] {
  const items = (payload as { items?: RepositoryItem[] } | null)?.items ?? [];
  return items
    .filter((item) => Boolean(item.html_url))
    .map((item, index) => {
      const meta = [
        typeof item.stargazers_count === "number"
          ? `★ ${item.stargazers_count}`
          : "",
        item.language ?? "",
        item.updated_at ? `updated ${item.updated_at.slice(0, 10)}` : "",
        ...(item.topics ?? []).slice(0, 3),
      ]
        .filter(Boolean)
        .join(" · ");
      const description = item.description?.trim() ?? "";
      return {
        title: item.full_name ?? "",
        url: item.html_url as string,
        snippet: clip([description, meta].filter(Boolean).join(" — ")),
        ...(item.updated_at ? { publishedAt: item.updated_at } : {}),
        provider: "github",
        rank: index + 1,
      };
    });
}

export function parseGitHubIssues(payload: unknown): SearchHit[] {
  const items = (payload as { items?: IssueItem[] } | null)?.items ?? [];
  return items
    .filter((item) => Boolean(item.html_url))
    .map((item, index) => {
      const repo = repoName(item.repository_url);
      return {
        title: clip(`${repo}#${item.number ?? ""} ${item.title ?? ""}`, 160),
        url: item.html_url as string,
        snippet: clip(`[${item.state ?? "open"}] ${item.body ?? ""}`),
        ...(item.updated_at ? { publishedAt: item.updated_at } : {}),
        provider: "github",
        rank: index + 1,
      };
    });
}

export function parseGitHubCode(payload: unknown): SearchHit[] {
  const items = (payload as { items?: CodeItem[] } | null)?.items ?? [];
  return items
    .filter((item) => Boolean(item.html_url))
    .map((item, index) => {
      const matches = (item.text_matches ?? [])
        .map((match) => clip(match.fragment ?? "", 120))
        .filter(Boolean)
        .join(" … ");
      return {
        title: `${item.repository?.full_name ?? ""}/${item.path ?? item.name ?? ""}`,
        url: item.html_url as string,
        snippet: matches,
        provider: "github",
        rank: index + 1,
      };
    });
}

export type GitHubTarget =
  | { kind: "repo"; owner: string; repo: string }
  | { kind: "blob"; owner: string; repo: string; ref: string; path: string }
  | { kind: "tree"; owner: string; repo: string; ref: string; path: string }
  | { kind: "issue"; owner: string; repo: string; number: number };

/** Maps github.com / raw.githubusercontent.com URLs to an API operation.
 *  Returns null for anything else so the fetch cascade can skip this provider. */
export function parseGitHubUrl(input: string): GitHubTarget | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (host === "raw.githubusercontent.com") {
    if (parts.length < 4) return null;
    const [owner, repo, ref, ...rest] = parts;
    return {
      kind: "blob",
      owner: owner!,
      repo: repo!,
      ref: ref!,
      path: rest.join("/"),
    };
  }
  if (host !== "github.com" || parts.length < 2) return null;
  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/, "");
  const rest = parts.slice(2);
  const segment = rest[0];
  if (!segment) return { kind: "repo", owner, repo };
  if (segment === "blob" || segment === "raw" || segment === "tree") {
    if (rest.length < 3) return null;
    const ref = rest[1]!;
    const path = rest.slice(2).join("/");
    return segment === "tree"
      ? { kind: "tree", owner, repo, ref, path }
      : { kind: "blob", owner, repo, ref, path };
  }
  if (segment === "issues" || segment === "pull") {
    const number = Number(rest[1]);
    if (!Number.isInteger(number) || number <= 0) return null;
    return { kind: "issue", owner, repo, number };
  }
  return null;
}

const MAX_INLINE_BYTES = 1024 * 1024;

interface RepoPayload {
  full_name?: string;
  description?: string | null;
  html_url?: string;
  default_branch?: string;
  stargazers_count?: number;
  language?: string | null;
  private?: boolean;
  homepage?: string | null;
  topics?: string[];
  license?: { name?: string } | null;
}

interface IssuePayload {
  title?: string;
  html_url?: string;
  state?: string;
  user?: { login?: string };
  body?: string | null;
  created_at?: string;
  comments?: number;
  pull_request?: unknown;
}

function requireOk(response: Response, what: string): void {
  if (response.ok) return;
  if (response.status === 404) {
    throw new Error(
      `github ${what}: not found (404) — private repo without access, or wrong path`,
    );
  }
  if (response.status === 401) {
    throw new Error(`github ${what}: bad credentials (401)`);
  }
  if (response.status === 403 || response.status === 429) {
    throw new Error(rateLimitMessage(response));
  }
  throw new Error(`github ${what} HTTP ${response.status}`);
}

function decodeBase64(content: string): string {
  return Buffer.from(content.replace(/\n/g, ""), "base64").toString("utf8");
}

/** Fetch through the GitHub API: repositories return metadata plus README,
 *  blobs return raw file text, issues/PRs return the report body. */
export function createGitHubFetch(options: GitHubOptions): {
  meta: ProviderMeta;
  fetch(req: FetchRequest): Promise<FetchDoc>;
} {
  const doFetch = options.fetchImpl ?? fetch;
  const headers = (accept: string): Record<string, string> => ({
    accept,
    authorization: `Bearer ${options.token}`,
    "x-github-api-version": "2022-11-28",
    "user-agent": "pi-scout/0.3",
  });

  const get = async (
    url: string,
    accept: string,
    signal: AbortSignal,
    what: string,
  ): Promise<Response> => {
    const response = await doFetch(url, { headers: headers(accept), signal });
    requireOk(response, what);
    return response;
  };

  return {
    meta: GITHUB_META,
    async fetch(req: FetchRequest): Promise<FetchDoc> {
      const target = parseGitHubUrl(req.url);
      if (!target) {
        throw new Error("github fetch: not a github.com URL");
      }
      const base = `${GITHUB_API}/repos/${target.owner}/${target.repo}`;
      const started = Date.now();
      let title = `${target.owner}/${target.repo}`;
      let markdown = "";
      let mime = "text/markdown";

      if (target.kind === "repo") {
        const repoResponse = await get(
          base,
          "application/vnd.github+json",
          req.signal,
          "repo",
        );
        const repo = (await repoResponse.json()) as RepoPayload;
        title = repo.full_name ?? title;
        const meta = [
          repo.description?.trim(),
          repo.private ? "private" : "public",
          typeof repo.stargazers_count === "number"
            ? `★ ${repo.stargazers_count}`
            : "",
          repo.language ?? "",
          repo.license?.name ?? "",
          repo.homepage ?? "",
          ...(repo.topics ?? []).slice(0, 6),
        ]
          .filter(Boolean)
          .join(" · ");
        let readme = "";
        try {
          const readmeResponse = await get(
            `${base}/readme`,
            "application/vnd.github.raw+json",
            req.signal,
            "readme",
          );
          readme = await readmeResponse.text();
        } catch (error) {
          readme = `_No README available: ${error instanceof Error ? error.message : String(error)}_`;
        }
        markdown = [`# ${title}`, "", meta, "", readme].join("\n");
      } else if (target.kind === "blob") {
        const raw = `${GITHUB_API}/repos/${target.owner}/${target.repo}/contents/${target.path
          .split("/")
          .map(encodeURIComponent)
          .join("/")}?ref=${encodeURIComponent(target.ref)}`;
        const headResponse = await doFetch(raw, {
          method: "HEAD",
          headers: headers("application/vnd.github+json"),
          signal: req.signal,
        });
        const size = Number(headResponse.headers.get("content-length") ?? "0");
        if (size > MAX_INLINE_BYTES) {
          throw new Error(
            `github blob: ${size} bytes exceeds the ${MAX_INLINE_BYTES} byte inline limit`,
          );
        }
        const response = await get(
          raw,
          "application/vnd.github.raw+json",
          req.signal,
          "blob",
        );
        markdown = await response.text();
        title = `${target.owner}/${target.repo}/${target.path}@${target.ref}`;
        mime = "text/plain";
      } else if (target.kind === "tree") {
        const listing = await get(
          `${base}/contents/${target.path
            .split("/")
            .map(encodeURIComponent)
            .join("/")}?ref=${encodeURIComponent(target.ref)}`,
          "application/vnd.github+json",
          req.signal,
          "tree",
        );
        const entries = (await listing.json()) as Array<{
          type?: string;
          name?: string;
          size?: number;
        }>;
        title = `${target.owner}/${target.repo}/${target.path}@${target.ref}`;
        markdown = [
          `# ${title}`,
          "",
          ...entries.map(
            (entry) =>
              `- ${entry.type === "dir" ? "📁" : "📄"} ${entry.name ?? "?"}${
                typeof entry.size === "number" ? ` (${entry.size} B)` : ""
              }`,
          ),
        ].join("\n");
      } else {
        const issueResponse = await get(
          `${base}/issues/${target.number}`,
          "application/vnd.github+json",
          req.signal,
          "issue",
        );
        const issue = (await issueResponse.json()) as IssuePayload;
        title =
          `${target.owner}/${target.repo}#${target.number} ${issue.title ?? ""}`.trim();
        markdown = [
          `# ${title}`,
          "",
          [
            issue.state ? `state: ${issue.state}` : "",
            issue.user?.login ? `by @${issue.user.login}` : "",
            issue.created_at ? `created: ${issue.created_at}` : "",
            issue.pull_request ? "type: pull request" : "type: issue",
          ]
            .filter(Boolean)
            .join(" · "),
          "",
          issue.body ?? "_No description._",
        ].join("\n");
      }

      const clipped = markdown.slice(0, req.maxChars);
      return {
        url: req.url,
        finalUrl: `https://github.com/${target.owner}/${target.repo}`,
        title,
        markdown: clipped,
        mime,
        status: 200,
        bytes: Buffer.byteLength(markdown),
        truncated: clipped.length < markdown.length,
        provider: "github",
      };
    },
  };
}

export interface GitHubOptions {
  token: string;
  object?: GitHubObject;
  fetchImpl?: typeof fetch;
}

export function githubSearchUrl(
  query: string,
  object: GitHubObject,
  maxResults: number,
): string {
  const params = new URLSearchParams({
    q: query,
    per_page: String(Math.min(100, Math.max(1, maxResults))),
  });
  return `${GITHUB_API}/search/${object}?${params.toString()}`;
}

function rateLimitMessage(response: Response): string {
  const remaining = response.headers.get("x-ratelimit-remaining");
  const reset = response.headers.get("x-ratelimit-reset");
  const resetAt = reset
    ? new Date(Number(reset) * 1000).toISOString()
    : "unknown";
  return `github rate limited (remaining=${remaining ?? "?"}, reset=${resetAt})`;
}

export function createGitHubProvider(options: GitHubOptions): SearchProvider {
  const doFetch = options.fetchImpl ?? fetch;
  // Explicit config wins; otherwise code-intent queries use the code index,
  // because repository search only matches name/description/topics.
  const objectFor = (
    intent: string | undefined,
    query: string,
  ): GitHubObject => {
    if (options.object) return options.object;
    if (intent === "code" && !hasCjk(query)) return "code";
    return "repositories";
  };

  return {
    meta: GITHUB_META,
    async search(req: SearchRequest) {
      const query = req.query.trim();
      if (!query) throw new Error("github: empty query");
      const object = objectFor(req.intent, query);
      const headers: Record<string, string> = {
        accept:
          object === "code"
            ? "application/vnd.github.text-match+json"
            : "application/vnd.github+json",
        authorization: `Bearer ${options.token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "pi-scout/0.2",
      };
      const response = await doFetch(
        githubSearchUrl(query, object, req.maxResults),
        { headers, signal: req.signal },
      );
      if (response.status === 401) {
        throw new Error("github: bad credentials (401) — check the PAT");
      }
      if (response.status === 403 || response.status === 429) {
        throw new Error(rateLimitMessage(response));
      }
      if (response.status === 422) {
        throw new Error("github: invalid search query (422)");
      }
      if (!response.ok) {
        throw new Error(`github HTTP ${response.status}`);
      }
      const payload: unknown = await response.json();
      const hits =
        object === "code"
          ? parseGitHubCode(payload)
          : object === "issues"
            ? parseGitHubIssues(payload)
            : parseGitHubRepositories(payload);
      return { hits: hits.slice(0, req.maxResults), raw: payload };
    },
  };
}
