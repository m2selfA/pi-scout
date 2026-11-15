import assert from "node:assert/strict";
import { test } from "node:test";
import { executeFetch } from "../src/fetch.ts";
import type { FetchDoc } from "../src/types.ts";

const doc = (over: Partial<FetchDoc>): FetchDoc => ({
  url: "https://example.com",
  finalUrl: "https://example.com",
  title: "t",
  markdown: "x",
  mime: "text/html",
  status: 200,
  bytes: 1,
  truncated: false,
  provider: "direct",
  ...over,
});

test("short PDF text is accepted even below minChars", async () => {
  const outcome = await executeFetch(
    [{ provider: "direct", timeoutMs: 1000 }],
    async () =>
      doc({
        mime: "application/pdf",
        markdown: "--- page 1 --- Dummy PDF file",
      }),
    { deadlineMs: 2000, minChars: 200 },
  );
  assert.equal(outcome.doc?.mime, "application/pdf");
  assert.equal(outcome.attempts[0]?.status, "ok");
});

test("an empty PDF is rejected with a PDF-specific reason", async () => {
  const outcome = await executeFetch(
    [{ provider: "direct", timeoutMs: 1000 }],
    async () => doc({ mime: "application/pdf", markdown: "   " }),
    { deadlineMs: 2000, minChars: 200 },
  );
  assert.equal(outcome.doc, undefined);
  assert.match(
    outcome.attempts[0]?.error ?? "",
    /PDF produced no extractable text/,
  );
});

test("short HTML is still rejected and the cascade moves on", async () => {
  const outcome = await executeFetch(
    [
      { provider: "direct", timeoutMs: 1000 },
      { provider: "jina", timeoutMs: 1000 },
    ],
    async (provider) =>
      provider === "jina"
        ? doc({ provider: "jina", markdown: "x".repeat(300) })
        : doc({ markdown: "x".repeat(50) }),
    { deadlineMs: 3000, minChars: 200 },
  );
  assert.equal(outcome.doc?.provider, "jina");
  assert.equal(outcome.attempts[0]?.status, "empty");
});
