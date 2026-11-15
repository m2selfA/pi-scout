import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultConfig, parseConfig } from "../src/config.ts";

const PATH = "/tmp/pi-scout.json";

test("network defaults: no proxies, direct-first", () => {
  const cfg = defaultConfig();
  assert.deepEqual(cfg.network.proxies, []);
  assert.equal(cfg.network.strategy, "direct-first");
  assert.equal(cfg.network.routeTimeoutMs, 8000);
});

test("proxy list order is preserved and validated", () => {
  const cfg = parseConfig(
    {
      network: {
        proxies: ["http://127.0.0.1:7890", "http://10.0.0.2:3128"],
        strategy: "proxy-first",
      },
    },
    PATH,
  );
  assert.deepEqual(cfg.network.proxies, [
    "http://127.0.0.1:7890",
    "http://10.0.0.2:3128",
  ]);
  assert.equal(cfg.network.strategy, "proxy-first");
  assert.throws(
    () =>
      parseConfig({ network: { proxies: ["socks5://127.0.0.1:1080"] } }, PATH),
    /network\.proxies/,
  );
});

test("proxy-only without proxies fails closed", () => {
  assert.throws(
    () => parseConfig({ network: { strategy: "proxy-only" } }, PATH),
    /needs at least one proxy/,
  );
});

test("per-provider proxy accepts auto, none or a URL", () => {
  const cfg = parseConfig(
    {
      providers: {
        jina: { proxy: "auto" },
        direct: { proxy: "none" },
        exa: { proxy: "http://127.0.0.1:7890" },
      },
    },
    PATH,
  );
  assert.equal(cfg.providers.jina!.proxy, "auto");
  assert.equal(cfg.providers.direct!.proxy, "none");
  assert.equal(cfg.providers.exa!.proxy, "http://127.0.0.1:7890");
  assert.throws(
    () => parseConfig({ providers: { jina: { proxy: "7890" } } }, PATH),
    /providers\.jina\.proxy/,
  );
});
