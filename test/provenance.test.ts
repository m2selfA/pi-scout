import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeRun } from "../src/provenance.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

test("a run directory keeps report, metadata and raw bytes with hashes", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-scout-run-"));
  const run = await writeRun({
    sessionId: "session-abc",
    kind: "search",
    request: { query: "x" },
    report: "result body",
    raw: { exa: { hits: [1] } },
    root,
  });

  assert.match(run.runId, /^run_/);
  const report = readFileSync(run.reportPath, "utf8");
  assert.ok(report.includes("Untrusted web content"));
  assert.equal(run.reportSha256, sha(report));

  const rawPath = run.rawPaths.exa!;
  assert.equal(run.rawSha256.exa, sha(readFileSync(rawPath, "utf8")));

  const metadata = JSON.parse(readFileSync(run.metadataPath, "utf8")) as {
    kind: string;
    reportSha256: string;
  };
  assert.equal(metadata.kind, "search");
  assert.equal(metadata.reportSha256, run.reportSha256);
});

test("session ids are hashed into the path, never used verbatim", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-scout-run-"));
  const run = await writeRun({
    sessionId: "../../etc/passwd",
    kind: "fetch",
    request: {},
    report: "x",
    raw: {},
    root,
  });
  assert.ok(!run.dir.includes("passwd"));
  assert.ok(!run.dir.includes(".."));
});
