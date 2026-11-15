import type { Attempt, Capability, RouteMode, SearchHit } from "./types.ts";

export interface PlanEntry {
  provider: string;
  weight: number;
  timeoutMs: number;
}

export type SearchInvoker = (
  provider: string,
  signal: AbortSignal,
) => Promise<SearchHit[]>;

export interface ExecuteOptions {
  mode: RouteMode;
  deadlineMs: number;
  hedgeMs: number;
  signal?: AbortSignal;
}

export interface ProviderHits {
  provider: string;
  weight: number;
  hits: SearchHit[];
}

export interface ExecuteOutcome {
  perProvider: ProviderHits[];
  attempts: Attempt[];
  degraded: boolean;
  deadlineHit: boolean;
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300);
}

interface AttemptResult {
  hits: SearchHit[];
  attempt: Attempt;
}

async function runAttempt(
  entry: PlanEntry,
  capability: Capability,
  invoke: (signal: AbortSignal) => Promise<SearchHit[]>,
  parent: AbortSignal,
  cancel: AbortSignal,
): Promise<AttemptResult> {
  const started = Date.now();
  if (parent.aborted || cancel.aborted) {
    return {
      hits: [],
      attempt: {
        provider: entry.provider,
        capability,
        status: "skipped",
        ms: 0,
      },
    };
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.reason ?? cancel.reason);
  parent.addEventListener("abort", onAbort, { once: true });
  cancel.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("pi-scout provider timeout")),
    Math.max(1, entry.timeoutMs),
  );
  try {
    const hits = await invoke(controller.signal);
    const ms = Date.now() - started;
    return {
      hits,
      attempt: {
        provider: entry.provider,
        capability,
        status: hits.length > 0 ? "ok" : "empty",
        ms,
        resultCount: hits.length,
      },
    };
  } catch (error) {
    const ms = Date.now() - started;
    const reason = controller.signal.reason;
    const timedOut =
      reason instanceof Error && reason.message === "pi-scout provider timeout";
    const status = timedOut
      ? "timeout"
      : parent.aborted || cancel.aborted
        ? "skipped"
        : "error";
    return {
      hits: [],
      attempt: {
        provider: entry.provider,
        capability,
        status,
        ms,
        ...(status === "skipped" ? {} : { error: describe(error) }),
      },
    };
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", onAbort);
    cancel.removeEventListener("abort", onAbort);
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export async function executeSearch(
  entries: PlanEntry[],
  invoke: SearchInvoker,
  options: ExecuteOptions,
): Promise<ExecuteOutcome> {
  const master = new AbortController();
  let deadlineHit = false;
  const onOuterAbort = () => master.abort(options.signal?.reason);
  if (options.signal) {
    if (options.signal.aborted) master.abort(options.signal.reason);
    else options.signal.addEventListener("abort", onOuterAbort, { once: true });
  }
  const deadlineTimer = setTimeout(
    () => {
      deadlineHit = true;
      master.abort(new Error("pi-scout deadline exceeded"));
    },
    Math.max(1, options.deadlineMs),
  );

  const attempts: Attempt[] = [];
  const perProvider: ProviderHits[] = [];

  const runner = (entry: PlanEntry, cancel: AbortSignal) =>
    runAttempt(
      entry,
      "search",
      (signal) => invoke(entry.provider, signal),
      master.signal,
      cancel,
    );

  try {
    if (entries.length === 0) {
      return { perProvider: [], attempts, degraded: false, deadlineHit: false };
    }

    if (options.mode === "single") {
      const entry = entries[0]!;
      const result = await runner(entry, new AbortController().signal);
      attempts.push(result.attempt);
      if (result.hits.length > 0) {
        perProvider.push({
          provider: entry.provider,
          weight: entry.weight,
          hits: result.hits,
        });
      }
    } else if (options.mode === "auto" || options.mode === "cascade") {
      for (const entry of entries) {
        if (master.signal.aborted) break;
        const result = await runner(entry, new AbortController().signal);
        attempts.push(result.attempt);
        if (result.hits.length > 0) {
          perProvider.push({
            provider: entry.provider,
            weight: entry.weight,
            hits: result.hits,
          });
          break;
        }
      }
    } else {
      const cancel = new AbortController();
      const jobs = entries.map(async (entry, index) => {
        if (index > 0) await delay(index * options.hedgeMs, master.signal);
        return runner(entry, cancel.signal);
      });
      if (options.mode === "race") {
        for (const job of jobs) {
          void job.then((result) => {
            if (result.hits.length > 0 && !cancel.signal.aborted) {
              cancel.abort(new Error("pi-scout race winner"));
            }
          });
        }
      }
      const settled = await Promise.all(jobs);
      for (const result of settled) {
        attempts.push(result.attempt);
        if (result.hits.length > 0) {
          perProvider.push({
            provider: result.attempt.provider,
            weight:
              entries.find((e) => e.provider === result.attempt.provider)
                ?.weight ?? 1,
            hits: result.hits,
          });
        }
      }
      if (options.mode === "race" && perProvider.length > 1) {
        // Deterministic winner: earliest index that returned hits.
        const order = new Map(entries.map((e, i) => [e.provider, i]));
        perProvider.sort(
          (a, b) => (order.get(a.provider) ?? 0) - (order.get(b.provider) ?? 0),
        );
        perProvider.length = 1;
      }
    }
  } finally {
    clearTimeout(deadlineTimer);
    if (options.signal)
      options.signal.removeEventListener("abort", onOuterAbort);
  }

  // A provider cut off by the overall deadline never returned, so the answer is
  // partial even though nothing "failed". Race losers are also "skipped", but
  // only when the deadline fired does that mean missing evidence.
  const degraded = attempts.some(
    (a) =>
      a.status === "error" ||
      a.status === "timeout" ||
      (deadlineHit && a.status === "skipped"),
  );
  return { perProvider, attempts, degraded, deadlineHit };
}
