import assert from "node:assert/strict";
import { test } from "node:test";
import { executeSearch, type PlanEntry } from "../src/executor.ts";
import type { SearchHit } from "../src/types.ts";

const entry = (provider: string, timeoutMs = 1000): PlanEntry => ({
  provider,
  weight: 1,
  timeoutMs,
});

const hit = (provider: string): SearchHit => ({
  title: "t",
  url: "https://" + provider + ".example/1",
  snippet: "s",
  provider,
  rank: 1,
});

test("single mode returns the one provider's hits", async () => {
  const outcome = await executeSearch([entry("a")], async () => [hit("a")], {
    mode: "single",
    deadlineMs: 1000,
    hedgeMs: 0,
  });
  assert.equal(outcome.perProvider.length, 1);
  assert.equal(outcome.attempts[0]!.status, "ok");
  assert.equal(outcome.degraded, false);
});

test("auto mode falls through an empty provider to the next one", async () => {
  const calls: string[] = [];
  const outcome = await executeSearch(
    [entry("a"), entry("b")],
    async (provider) => {
      calls.push(provider);
      return provider === "b" ? [hit("b")] : [];
    },
    { mode: "auto", deadlineMs: 1000, hedgeMs: 0 },
  );
  assert.deepEqual(calls, ["a", "b"]);
  assert.equal(outcome.perProvider[0]!.provider, "b");
  assert.equal(outcome.attempts[0]!.status, "empty");
  assert.equal(outcome.degraded, false);
});

test("a failing provider is recorded without hiding a later success", async () => {
  const outcome = await executeSearch(
    [entry("a"), entry("b")],
    async (provider) => {
      if (provider === "a") throw new Error("boom");
      return [hit("b")];
    },
    { mode: "cascade", deadlineMs: 1000, hedgeMs: 0 },
  );
  assert.equal(outcome.attempts[0]!.status, "error");
  assert.match(outcome.attempts[0]!.error ?? "", /boom/);
  assert.equal(outcome.degraded, true);
  assert.equal(outcome.perProvider.length, 1);
});

test("fuse mode keeps every provider's hits", async () => {
  const outcome = await executeSearch(
    [entry("a"), entry("b")],
    async (provider) => [hit(provider)],
    { mode: "fuse", deadlineMs: 1000, hedgeMs: 0 },
  );
  assert.deepEqual(outcome.perProvider.map((p) => p.provider).sort(), [
    "a",
    "b",
  ]);
});

test("a slow provider times out and does not block the batch", async () => {
  const outcome = await executeSearch(
    [entry("slow", 20), entry("fast")],
    async (provider, signal) => {
      if (provider === "slow") {
        await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
        return [];
      }
      return [hit("fast")];
    },
    { mode: "fuse", deadlineMs: 1000, hedgeMs: 0 },
  );
  const slow = outcome.attempts.find((a) => a.provider === "slow");
  assert.equal(slow?.status, "timeout");
  assert.equal(outcome.perProvider.length, 1);
});

test("an expired deadline is reported explicitly", async () => {
  const outcome = await executeSearch(
    [entry("never", 5000)],
    async (_provider, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    { mode: "single", deadlineMs: 30, hedgeMs: 0 },
  );
  assert.equal(outcome.deadlineHit, true);
  assert.equal(outcome.perProvider.length, 0);
  assert.equal(outcome.degraded, true);
});
