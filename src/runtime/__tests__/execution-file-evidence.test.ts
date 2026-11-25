import { afterEach, beforeEach, expect, test } from "vitest";
import { buildFilePayloadInput } from "../request/execution-file-payload/context.js";
import { captureRequestContextCompaction, restoreRequestContextCompaction } from "../context/semantic-compaction/snapshot.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { compactedSourceFixture, settledSource } from "./support/compacted-execution-source-fixture.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";
import { filePayloadEvidence, filePayloadFixture, filePayloadInput, filePayloadSource, fileWindowResult } from "./support/execution-file-payload-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

test("range edits retain the explicitly supplied source alongside collected canonical evidence", async () => {
  const f = await filePayloadFixture();
  const windows = [fileWindowResult("first-window", "OBSERVED_FIRST_WINDOW"),
    fileWindowResult("last-window", "OBSERVED_LAST_WINDOW")];
  const input = filePayloadInput(windows, { preparedPayload: {
    authoringContract: "execution_file_v1", context: { path: "selected.txt", mode: "range",
      sourceText: "OBSERVED_FIRST_WINDOW" },
  } });
  const projection = buildFilePayloadInput(f.request, input);
  const source = JSON.parse(filePayloadSource(projection.messages)!.content);
  expect(source).toMatchObject({ path: "selected.txt", mode: "range", sourceText: "OBSERVED_FIRST_WINDOW" });
  const evidence = filePayloadEvidence(projection.messages).settledCapabilityResults;
  expect(evidence.map((result: { executionId: string }) => result.executionId))
    .toEqual(["first-window", "last-window"]);
  expect(evidence.map((result: { adapterResult: unknown }) => result.adapterResult))
    .toEqual(windows.map(({ adapterResult }) => adapterResult));
  const text = JSON.stringify(projection.messages);
  expect(text.split("OBSERVED_FIRST_WINDOW")).toHaveLength(3);
  expect(text.split("OBSERVED_LAST_WINDOW")).toHaveLength(2);
  expect(text).not.toContain("UNREAD_FILE_CONTENT");
  expect(projection.resultSourceOverrides.map(({ content }) => content))
    .toEqual(windows.map((result) => JSON.stringify(result)));
  expect(JSON.stringify(projection.resultSourceOverrides)).not.toContain("UNREAD_FILE_CONTENT");
});

