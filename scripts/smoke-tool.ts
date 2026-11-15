/** End-to-end tool probe through the real extension entry point with a fake
 *  host. Usage: node scripts/smoke-tool.ts <provider> "<query>" */
import piScout from "../src/index.ts";

interface Tool {
  name: string;
  execute: (
    id: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: (u: unknown) => void,
    ctx?: unknown,
  ) => Promise<{
    content: Array<{ text: string }>;
    details?: unknown;
    isError?: boolean;
  }>;
}

const provider = process.argv[2];
const query = process.argv[3] ?? "pi coding agent";
const tools = new Map<string, Tool>();
piScout({
  registerTool: (tool: Tool) => tools.set(tool.name, tool),
  registerCommand: () => undefined,
});

const tool = tools.get("web_search");
if (!tool) throw new Error("web_search was not registered");

const started = Date.now();
const result = await tool.execute(
  "smoke",
  { query, provider, max_results: 5 },
  undefined,
  undefined,
  { sessionManager: { getSessionId: () => "smoke-tool" } },
);
console.log(
  JSON.stringify({
    provider,
    ms: Date.now() - started,
    isError: result.isError ?? false,
    details: result.details,
    textHead: result.content[0]?.text.slice(0, 300),
  }),
);
process.exitCode = result.isError ? 1 : 0;
