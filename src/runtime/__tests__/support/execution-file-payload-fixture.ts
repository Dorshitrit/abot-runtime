import type { ChatMessage } from "../../../model-gateway/types.js";
import type { FilePayloadInput } from "../../request/execution-file-payload/binding.js";
import { createControlsEvidenceFixture } from "./execution-controls-evidence-fixture.js";
import { deriveTestRequestExecutionScope, type TestRequestSeed } from "./request-execution-scope.js";

export async function filePayloadFixture(overrides: Partial<TestRequestSeed> = {}) {
  const fixture = await createControlsEvidenceFixture(overrides);
  const request = deriveTestRequestExecutionScope(fixture.request, {
    runnerConfig: {
      ...fixture.request.runnerConfig,
      steps: { ...fixture.request.runnerConfig.steps, "execution.file_payload.raw": { timeoutMs: 20_000 } },
    },
  });
  return { ...fixture, request };
}

export function filePayloadInput(
  results: FilePayloadInput["settledCapabilityResults"] = [],
  overrides: Partial<FilePayloadInput> = {},
): FilePayloadInput {
  return {
    call: { callId: "call-1", parentCallId: null, roleId: "supervisor", depth: 0, objective: null,
      dependencyResultRefs: [], status: "active", childCallIds: [], activationCount: 3, resultRef: null },
    executionId: "execution-next", authoringObjective: "Apply the accepted precise file change.",
    controls: { path: "selected.txt" },
    descriptor: { capabilityId: "edit_text", summary: "Edit selected file", effect: "mutation",
      requiresPayloadAuthoringObjective: true,
      controls: { type: "object", additionalProperties: false,
        properties: { path: { type: "string", minLength: 1 } }, required: ["path"] } },
    contract: { instructions: "Author the accepted change.", minBytes: 0, maxBytes: 262_144 },
    requestSteering: { kind: "request_steering_v1", version: 0, updates: [] },
    preparedPayload: { authoringContract: "execution_file_v1", context: {
      path: "selected.txt", mode: "range", sourceText: "EXACT_TARGET\r\n", unrelated: "NOT_PROJECTED",
    } },
    settledCapabilityResults: results,
    ...overrides,
  };
}

export function filePayloadEvidence(messages: readonly ChatMessage[]) {
  const message = messages.find(({ content }) => content.startsWith("Canonical runtime context:\n"));
  if (!message) throw new Error("file_payload_evidence_missing");
  return JSON.parse(message.content.slice(message.content.indexOf("\n") + 1));
}

export function filePayloadSource(messages: readonly ChatMessage[]) {
  return messages.find(({ content }) => content.includes('"kind":"execution_file_source_v1"'));
}

/** An explicitly observed window, not an automatically captured whole-file source. */
export function fileWindowResult(
  executionId: string,
  text: string,
): FilePayloadInput["settledCapabilityResults"][number] {
  return {
    executionId, callId: "call-1", invocationAttempt: 2, capabilityId: "read_text",
    declaredEffect: "observation", outcome: "succeeded", observedEffect: "observation",
    summary: "Read the selected file window.", referenceData: text,
    references: [{ kind: "tool_target", target: "selected.txt" }],
    adapterResult: {
      kind: "registered_tool_execution_result_v1", authority: "registered_plugin", status: "executed",
      result: { ok: true, tool: "read_text", output: text, producedNewInformation: true,
        data: { path: "selected.txt", complete: false } },
    },
  };
}
