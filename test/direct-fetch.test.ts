import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createDirectProvider } from "../src/providers/direct.ts";

const bytes = readFileSync(new URL("./fixtures/dummy.pdf", import.meta.url));
const resolveHost = async () => ["93.184.216.34"];

const req = (url: string) => ({
  url,
  mode: "readable" as const,
  maxChars: 4000,
  signal: new AbortController().signal,
  deadline: Date.now() + 5000,
});

test("relative redirects are followed and the final URL is reported", async () => {
  const calls: string[] = [];
  const fake = (async (url: string | URL | Request) => {
    calls.push(String(url));
    if (calls.length === 1) {
      return new Response(null, {
        status: 302,
        headers: { location: "/next" },
      });
    }
    return new Response("<html><title>Done</title><p>landed</p></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  }) as unknown as typeof fetch;

  const doc = await createDirectProvider({
    fetchImpl: fake,
    maxBytes: 1_000_000,
    resolveHost,
  }).fetch(req("https://example.com/start"));

  assert.deepEqual(calls, [
    "https://example.com/start",
    "https://example.com/next",
  ]);
  assert.equal(doc.finalUrl, "https://example.com/next");
  assert.match(doc.markdown, /landed/);
});

test("a redirect into a private address is refused before the second request", async () => {
  let calls = 0;
  const fake = (async () => {
    calls += 1;
    return new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1:8080/admin" },
    });
  }) as unknown as typeof fetch;

  await assert.rejects(
    createDirectProvider({
      fetchImpl: fake,
      maxBytes: 1000,
      resolveHost,
    }).fetch(req("https://example.com/start")),
    /private or loopback host 127\.0\.0\.1/,
  );
  assert.equal(calls, 1);
});

test("a public hostname that resolves to loopback is refused", async () => {
  let calls = 0;
  const fake = (async () => {
    calls += 1;
    return new Response("ok");
  }) as unknown as typeof fetch;

  await assert.rejects(
    createDirectProvider({
      fetchImpl: fake,
      maxBytes: 1000,
      resolveHost: async () => ["127.0.0.1"],
    }).fetch(req("https://rebind.example/x")),
    /resolves to private address 127\.0\.0\.1/,
  );
  assert.equal(calls, 0);
});

test("redirect loops stop after the configured limit", async () => {
  const fake = (async () =>
    new Response(null, {
      status: 302,
      headers: { location: "/again" },
    })) as unknown as typeof fetch;

  await assert.rejects(
    createDirectProvider({
      fetchImpl: fake,
      maxBytes: 1000,
      resolveHost,
    }).fetch(req("https://example.com/loop")),
    /Too many redirects/,
  );
});

test("PDF bodies are extracted to text instead of being decoded as HTML", async () => {
  const fake = (async () =>
    new Response(bytes, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-length": String(bytes.byteLength),
      },
    })) as unknown as typeof fetch;

  const doc = await createDirectProvider({
    fetchImpl: fake,
    maxBytes: 5_000_000,
    resolveHost,
  }).fetch(req("https://example.com/dummy.pdf"));

  assert.equal(doc.mime, "application/pdf");
  assert.match(doc.markdown, /Dummy PDF file/);
  assert.match(doc.markdown, /page 1/);
  assert.equal(doc.bytes, bytes.byteLength);
});