test("current selected source follows conflicting file evidence without losing other documents or changing the assignment", async () => {
  const f = await filePayloadFixture();
  const results: Parameters<typeof filePayloadInput>[0] = [
    {
      ...fileWindowResult("old-read", "Coverage: complete file\nOLD_COMPLETE_FILE"),
      adapterResult: {
        kind: "registered_tool_execution_result_v1", authority: "registered_plugin", status: "executed",
        result: { ok: true, tool: "read_text", output: "Coverage: complete file\nOLD_COMPLETE_FILE", producedNewInformation: true,
          data: { path: "selected.txt", complete: true } },
      },
    },
    {
      ...fileWindowResult("recent-edit", "BOUNDED_CHANGED_WINDOW"), capabilityId: "edit_text",
      declaredEffect: "mutation", observedEffect: "mutation",
      adapterResult: {
        kind: "registered_tool_execution_result_v1", authority: "registered_plugin", status: "executed",
        result: { ok: true, tool: "edit_text", output: "Updated selected.txt.", producedNewInformation: true,
          data: { path: "selected.txt", mutationGrounding: "BOUNDED_CHANGED_WINDOW",
            truncation: { groundingTruncated: false, groundingCoverage: "changed_window" } } },
      },
    },
    {
      ...fileWindowResult("related-read", "OTHER_DOCUMENT_CONNECTION"),
      references: [{ kind: "tool_target", target: "other.md" }],
      adapterResult: {
        kind: "registered_tool_execution_result_v1", authority: "registered_plugin", status: "executed",
        result: { ok: true, tool: "read_text", output: "OTHER_DOCUMENT_CONNECTION", producedNewInformation: true,
          data: { path: "other.md", complete: true } },
      },
    },
    {
      ...fileWindowResult("skill-read", "APPLICABLE_SKILL_GUIDANCE"), capabilityId: "read_skill",
      references: [{ kind: "tool_target", target: "technical-work" }],
      adapterResult: {
        kind: "registered_tool_execution_result_v1", authority: "registered_plugin", status: "executed",
        result: { ok: true, tool: "abot_skills", output: "APPLICABLE_SKILL_GUIDANCE", producedNewInformation: true,
          data: { skillId: "technical-work" } },
      },
    },
  ];
  const authoringObjective = "Connect this document to other.md. Then update the related document and verify the result.";
  const input = filePayloadInput(results, { authoringObjective, preparedPayload: {
    authoringContract: "execution_file_v1", context: { path: "selected.txt", mode: "range",
      sourceText: "CURRENT_SELECTED_RANGE\r\n" },
  } });
  const originalResultBytes = results.map((result) => JSON.stringify(result));
  const projection = buildFilePayloadInput(f.request, input);
  const sourceMessages = projection.messages.filter(({ content }) => content.startsWith('{"kind":"execution_file_source_v1"'));
  expect(sourceMessages).toHaveLength(1);
  expect(projection.messages.at(-1)).toEqual(sourceMessages[0]);
  expect(JSON.parse(sourceMessages[0]!.content)).toMatchObject({ path: "selected.txt", mode: "range",
    sourceState: "current_at_payload_preparation", coverage: "complete_selected_range",
    sourceText: "CURRENT_SELECTED_RANGE\r\n" });
  expect(JSON.parse(projection.messages.at(-2)!.content)).toMatchObject({
    kind: "execution_file_assignment_v1", objective: authoringObjective,
  });
  expect(filePayloadEvidence(projection.messages).settledCapabilityResults.map((result: { adapterResult: unknown }) => result.adapterResult))
    .toEqual(results.map(({ adapterResult }) => adapterResult));
  expect(projection.resultSourceOverrides.map(({ content }) => content)).toEqual(originalResultBytes);
  expect(results.map((result) => JSON.stringify(result))).toEqual(originalResultBytes);
  const text = JSON.stringify(projection.messages);
  for (const fact of ["OLD_COMPLETE_FILE", "BOUNDED_CHANGED_WINDOW", "OTHER_DOCUMENT_CONNECTION", "APPLICABLE_SKILL_GUIDANCE"]) {
    expect(text).toContain(fact);
  }
});

test.each([
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["\uFEFFשלום\r\n", "c078bd2e4fc5ba0e53ce9cfb7afff3f9584f4e00792a7b5d11972641e2e0e651"],
])("selected-range content version preserves exact UTF-8 source bytes: %j", async (sourceText, fingerprint) => {
  const f = await filePayloadFixture();
  const input = filePayloadInput([], { preparedPayload: { authoringContract: "execution_file_v1",
    context: { path: "selected.txt", mode: "range", sourceText } } });
  const projection = buildFilePayloadInput(f.request, input);
  const source = JSON.parse(filePayloadSource(projection.messages)!.content);
  expect(source).toMatchObject({ sourceText, sourceState: "current_at_payload_preparation",
    coverage: "complete_selected_range", selectedRangeContentVersion: `sha256:${fingerprint}` });
});

test.each([undefined, "UNREAD_FILE_CONTENT"])("legacy exact edit mode cannot reach authoring with source=%s", async (sourceText) => {
  const f = await filePayloadFixture();
  const input = filePayloadInput([], { preparedPayload: { authoringContract: "execution_file_v1",
    context: { path: "selected.txt", mode: "exact", ...(sourceText === undefined ? {} : { sourceText }) },
  } });
  expect(() => buildFilePayloadInput(f.request, input)).toThrow("file_payload_mode_invalid");
  expect(f.invoke).not.toHaveBeenCalled();
});

