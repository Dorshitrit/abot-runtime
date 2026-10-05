import { afterEach, beforeEach, expect, test } from "vitest";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { resolveExecutionCompactedSources } from "../context/execution-compacted-evidence.js";
import { createSemanticCompactionSha256Fingerprint as hash } from "../context/semantic-compaction/contracts.js";
import {
  compactedSourceFixture,
  settledSource,
} from "./support/compacted-execution-source-fixture.js";
import { supervisionClosureFixture } from "./support/supervision-closure-fixture.js";
import { projectCanonicalRequestToolResult } from "../context/canonical-capability-result.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(resetDebugLoggerConfig);

test("resolves only requested covered results and never transfers root continuation", () => {
  const a = settledSource("a"),
    b = settledSource("b"),
    fresh = settledSource("fresh");
  const f = compactedSourceFixture([a, b]);
  const result = resolveExecutionCompactedSources({
    ...f.resolver,
    results: [a, fresh],
  });
  expect(result?.sources).toEqual([
    { ...f.checkpoint.sourceDigests[0], executionId: "a" },
  ]);
  expect(JSON.stringify(result)).not.toContain("DIGEST_b");
  expect(JSON.stringify(result)).not.toContain("ROOT_CONTINUATION");
  expect(
    resolveExecutionCompactedSources({ ...f.resolver, results: [fresh] }),
  ).toBeUndefined();
  expect(
    resolveExecutionCompactedSources({ ...f.resolver, store: undefined }),
  ).toBeUndefined();
});

test.each([
  { requestId: "foreign-request" },
  { callId: "foreign-call" },
  { roleId: "worker" },
  { scopeId: "role:supervisor:call-1:controls-refinement" },
  { currentRequestFingerprint: hash("old prompt") },
  { objectiveFingerprint: hash("old objective") },
  { allowedConsumers: ["execution.response"] as const },
])("rejects checkpoint binding %j", (overrides) => {
  const f = compactedSourceFixture(undefined, overrides);
  expect(resolveExecutionCompactedSources(f.resolver)).toBeUndefined();
});

test.each([
  { executionId: "foreign-execution" },
  { callId: "foreign-call" },
  { invocationAttempt: 3 },
  { capabilityId: "foreign-capability" },
  {
    adapterResult: settledSource("other").adapterResult,
    summary: "Same adapter is still exact.",
  },
])("checks exact execution identity %j", (changed) => {
  const f = compactedSourceFixture();
  const result = { ...f.results[0]!, ...changed };
  const actual = resolveExecutionCompactedSources({
    ...f.resolver,
    results: [result],
  });
  if ("summary" in changed) {
    expect(actual?.sources).toHaveLength(1);
    return;
  }
  expect(actual).toBeUndefined();
});

test("changed result bytes, stale hashes and missing original bytes never reuse", () => {
  const f = compactedSourceFixture();
  const changed = {
    ...f.results[0]!,
    adapterResult: { ...f.results[0]!.adapterResult, status: "unavailable" },
  };
  expect(
    resolveExecutionCompactedSources({ ...f.resolver, results: [changed] }),
  ).toBeUndefined();
  const stale = compactedSourceFixture(undefined, {
    sourceDigests: [
      {
        ...f.checkpoint.sourceDigests[0]!,
        sourceFingerprint: hash("different bytes"),
      },
    ],
  });
  expect(resolveExecutionCompactedSources(stale.resolver)).toBeUndefined();
  const missing = { ...f.store, materializeSource: () => undefined };
  expect(
    resolveExecutionCompactedSources({ ...f.resolver, store: missing }),
  ).toBeUndefined();
});

test("native sources from the actual EA ledger are reusable after a committed root checkpoint", async () => {
  const f = await supervisionClosureFixture();
  f.installCheckpoint();
  const results = f.head.state.capabilityExecutions.map((execution) =>
    projectCanonicalRequestToolResult(f.head, execution),
  );
  const reused = resolveExecutionCompactedSources({
    requestId: f.request.requestId,
    prompt: f.request.prompt,
    objective: f.request.prompt,
    callId: f.call.callId,
    store: f.store,
    results: results.map((result) => ({
      ...result,
      adapterResult: result.adapterResult!,
    })),
  });
  expect(reused?.sources.map(({ executionId }) => executionId)).toEqual(
    results.map(({ executionId }) => executionId),
  );
  expect(
    reused?.sources.every(({ sourceRef }) =>
      sourceRef.startsWith("tool-result:"),
    ),
  ).toBe(true);
  expect(f.invoke).not.toHaveBeenCalled();
});

test.each([
  "attached-media",
  "wrong-message-role",
  "wrong-envelope-kind",
  "malformed-json",
] as const)(
  "does not reuse a %s source even with matching result identity",
  (mutation) => {
    const initial = compactedSourceFixture();
    const message = JSON.parse(initial.sources[0]!.content);
    if (mutation === "attached-media")
      message.attachments = [{ kind: "image", content: "covered separately" }];
    if (mutation === "wrong-message-role") message.role = "user";
    if (mutation === "wrong-envelope-kind") {
      const envelope = JSON.parse(message.content);
      envelope.kind = "runtime_request_tool_results_v1";
      message.content = JSON.stringify(envelope);
    }
    const content =
      mutation === "malformed-json" ? "{invalid" : JSON.stringify(message);
    const source = {
      ...initial.sources[0]!,
      content,
      sourceFingerprint: hash(content),
    };
    const f = compactedSourceFixture(initial.results, {}, [source]);
    expect(resolveExecutionCompactedSources(f.resolver)).toBeUndefined();
  },
);
