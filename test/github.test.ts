import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../src/config.ts";
import {
  createGitHubProvider,
  githubSearchUrl,
  hasCjk,
  parseGitHubCode,
  parseGitHubIssues,
  parseGitHubRepositories,
} from "../src/providers/github.ts";

const request = (query: string) => ({
  query,
  maxResults: 5,
  mode: "balanced" as const,
  signal: new AbortController().signal,
  deadline: Date.now() + 5000,
});

test("repository hits carry stars, language and updated date in the snippet", () => {
  const hits = parseGitHubRepositories({
    items: [
      {
        full_name: "earendil-works/pi",
        html_url: "https://github.com/earendil-works/pi",
        description: "Pi coding agent",
        stargazers_count: 1234,
        language: "TypeScript",
        updated_at: "2026-11-01T10:00:00Z",
        topics: ["agent", "cli"],
      },
    ],
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.title, "earendil-works/pi");
  assert.match(hits[0]!.snippet, /★ 1234/);
  assert.match(hits[0]!.snippet, /TypeScript/);
  assert.equal(hits[0]!.publishedAt, "2026-11-01T10:00:00Z");
});

test("issue hits derive repo name from the API repository_url", () => {
  const hits = parseGitHubIssues({
    items: [
      {
        title: "Search tool collides",
        html_url: "https://github.com/o/r/issues/7",
        body: "two extensions register web_search",
        state: "open",
        number: 7,
        repository_url: "https://api.github.com/repos/o/r",
      },
    ],
  });
  assert.equal(hits[0]!.title, "o/r#7 Search tool collides");
  assert.match(hits[0]!.snippet, /\[open\]/);
});

test("code hits include path and text match fragments", () => {
  const hits = parseGitHubCode({
    items: [
      {
        path: "src/index.ts",
        html_url: "https://github.com/o/r/blob/main/src/index.ts",
        repository: { full_name: "o/r" },
        text_matches: [{ fragment: "export default function piScout" }],
      },
    ],
  });
  assert.equal(hits[0]!.title, "o/r/src/index.ts");
  assert.match(hits[0]!.snippet, /piScout/);
});

test("search URL encodes the query and caps per_page", () => {
  const url = new URL(
    githubSearchUrl("repo:o/r language:ts", "repositories", 500),
  );
  assert.equal(url.pathname, "/search/repositories");
  assert.equal(url.searchParams.get("q"), "repo:o/r language:ts");
  assert.equal(url.searchParams.get("per_page"), "100");
});

test("code intent switches to the code index unless config pins an object", async () => {
  const seen: string[] = [];
  const fake = (async (url: string | URL | Request) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  const provider = createGitHubProvider({ token: "ghp_test", fetchImpl: fake });
  await provider.search({ ...request("registerTool"), intent: "code" });
  await provider.search({ ...request("pi agent"), intent: "general" });
  await provider.search({ ...request("pi 扩展 插件"), intent: "code" });
  assert.match(seen[0] ?? "", /\/search\/code\?/);
  assert.match(seen[1] ?? "", /\/search\/repositories\?/);
  assert.match(seen[2] ?? "", /\/search\/repositories\?/);

  const pinned: string[] = [];
  const pinnedProvider = createGitHubProvider({
    token: "ghp_test",
    object: "issues",
    fetchImpl: (async (url: string | URL | Request) => {
      pinned.push(String(url));
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  await pinnedProvider.search({ ...request("registerTool"), intent: "code" });
  assert.match(pinned[0] ?? "", /\/search\/issues\?/);
});

test("CJK detection covers Han, kana and Hangul but not ASCII", () => {
  assert.equal(hasCjk("pi 扩展"), true);
  assert.equal(hasCjk("プラグイン"), true);
  assert.equal(hasCjk("플러그인"), true);
  assert.equal(hasCjk("registerTool"), false);
});

test("provider sends bearer auth, API version and code-search media type", async () => {
  let seen: { url: string; init?: RequestInit } | undefined;
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(url), init };
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  const provider = createGitHubProvider({
    token: "ghp_test",
    object: "code",
    fetchImpl: fake,
  });
  await provider.search(request("pi-scout"));
  const headers = seen!.init?.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer ghp_test");
  assert.equal(headers["x-github-api-version"], "2022-11-28");
  assert.match(headers.accept ?? "", /text-match\+json/);
  assert.match(seen!.url, /\/search\/code\?/);
});

test("credential and rate-limit failures are reported distinctly", async () => {
  const bad = createGitHubProvider({
    token: "x",
    fetchImpl: (async () =>
      new Response("{}", { status: 401 })) as unknown as typeof fetch,
  });
  await assert.rejects(bad.search(request("q")), /bad credentials/);

  const limited = createGitHubProvider({
    token: "x",
    fetchImpl: (async () =>
      new Response("{}", {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1794749000",
        },
      })) as unknown as typeof fetch,
  });
  await assert.rejects(
    limited.search(request("q")),
    /rate limited.*remaining=0/,
  );
});

test("config accepts only known GitHub search objects", () => {
  const cfg = parseConfig(
    { providers: { github: { object: "issues" } } },
    "/tmp/pi-scout.json",
  );
  assert.equal(cfg.providers.github!.object, "issues");
  assert.throws(
    () =>
      parseConfig(
        { providers: { github: { object: "users" } } },
        "/tmp/pi-scout.json",
      ),
    /providers\.github\.object/,
  );
});
