import type { Attempt, FetchDoc } from "./types.ts";

const GITHUB_HOSTS = new Set([
  "github.com",
  "www.github.com",
  "raw.githubusercontent.com",
]);

/** GitHub URLs get their API provider first; other URLs skip it entirely so the
 *  cascade does not waste an attempt on a provider that would reject the host. */
export function orderFetchCascade(cascade: string[], url: string): string[] {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    host = "";
  }
  if (GITHUB_HOSTS.has(host)) {
    return ["github", ...cascade.filter((id) => id !== "github")];
  }
  return cascade.filter((id) => id !== "github");
}

export interface FetchEntry {
  provider: string;
  timeoutMs: number;
}

export type FetchInvoker = (
  provider: string,
  signal: AbortSignal,
) => Promise<FetchDoc>;

export interface FetchOutcome {
  doc?: FetchDoc;
  attempts: Attempt[];
  degraded: boolean;
  deadlineHit: boolean;
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300);
}

export async function executeFetch(
  entries: FetchEntry[],
  invoke: FetchInvoker,
  options: { deadlineMs: number; minChars: number; signal?: AbortSignal },
): Promise<FetchOutcome> {
  const master = new AbortController();
  let deadlineHit = false;
  if (options.signal) {
    if (options.signal.aborted) master.abort(options.signal.reason);
    else
      options.signal.addEventListener(
        "abort",
        () => master.abort(options.signal?.reason),
        {
          once: true,
        },
      );
  }
  const timer = setTimeout(
    () => {
      deadlineHit = true;
      master.abort(new Error("pi-scout fetch deadline exceeded"));
    },
    Math.max(1, options.deadlineMs),
  );

  const attempts: Attempt[] = [];
  let degraded = false;

  try {
    for (const entry of entries) {
      if (master.signal.aborted) break;
      const started = Date.now();
      const controller = new AbortController();
      const onAbort = () => controller.abort(master.signal.reason);
      master.signal.addEventListener("abort", onAbort, { once: true });
      const perAttempt = setTimeout(
        () => controller.abort(new Error("pi-scout provider timeout")),
        Math.max(1, entry.timeoutMs),
      );
      try {
        const doc = await invoke(entry.provider, controller.signal);
        // A one-page PDF can legitimately hold very little text; minChars is an
        // HTML-boilerplate heuristic, not a PDF requirement.
        const length = doc.markdown.trim().length;
        const enough =
          doc.mime === "application/pdf"
            ? length > 0
            : length >= options.minChars;
        attempts.push({
          provider: entry.provider,
          capability: "fetch",
          status: enough ? "ok" : "empty",
          ms: Date.now() - started,
          resultCount: doc.markdown.length,
          ...(enough
            ? {}
            : {
                error:
                  doc.mime === "application/pdf"
                    ? "PDF produced no extractable text"
                    : `extracted text below minChars (${options.minChars})`,
              }),
        });
        if (enough) return { doc, attempts, degraded, deadlineHit };
        degraded = true;
      } catch (error) {
        const reason = controller.signal.reason;
        const timedOut =
          reason instanceof Error &&
          reason.message === "pi-scout provider timeout";
        const status = timedOut
          ? "timeout"
          : master.signal.aborted
            ? "skipped"
            : "error";
        attempts.push({
          provider: entry.provider,
          capability: "fetch",
          status,
          ms: Date.now() - started,
          ...(status === "skipped" ? {} : { error: describe(error) }),
        });
        if (status !== "skipped") degraded = true;
      } finally {
        clearTimeout(perAttempt);
        master.signal.removeEventListener("abort", onAbort);
      }
    }
  } finally {
    clearTimeout(timer);
  }

  return { attempts, degraded, deadlineHit };
}
