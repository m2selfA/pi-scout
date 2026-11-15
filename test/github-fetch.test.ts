import assert from "node:assert/strict";
import { test } from "node:test";
import { orderFetchCascade } from "../src/fetch.ts";
import { createGitHubFetch, parseGitHubUrl } from "../src/providers/github.ts";

const req = (url: string) => ({
  url,
  mode: "readable" as const,
  maxChars: 2000,
  signal: new AbortController().signal,
  deadline: Date.now() + 5000,
});

test("URL parser covers repo, blob, tree, issue and raw hosts", () => {
  assert.deepEqual(parseGitHubUrl("https://github.com/o/r"), {
    kind: "repo",
    owner: "o",
    repo: "r",
  });
  assert.deepEqual(
    parseGitHubUrl("https://github.com/o/r/blob/main/src/a.ts"),
    {
      kind: "blob",
      owner: "o",
      repo: "r",
      ref: "main",
      path: "src/a.ts",
    },
  );
  assert.equal(
    parseGitHubUrl("https://github.com/o/r/tree/main/src")?.kind,
    "tree",
  );
  assert.equal(
    parseGitHubUrl("https://github.com/o/r/issues/12")?.kind,
    "issue",
  );
  assert.equal(parseGitHubUrl("https://github.com/o/r/pull/7")?.kind, "issue");
  assert.equal(
    parseGitHubUrl("https://raw.githubusercontent.com/o/r/main/README.md")
      ?.kind,
    "blob",
  );
  assert.equal(parseGitHubUrl("https://example.com/o/r"), null);
  assert.equal(parseGitHubUrl("https://github.com/o"), null);
});

test("fetch cascade puts GitHub first only for GitHub hosts", () => {
  assert.deepEqual(
    orderFetchCascade(["direct", "tinyfish", "jina"], "https://github.com/o/r"),
    ["github", "direct", "tinyfish", "jina"],
  );
  assert.deepEqual(
    orderFetchCascade(["direct", "github", "jina"], "https://example.com/x"),
    ["direct", "jina"],
  );
});

test("repository fetch returns metadata plus README", async () => {
  const urls: string[] = [];
  const fake = (async (url: string | URL | Request) => {
    urls.push(String(url));
    if (String(url).endsWith("/readme")) {
      return new Response("# Hello\n\nREADME body", { status: 200 });
    }
    return new Response(
      JSON.stringify({
        full_name: "o/r",
        description: "demo repo",
        stargazers_count: 42,
        language: "TypeScript",
        private: false,
        topics: ["agent"],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const doc = await createGitHubFetch({ token: "t", fetchImpl: fake }).fetch(
    req("https://github.com/o/r"),
  );
  assert.equal(doc.provider, "github");
  assert.match(doc.markdown, /README body/);
  assert.match(doc.markdown, /★ 42/);
  assert.equal(urls.length, 2);
});

test("blob fetch refuses files above the inline limit before downloading", async () => {
  const fake = (async () =>
    new Response(null, {
      status: 200,
      headers: { "content-length": String(2 * 1024 * 1024) },
    })) as unknown as typeof fetch;
  await assert.rejects(
    createGitHubFetch({ token: "t", fetchImpl: fake }).fetch(
      req("https://github.com/o/r/blob/main/big.bin"),
    ),
    /exceeds the 1048576 byte inline limit/,
  );
});

test("blob fetch returns raw file text", async () => {
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { "content-length": "12" },
      });
    }
    return new Response("export const x = 1;", { status: 200 });
  }) as unknown as typeof fetch;
  const doc = await createGitHubFetch({ token: "t", fetchImpl: fake }).fetch(
    req("https://github.com/o/r/blob/main/src/x.ts"),
  );
  assert.match(doc.markdown, /export const x/);
  assert.match(doc.title, /src\/x\.ts@main/);
});

test("tree fetch lists directory entries", async () => {
  const fake = (async () =>
    new Response(
      JSON.stringify([
        { type: "file", name: "a.ts", size: 10 },
        { type: "dir", name: "sub" },
      ]),
      { status: 200 },
    )) as unknown as typeof fetch;
  const doc = await createGitHubFetch({ token: "t", fetchImpl: fake }).fetch(
    req("https://github.com/o/r/tree/main/src"),
  );
  assert.match(doc.markdown, /📄 a\.ts \(10 B\)/);
  assert.match(doc.markdown, /📁 sub/);
});

test("issue fetch renders state, author and body", async () => {
  const fake = (async () =>
    new Response(
      JSON.stringify({
        title: "Broken thing",
        state: "open",
        user: { login: "alice" },
        body: "steps to reproduce",
        number: 3,
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
  const doc = await createGitHubFetch({ token: "t", fetchImpl: fake }).fetch(
    req("https://github.com/o/r/issues/3"),
  );
  assert.match(doc.title, /o\/r#3 Broken thing/);
  assert.match(doc.markdown, /by @alice/);
  assert.match(doc.markdown, /steps to reproduce/);
});

test("404 is reported as private-or-missing rather than a generic error", async () => {
  const fake = (async () =>
    new Response("{}", { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(
    createGitHubFetch({ token: "t", fetchImpl: fake }).fetch(
      req("https://github.com/o/r"),
    ),
    /not found \(404\).*private repo/,
  );
});

test("non-GitHub URLs are rejected by the provider itself", async () => {
  await assert.rejects(
    createGitHubFetch({ token: "t" }).fetch(req("https://example.com/x")),
    /not a github\.com URL/,
  );
});