test("same-call canonical evidence is projected once, with immutable original fingerprint overrides", async () => {
  const f = await filePayloadFixture();
  const original = settledSource();
  const other = { ...settledSource("other", "OTHER_CALL"), callId: "other-call" };
  const projection = buildFilePayloadInput(f.request, filePayloadInput([original, other]));
  const evidence = filePayloadEvidence(projection.messages);
  expect(evidence.settledCapabilityResults).toHaveLength(1);
  expect(evidence.settledCapabilityResults[0]).not.toHaveProperty("referenceData");
  expect(evidence.settledCapabilityResults[0].adapterResult).toEqual(original.adapterResult);
  expect(projection.resultSourceOverrides).toMatchObject([{
    sourceRef: "payload-result:execution-1", content: JSON.stringify(original),
  }]);
  expect(JSON.stringify(projection.messages)).not.toContain("OTHER_CALL");
  expect(JSON.stringify(projection.messages)).not.toContain("NOT_PROJECTED");
  expect(JSON.stringify(projection.messages).split(f.request.prompt)).toHaveLength(2);
  expect(filePayloadSource(projection.messages)?.content).toContain("EXACT_TARGET\\r\\n");
  expect(original.referenceData).toBe("COVERED_BODY");
  expect(filePayloadEvidence(buildFilePayloadInput(f.request, filePayloadInput([other])).messages))
    .toEqual(filePayloadEvidence(buildFilePayloadInput(f.request, filePayloadInput()).messages));
});

test("restored verified EA evidence transfers digests, never root continuation or editable-source summaries", async () => {
  const original = compactedSourceFixture();
  const before = captureRequestContextCompaction(original.store);
  const restored = restoreRequestContextCompaction(JSON.parse(JSON.stringify(before)));
  const f = await filePayloadFixture({ ...original.request, contextCompactionStore: restored });
  const projection = buildFilePayloadInput(f.request, filePayloadInput(original.results));
  const text = JSON.stringify(projection.messages);
  expect(text).toContain("DIGEST_execution-1");
  expect(text).not.toContain("COVERED_BODY");
  expect(text).not.toContain("ROOT_CONTINUATION_MUST_NOT_TRANSFER");
  expect(text).not.toContain("ROOT_NEXT_ACTION_MUST_NOT_TRANSFER");
  expect(filePayloadSource(projection.messages)?.content).toContain("EXACT_TARGET\\r\\n");
  expect(filePayloadEvidence(projection.messages).settledCapabilityResults[0])
    .toMatchObject({ executionId: "execution-1", compactedSourceRef: "tool-result:execution-1" });
  expect(projection.resultSourceOverrides).toEqual([]);
  expect(captureRequestContextCompaction(restored)).toEqual(before);
});

test.each(["request", "prompt", "call", "source"])("mismatched %s cannot reuse a digest", async (mismatch) => {
  const original = compactedSourceFixture();
  const f = await filePayloadFixture(original.request);
  let request = f.request;
  let input = filePayloadInput(original.results);
  if (mismatch === "request") request = deriveTestRequestExecutionScope(request, { requestId: "other-request" });
  if (mismatch === "prompt") request = deriveTestRequestExecutionScope(request, { prompt: "A different task." });
  if (mismatch === "call") input = { ...input, call: { ...input.call, callId: "other-call" } };
  if (mismatch === "source") input = { ...input, settledCapabilityResults: [{
    ...original.results[0]!, adapterResult: { ...original.results[0]!.adapterResult,
      references: [{ kind: "tool_target", target: "changed.txt" }] },
  }] };
  const projection = buildFilePayloadInput(request, input);
  expect(JSON.stringify(projection.messages)).not.toContain("DIGEST_execution-1");
  expect(filePayloadEvidence(projection.messages)).not.toHaveProperty("compactedSourceEvidence");
});
