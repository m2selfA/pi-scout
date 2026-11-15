import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  defaultConfig,
  loadConfig,
  parseConfig,
  readSub2apiEndpoint,
} from "../src/config.ts";

const CONFIG = "/tmp/pi-scout.json";

test("defaults: balanced mode, canonical tool names, jina+direct fetch", () => {
  const cfg = defaultConfig();
  assert.equal(cfg.mode, "balanced");
  assert.equal(cfg.toolNames.search, "web_search");
  assert.equal(cfg.toolNames.fetch, "web_fetch");
  assert.equal(cfg.toolNames.inspect, "web_inspect");
  assert.deepEqual(cfg.fetch.cascade, [
    "direct",
    "tinyfish",
    "jina",
    "firecrawl",
  ]);
  assert.equal(cfg.providers.sub2api!.enabled, true);
  assert.equal(cfg.providers.anysearch!.explicitOnly, true);
});

test("unknown fields fail with file and field path", () => {
  assert.throws(
    () => parseConfig({ providers: { exa: { wieght: 2 } } }, CONFIG),
    (error: Error) =>
      error.message.includes(CONFIG) &&
      error.message.includes("providers.exa") &&
      error.message.includes("wieght"),
  );
});

test("weights must be positive numbers", () => {
  assert.throws(
    () => parseConfig({ providers: { exa: { weight: 0 } } }, CONFIG),
    /providers\.exa\.weight/,
  );
});

test("mode and routing overrides are applied", () => {
  const cfg = parseConfig(
    {
      mode: "deep",
      routing: {
        search: { mode: "race", maxParallel: 2, hedgeMs: 100 },
        intents: { news: ["tinyfish", "EXA"] },
      },
    },
    CONFIG,
  );
  assert.equal(cfg.mode, "deep");
  assert.equal(cfg.routing.search.mode, "race");
  assert.equal(cfg.routing.search.maxParallel, 2);
  assert.deepEqual(cfg.preferences.intents.news, ["tinyfish", "exa"]);
});

test("unknown intent is rejected", () => {
  assert.throws(
    () => parseConfig({ routing: { intents: { gossip: ["exa"] } } }, CONFIG),
    /routing\.intents/,
  );
});

test("missing config file falls back to defaults and reports exists=false", () => {
  const loaded = loadConfig(join(tmpdir(), "pi-scout-does-not-exist.json"));
  assert.equal(loaded.exists, false);
  assert.equal(loaded.config.mode, "balanced");
});

test("a literal key pasted into apiKeyEnv is rejected with guidance", () => {
  assert.throws(
    () =>
      parseConfig(
        {
          providers: {
            brave: { apiKeyEnv: "example-key-placeholder" },
          },
        },
        CONFIG,
      ),
    /providers\.brave\.apiKeyEnv.*environment variable NAME/,
  );
});

test("sub2api endpoint is read without mutating the kit config", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-scout-kit-"));
  const kit = join(dir, "pi-sub2api-kit.json");
  const content = JSON.stringify({
    sub2api_base_url: "https://gateway.example/",
    key: "secret-key",
    search: { enabled: true, model: "gpt-6.1-sol" },
  });
  writeFileSync(kit, content);
  const cfg = defaultConfig();
  cfg.providers.sub2api!.configPath = kit;
  const endpoint = readSub2apiEndpoint(cfg.providers.sub2api!, CONFIG);
  assert.equal(endpoint.baseUrl, "https://gateway.example");
  assert.equal(endpoint.key, "secret-key");
  assert.equal(endpoint.model, "gpt-6.1-sol");
});

test("missing kit config surfaces both paths", () => {
  const cfg = defaultConfig();
  cfg.providers.sub2api!.configPath = join(tmpdir(), "missing-kit.json");
  assert.throws(
    () => readSub2apiEndpoint(cfg.providers.sub2api!, CONFIG),
    (error: Error) =>
      error.message.includes(CONFIG) &&
      error.message.includes("providers.sub2api.configPath") &&
      error.message.includes("missing-kit.json"),
  );
});
