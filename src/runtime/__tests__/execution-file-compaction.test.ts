import { afterEach, beforeEach, expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { buildFilePayloadInput } from "../request/execution-file-payload/context.js";
import { createFilePayloadCompactionController } from "../request/execution-file-payload/compaction.js";
import { captureRequestContextCompaction, restoreRequestContextCompaction } from "../context/semantic-compaction/snapshot.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { semanticCompactionReplacementSlots } from "./support/semantic-compaction-replacement-fixture.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";
import { filePayloadEvidence, filePayloadFixture, filePayloadInput, filePayloadSource, fileWindowResult } from "./support/execution-file-payload-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

test.each(["EXACT_TARGET\r\n", ""])("range evidence keeps selected source %j exact through compaction and replay", async (sourceText) => {
  const f = await filePayloadFixture();
  const original = fileWindowResult("execution-1", "COVERED_BODY");
  const input = filePayloadInput([original], { preparedPayload: {
    authoringContract: "execution_file_v1", context: { path: "selected.txt", mode: "range", sourceText },
  } });
  const projection = buildFilePayloadInput(f.request, input);
  expect(JSON.stringify(projection.messages)).not.toContain("UNREAD_FILE_CONTENT");
  const originalSourceMessage = filePayloadSource(projection.messages);
  expect(JSON.parse(originalSourceMessage!.content)).toMatchObject({ mode: "range", sourceText });
  const assignment = projection.messages.find(({ content }) => content.includes('"kind":"execution_file_assignment_v1"'));
  f.invoke.mockImplementation(async (request) => {
    expect(request.modelStep).toBe("context.compact");
    const envelope = readCompactionEnvelope(request.messages as readonly ChatMessage[]);
    expect(envelope.newSources).toMatchObject([{ sourceRef: "payload-result:execution-1" }]);
    expect(envelope.newSources[0].content).toContain("COVERED_BODY");
    expect(JSON.stringify(envelope.newSources)).not.toContain("EXACT_TARGET");
    expect(JSON.stringify(envelope)).not.toContain("UNREAD_FILE_CONTENT");
    return { text: JSON.stringify({
      sourceDigests: semanticCompactionReplacementSlots(envelope, () => "PRESERVED_TOOL_FACT"),
      continuation: { completed: [], currentState: "Writing the accepted change.", findings: [], evidenceRefs: [],
        artifacts: [], decisions: [], failedApproaches: [], openWork: [], blockers: [], nextStep: "Author the accepted file change." },
    }), meta: {} };
  });
  const controller = createFilePayloadCompactionController(f.request, input, projection);
  const prepared = await controller.getStages()[0]!.prepare(projection.messages);
  expect(prepared.kind).toBe("prepared");
  if (prepared.kind !== "prepared") throw new Error("compaction_not_prepared");
  expect(filePayloadSource(prepared.preparation.messages)).toEqual(originalSourceMessage);
  expect(prepared.preparation.messages).toContainEqual(assignment);
  expect(filePayloadEvidence(prepared.preparation.messages).settledCapabilityResults).toEqual([]);
  expect(JSON.stringify(prepared.preparation.messages)).toContain("PRESERVED_TOOL_FACT");
  expect(JSON.stringify(prepared.preparation.messages)).not.toContain("COVERED_BODY");
  expect(JSON.stringify(prepared.preparation.messages)).not.toContain("UNREAD_FILE_CONTENT");
  await prepared.preparation.commit();
  const snapshot = captureRequestContextCompaction(f.request.contextCompactionStore!);
  expect(snapshot.sources).toEqual(projection.resultSourceOverrides);
  expect(JSON.stringify(snapshot)).not.toContain("UNREAD_FILE_CONTENT");

  const restored = restoreRequestContextCompaction(JSON.parse(JSON.stringify(snapshot)));
  const request = deriveTestRequestExecutionScope(f.request, { contextCompactionStore: restored });
  const nextProjection = buildFilePayloadInput(request, input);
  const nextController = createFilePayloadCompactionController(request, input, nextProjection);
  const projected = nextController.project(nextProjection.messages);
  expect(filePayloadSource(projected)).toEqual(originalSourceMessage);
  expect(JSON.stringify(projected)).not.toContain("UNREAD_FILE_CONTENT");
  expect(filePayloadEvidence(projected).semanticCheckpoint.coveredSources)
    .toEqual(filePayloadEvidence(prepared.preparation.messages).semanticCheckpoint.coveredSources);
  await expect(nextController.getStages()[0]!.prepare(projected)).resolves.toMatchObject({ kind: "unavailable" });
  expect(f.invoke).toHaveBeenCalledOnce();
  expect(captureRequestContextCompaction(restored)).toEqual(snapshot);
});

test("one preparation checkpoint cannot redirect another file operation", async () => {
  const f = await filePayloadFixture();
  const first = filePayloadInput();
  const second = filePayloadInput([], { executionId: "another-execution", controls: { path: "other.txt" },
    preparedPayload: { authoringContract: "execution_file_v1", context: { path: "other.txt", mode: "range", sourceText: "OTHER_EXACT_SOURCE" } } });
  const firstController = createFilePayloadCompactionController(f.request, first, buildFilePayloadInput(f.request, first));
  const secondProjection = buildFilePayloadInput(f.request, second);
  const secondController = createFilePayloadCompactionController(f.request, second, secondProjection);
  expect(secondController.getStages()[0]!.scopeId).not.toBe(firstController.getStages()[0]!.scopeId);
  expect(filePayloadSource(secondController.project(secondProjection.messages))?.content).toContain("OTHER_EXACT_SOURCE");
  expect(f.invoke).not.toHaveBeenCalled();
});

function readCompactionEnvelope(messages: readonly ChatMessage[]) {
  for (const { content } of messages) {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed.newSources)) return parsed;
    } catch { /* instructions are plain text */ }
  }
  throw new Error("compaction_envelope_missing");
}
