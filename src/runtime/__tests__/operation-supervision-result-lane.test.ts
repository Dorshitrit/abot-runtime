import { bindRequestToolResultsMessage } from "../context/request-tool-results-message-binding.js";
import { expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { buildImmediateOperationSupervisionEvidenceMessage } from "../context/operation-supervision-evidence.js";
import { projectOperationSupervisionEvidenceClosure } from "../context/operation-supervision-evidence-projection.js";
import {
  buildRequestToolResultsMessage,
  projectRequestToolResults,
} from "../context/request-tool-results.js";
import { createSemanticCompactionSha256Fingerprint as hash } from "../context/semantic-compaction/contracts.js";
import {
  commit,
  mixedWorkerFixture,
} from "./support/super-mixed-compaction-fixture.js";

const EXTRA_EVIDENCE =
  "Independent canonical detail absent from the adapter body.";
const REFERENCES = [{ kind: "tool_target" as const, target: "referenced.txt" }];

async function resultLaneFixture() {
  const { ledger } = await mixedWorkerFixture();
  for (let index = 0; index < 2; index++) {
    const call = ledger.current().state.calls.at(-1)!;
    await commit(ledger, {
      authority: "active_role",
      type: "begin_capability_execution",
      callId: call.callId,
      invocationAttempt: call.activationCount,
      capabilityId: "files.read",
      declaredEffect: "observation",
      intent: "Read the referenced target.",
      controlsJson: '{"path":"referenced.txt"}',
      actionFingerprint: hash("same referenced target action"),
    });
    await commit(ledger, {
      authority: "runtime",
      type: "settle_capability_execution",
      callId: call.callId,
      executionId: ledger.current().state.capabilityExecutions.at(-1)!
        .executionId,
      outcome: "succeeded",
      observedEffect: "observation",
      summary: "Read referenced target.",
      outcomeFingerprint: "succeeded",
      referenceData: EXTRA_EVIDENCE,
      references: REFERENCES,
      exactResult: {
        kind: "generic_capability_result_v1",
        authority: "capability_adapter",
        status: "executed",
        ok: true,
        payload: { content: "Adapter body." },
      },
    });
  }
  const head = ledger.current();
  const call = head.state.calls.at(-1)!;
  const view = projectRequestToolResults({
    ledger,
    head,
    callId: call.callId,
    modelStep: "worker.decision",
  });
  const notice = buildImmediateOperationSupervisionEvidenceMessage(head, call)!;
  const origin = head.state.capabilityExecutions.at(-1)!.executionId;
  const message = buildRequestToolResultsMessage(view);
  const context = {
    requestId: head.state.requestId,
    call,
    sourceRevision: head.revision,
    consumer: "worker.decision" as const,
  };
  function project(resultMessage: ChatMessage) {
    return projectOperationSupervisionEvidenceClosure(
      [resultMessage, notice],
      context,
    );
  }
  function alterResult(
    change: (result: Record<string, unknown>) => void,
  ): ChatMessage {
    const payload = JSON.parse(message.content) as {
      results: Record<string, unknown>[];
    };
    const result = payload.results.find(
      ({ executionId }) => executionId === origin,
    )!;
    change(result);
    return bindRequestToolResultsMessage(view, JSON.stringify(payload));
  }
  return { message, project, alterResult, origin };
}

function readEvidence(messages: readonly ChatMessage[]) {
  const capsule = messages
    .map(({ content }) => JSON.parse(content))
    .find(({ kind }) => kind === "runtime_operation_supervision_evidence_v1");
  return capsule.entries[0].evidence;
}

test("S03/S08: complete projected receipt keeps a reference and independent exact data once", async () => {
  const fixture = await resultLaneFixture();
  const projected = fixture.project(fixture.message);
  expect(readEvidence(projected)).toEqual({
    kind: "existing_exact_capability_result_lane",
    executionId: fixture.origin,
  });
  const lane = JSON.parse(projected[0]!.content);
  expect(
    lane.results.find(
      ({ executionId }: { executionId: string }) =>
        executionId === fixture.origin,
    ),
  ).toMatchObject({ referenceData: EXTRA_EVIDENCE, references: REFERENCES });
  expect(projected[1]!.content).not.toContain(EXTRA_EVIDENCE);
});

test.each([
  ["referenceData", "drop"],
  ["referenceData", "tamper"],
  ["references", "drop"],
  ["references", "tamper"],
])(
  "S08: rejects %s %s even when the adapter body and accepted action match",
  async (field, mutation) => {
    const fixture = await resultLaneFixture();
    const altered = fixture.alterResult((result) => {
      if (mutation === "drop") delete result[field];
      else
        result[field] =
          field === "referenceData"
            ? "Incorrect detail."
            : [{ kind: "tool_target", target: "wrong.txt" }];
    });
    expect(() => fixture.project(altered)).toThrow(
      "operation_supervision_evidence_exact_lane_invalid",
    );
  },
);

test("S03/S08: a summary-only receipt embeds the complete original with independent data", async () => {
  const fixture = await resultLaneFixture();
  const summaryOnly = fixture.alterResult((result) => {
    delete result.adapterResult;
    delete result.referenceData;
  });
  expect(readEvidence(fixture.project(summaryOnly))).toMatchObject({
    kind: "embedded_exact_result",
    acceptedAction: {
      executionId: fixture.origin,
      controls: { path: "referenced.txt" },
    },
    receipt: { referenceData: EXTRA_EVIDENCE, references: REFERENCES },
    adapterResult: { payload: { content: "Adapter body." } },
  });
});
