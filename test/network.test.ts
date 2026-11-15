import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { ProxyPool, isNetworkError, type Transport } from "../src/network.ts";

const failure = () =>
  Object.assign(new TypeError("fetch failed"), {
    cause: { code: "ECONNREFUSED" },
  });

test("network errors are recognised through the cause chain", () => {
  assert.equal(isNetworkError(failure()), true);
  assert.equal(isNetworkError(new Error("HTTP 500")), false);
  const abort = new Error("aborted");
  abort.name = "AbortError";
  assert.equal(isNetworkError(abort), false);
});

test("direct-first walks to the first healthy proxy and remembers failures", async () => {
  const calls: Array<string | undefined> = [];
  const transport: Transport = async (_url, _init, proxy) => {
    calls.push(proxy);
    if (proxy === "http://bad:1" || proxy === undefined) throw failure();
    return new Response("ok");
  };
  let clock = 0;
  const pool = new ProxyPool({
    proxies: ["http://bad:1", "http://good:2"],
    strategy: "direct-first",
    cooldownMs: 1000,
    routeTimeoutMs: 500,
    transport,
    now: () => clock,
  });

  assert.equal(
    await (await pool.fetch("https://x.test", undefined)).text(),
    "ok",
  );
  assert.deepEqual(calls, [undefined, "http://bad:1", "http://good:2"]);

  calls.length = 0;
  await pool.fetch("https://x.test", undefined);
  assert.deepEqual(calls, [undefined, "http://good:2"]);

  clock = 2000;
  calls.length = 0;
  await pool.fetch("https://x.test", undefined);
  assert.deepEqual(calls, [undefined, "http://bad:1", "http://good:2"]);
});

test("proxy-first tries proxies before direct", async () => {
  const calls: Array<string | undefined> = [];
  const pool = new ProxyPool({
    proxies: ["http://p:1"],
    strategy: "proxy-first",
    cooldownMs: 0,
    routeTimeoutMs: 500,
    transport: async (_u, _i, proxy) => {
      calls.push(proxy);
      return new Response("ok");
    },
  });
  await pool.fetch("https://x.test", undefined);
  assert.deepEqual(calls, ["http://p:1"]);
});

test("pinned none forces direct even when proxies exist", async () => {
  const calls: Array<string | undefined> = [];
  const pool = new ProxyPool({
    proxies: ["http://p:1"],
    strategy: "proxy-first",
    cooldownMs: 0,
    routeTimeoutMs: 500,
    transport: async (_u, _i, proxy) => {
      calls.push(proxy);
      return new Response("ok");
    },
  });
  await pool.fetch("https://x.test", undefined, "none");
  assert.deepEqual(calls, [undefined]);
});

test("an HTTP error from the target is not retried through another route", async () => {
  let calls = 0;
  const pool = new ProxyPool({
    proxies: ["http://p:1"],
    strategy: "direct-first",
    cooldownMs: 0,
    routeTimeoutMs: 500,
    transport: async () => {
      calls += 1;
      return new Response("denied", { status: 403 });
    },
  });
  const response = await pool.fetch("https://x.test", undefined);
  assert.equal(response.status, 403);
  assert.equal(calls, 1);
});

test("a hanging route times out and falls through", async () => {
  const pool = new ProxyPool({
    proxies: [],
    strategy: "direct-first",
    cooldownMs: 0,
    routeTimeoutMs: 40,
    transport: async (_u, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(
            Object.assign(new Error("route timeout"), { name: "AbortError" }),
          ),
        );
      }),
  });
  await assert.rejects(
    pool.fetch("https://x.test", undefined),
    /all routes failed/,
  );
});

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as AddressInfo).port),
    );
  });
}

test("a real forward proxy is used end to end", async () => {
  const origin = http.createServer((_req, res) =>
    res.end("hello through proxy"),
  );
  const originPort = await listen(origin);

  const proxy = http.createServer((req, res) => {
    const target = new URL(req.url ?? "");
    const upstream = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: req.method,
        headers: { ...req.headers, host: target.host },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", () => res.writeHead(502).end("proxy error"));
    req.pipe(upstream);
  });
  proxy.on("connect", (req, clientSocket, head) => {
    const [host, port] = (req.url ?? "").split(":");
    const serverSocket = net.connect(Number(port), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });
    serverSocket.on("error", () => clientSocket.destroy());
  });
  const proxyPort = await listen(proxy);

  try {
    const pool = new ProxyPool({
      proxies: ["http://127.0.0.1:" + proxyPort],
      strategy: "proxy-only",
      cooldownMs: 0,
      routeTimeoutMs: 5000,
    });
    const response = await pool.fetch(
      "http://127.0.0.1:" + originPort + "/x",
      undefined,
    );
    assert.equal(await response.text(), "hello through proxy");
  } finally {
    proxy.close();
    origin.close();
  }
});
