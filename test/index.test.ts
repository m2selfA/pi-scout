import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

interface RegisteredTool {
  name: string;
  execute: (
    ...args: unknown[]
  ) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
}

async function load(config: Record<string, unknown>): Promise<{
  tools: RegisteredTool[];
  commands: string[];
  paths: string;
  handlers: Map<string, (args: string, ctx: unknown) => unknown>;
}> {
  const dir = mkdtempSync(join(tmpdir(), "pi-scout-index-"));
  const path = join(dir, "pi-scout.json");
  writeFileSync(path, JSON.stringify(config));
  process.env.PI_SCOUT_CONFIG = path;
  const module = await import(
    "../src/index.ts?test=" + encodeURIComponent(path)
  );
  const tools: RegisteredTool[] = [];
  const handlerMap = new Map<string, (args: string, ctx: unknown) => unknown>();
  module.default({
    registerTool: (tool: RegisteredTool) => tools.push(tool),
    registerCommand: (
      name: string,
      options: { handler: (args: string, ctx: unknown) => unknown },
    ) => handlerMap.set(name, options.handler),
  });
  delete process.env.PI_SCOUT_CONFIG;
  return {
    tools,
    commands: [...handlerMap.keys()],
    paths: path,
    handlers: handlerMap,
  };
}

test("registers web_search/web_fetch and only the implemented providers", async () => {
  const { tools, commands } = await load({
    providers: {
      sub2api: { enabled: false },
      direct: { enabled: true },
      jina: { enabled: false },
    },
  });
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["web_fetch", "web_search"]);
  assert.deepEqual(commands.sort(), [
    "scout",
    "scout-bench",
    "scout-doctor",
    "scout-reload",
  ]);
});

test("web_inspect appears only when sub2api is discovered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-scout-kit-"));
  const kit = join(dir, "pi-sub2api-kit.json");
  writeFileSync(
    kit,
    JSON.stringify({
      sub2api_base_url: "https://gw.example",
      key: "k",
      search: { enabled: true, model: "m" },
    }),
  );
  const { tools } = await load({
    providers: {
      sub2api: { enabled: true, configPath: kit },
      direct: { enabled: true },
      jina: { enabled: false },
    },
  });
  assert.ok(tools.some((t) => t.name === "web_inspect"));
});

test("an invalid config fails closed with the file path in the message", async () => {
  const { tools } = await load({
    routing: { search: { maxParallel: 99 } },
    providers: { direct: { enabled: true } },
  });
  const search = tools.find((t) => t.name === "web_search")!;
  const result = await search.execute("id", { query: "x" });
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /pi-scout config/);
  assert.match(result.content[0]!.text, /maxParallel/);
});

test("scout-reload rebuilds the registry from the current config file", async () => {
  const { handlers, paths } = await load({
    providers: {
      sub2api: { enabled: false },
      direct: { enabled: true },
      jina: { enabled: false },
    },
  });
  const messages: string[] = [];
  const ctx = { ui: { notify: (message: string) => messages.push(message) } };

  const providersOf = (message: string) =>
    /search providers: ([^\n]*)/.exec(message)?.[1] ?? "";

  await handlers.get("scout-reload")!("", ctx);
  assert.ok(!providersOf(messages[0] ?? "").includes("github"));

  writeFileSync(
    paths,
    JSON.stringify({
      providers: {
        sub2api: { enabled: false },
        jina: { enabled: false },
        direct: { enabled: true },
        github: { enabled: true, apiKey: "ghp_fake" },
      },
    }),
  );
  await handlers.get("scout-reload")!("", ctx);
  assert.ok(providersOf(messages[1] ?? "").includes("github"));
});
