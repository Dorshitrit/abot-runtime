import { afterEach, beforeEach, expect, test } from "vitest";
import { projectExecutionPayloadCompactedEvidence } from "../request/execution-payload-compacted-evidence.js";
import { buildExecutionControlsEvidenceMessage } from "../steps/execution-agent/controls-compacted-evidence.js";
import { buildRequestToolResultsMessage } from "../context/request-tool-results.js";
import { readBoundRequestToolResultsView } from "../context/request-tool-results-message-binding.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import {
  compactedSourceFixture,
  payloadSourceContext,
  settledSource,
} from "./support/compacted-execution-source-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(resetDebugLoggerConfig);

const steering = {
  kind: "request_steering_v1" as const,
  version: 0,
  updates: [],
};

test("payload substitutes covered mutation bytes once and retains newly gathered raw evidence", () => {
  const f = compactedSourceFixture();
  const fresh = { ...settledSource("fresh"), referenceData: "NEW_EVIDENCE" };
  const results = [...f.results, fresh];
  const context = payloadSourceContext(results);
  const before = JSON.stringify({ context, results });
  const projection = projectExecutionPayloadCompactedEvidence(
    f.request,
    context,
    results,
  );
  expect(projection.results[0]).toMatchObject({
    executionId: "execution-1",
    compactedSourceRef: "tool-result:execution-1",
  });
  expect(projection.results[0]).not.toHaveProperty("adapterResult");
  expect(projection.results[0]).not.toHaveProperty("referenceData");
  expect(projection.results[1]).toBe(fresh);
  expect(projection.evidence?.sources).toHaveLength(1);
  expect(JSON.stringify(projection)).not.toContain("ROOT_CONTINUATION");
  expect(JSON.stringify({ context, results })).toBe(before);
});

test("payload keeps an independent or changed reference body alongside the verified digest", () => {
  const f = compactedSourceFixture([
    settledSource("execution-1", "DIFFERENT_REFERENCE"),
  ]);
  const projection = projectExecutionPayloadCompactedEvidence(
    f.request,
    payloadSourceContext(f.results),
    f.results,
  );
  expect(projection.results[0]).toMatchObject({
    referenceData: "DIFFERENT_REFERENCE",
    compactedSourceRef: "tool-result:execution-1",
  });
});

test("uncompacted, target-only and delegated Worker payloads keep their preexisting path", () => {
  const f = compactedSourceFixture();
  const context = payloadSourceContext(f.results);
  const withoutStore = { ...f.request, contextCompactionStore: undefined };
  const targetOnly = { ...context, contextScope: "target_only" as const };
  const { root: _root, ...base } = context as Extract<
    typeof context,
    { root: unknown }
  >;
  const worker = {
    ...base,
    worker: {
      callId: "worker-1",
      parentCallId: "call-1",
      invocationAttempt: 1,
      objective: "Delegated assignment",
    },
  };
  for (const [request, payload] of [
    [withoutStore, context],
    [f.request, targetOnly],
    [f.request, worker],
  ] as const) {
    const projection = projectExecutionPayloadCompactedEvidence(
      request,
      payload,
      f.results,
    );
    expect(projection.results).toBe(f.results);
    expect(projection.evidence).toBeUndefined();
  }
});

test("Controls projects selected digests with fresh results while preserving message binding", () => {
  const selected = settledSource("selected"),
    unselected = settledSource("unselected"),
    fresh = { ...settledSource("fresh"), referenceData: "FRESH_BODY" };
  const f = compactedSourceFixture([selected, unselected]);
  const view = {
    sourceRevision: 8,
    results: [selected, fresh],
    scope: { kind: "call" as const, callId: "call-1" },
  };
  const message = buildExecutionControlsEvidenceMessage(view, {
    requestId: f.request.requestId,
    callId: "call-1",
    steering,
    compaction: { prompt: f.request.prompt, store: f.store },
  });
  const payload = JSON.parse(message.content);
  expect(payload.results[0]).not.toHaveProperty("adapterResult");
  expect(payload.results[0]).not.toHaveProperty("referenceData");
  expect(payload.results[1]).toEqual(fresh);
  expect(
    payload.compactedSourceEvidence.sources.map(
      (entry: { executionId: string }) => entry.executionId,
    ),
  ).toEqual(["selected"]);
  expect(readBoundRequestToolResultsView(message)).toEqual(view);
  expect(message.role).toBe("user");
  expect(message.content).not.toContain("DIGEST_unselected");
  expect(message.content).not.toContain("ROOT_CONTINUATION");
});

test("Controls without an applicable checkpoint preserves the original evidence projection", () => {
  const f = compactedSourceFixture();
  const view = { sourceRevision: 8, results: f.results };
  const unchanged = buildRequestToolResultsMessage(view);
  const actual = buildExecutionControlsEvidenceMessage(view, {
    requestId: f.request.requestId,
    callId: "call-1",
    steering,
    compaction: { prompt: "changed request", store: f.store },
  });
  expect(actual).toEqual(unchanged);
});

test("Controls does not erase reference data absent from the covered adapter result", () => {
  const result = settledSource(
    "execution-1",
    "INDEPENDENT_DETAIL_NOT_IN_ADAPTER",
  );
  const f = compactedSourceFixture([result]);
  const message = buildExecutionControlsEvidenceMessage(
    { sourceRevision: 8, results: [result] },
    {
      requestId: f.request.requestId,
      callId: "call-1",
      steering,
      compaction: { prompt: f.request.prompt, store: f.store },
    },
  );
  expect(JSON.parse(message.content).results[0].referenceData).toBe(
    result.referenceData,
  );
});

test.each([
  "registered-output",
  "generic-reference",
  "mutation-grounding",
] as const)(
  "covered %s supplements are replaced once in both payload and Controls",
  (representation) => {
    const base = settledSource();
    const adapterResult =
      representation === "generic-reference"
        ? {
            kind: "generic_capability_result_v1" as const,
            authority: "capability_adapter" as const,
            status: "executed" as const,
            ok: true,
            payload: { referenceData: base.referenceData! },
          }
        : {
            kind: "registered_tool_execution_result_v1" as const,
            authority: "registered_plugin" as const,
            status: "executed" as const,
            result: {
              ok: true,
              tool: base.capabilityId,
              output:
                representation === "registered-output"
                  ? base.referenceData!
                  : base.summary,
              producedNewInformation: true,
              ...(representation === "mutation-grounding"
                ? { data: { mutationGrounding: base.referenceData! } }
                : {}),
            },
          };
    const result = { ...base, adapterResult };
    const f = compactedSourceFixture([result]);
    const payload = projectExecutionPayloadCompactedEvidence(
      f.request,
      payloadSourceContext([result]),
      [result],
    );
    const controls = JSON.parse(
      buildExecutionControlsEvidenceMessage(
        { sourceRevision: 8, results: [result] },
        {
          requestId: f.request.requestId,
          callId: "call-1",
          steering,
          compaction: { prompt: f.request.prompt, store: f.store },
        },
      ).content,
    );
    for (const projected of [payload.results[0], controls.results[0]]) {
      expect(projected).not.toHaveProperty("adapterResult");
      expect(projected).not.toHaveProperty("referenceData");
      expect(projected).toMatchObject({
        executionId: result.executionId,
        compactedSourceRef: `tool-result:${result.executionId}`,
      });
    }
    expect(result.referenceData).toBe(base.referenceData);
  },
);
