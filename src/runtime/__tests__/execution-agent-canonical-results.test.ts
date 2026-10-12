import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { validateModelGatewayMessages } from "../../model-gateway/message-contract.js";
import { createModelStepCompactionController } from "../context/model-step-compaction.js";
import { projectCanonicalRequestToolResult } from "../context/canonical-capability-result.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import type {
  RoleCallLedgerHead,
  RoleCapabilityExecution,
} from "../orchestration/role-calls/index.js";
import { buildExecutionAgentInput } from "../steps/execution-agent/input.js";
import { buildExecutionAgentResponseInput } from "../steps/execution-agent/response-input.js";
import { buildExecutionContinuationMessages } from "../steps/execution-agent/state-context.js";
import { projectSelectedControlsEvidence } from "../steps/execution-agent/controls-evidence.js";
import {
  activeEvidenceCall,
  createControlsEvidenceFixture,
  evidenceDescriptor,
} from "./support/execution-controls-evidence-fixture.js";
import {
  readCompactionEnvelope,
  semanticContractFixture,
} from "./support/semantic-compaction-contract-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

type Fixture = Awaited<ReturnType<typeof createControlsEvidenceFixture>>;
type Settlement = Pick<
  RoleCapabilityExecution,
  "declaredEffect" | "outcome" | "observedEffect"
> & { rawOk: boolean; mutationEvidence?: boolean };
const exactOutput = "  Plugin reports its operation succeeded.\n";

async function settle(fixture: Fixture, settlement: Settlement) {
  const call = activeEvidenceCall(fixture.ledger.current());
  await fixture.commit({
    authority: "active_role",
    type: "begin_capability_execution",
    callId: call.callId,
    invocationAttempt: call.activationCount,
    capabilityId: "evidence.execute",
    declaredEffect: settlement.declaredEffect,
    intent: "Perform this exact operation.",
    controlsJson: '{"target":"exact.txt"}',
  });
  const execution = fixture.ledger.current().state.capabilityExecutions.at(-1)!;
  const exactResult = {
    kind: "registered_tool_execution_result_v1",
    authority: "registered_plugin",
    status: "executed",
    result: {
      ok: settlement.rawOk,
      tool: "example_plugin",
      output: exactOutput,
      producedNewInformation: true,
      ...(settlement.mutationEvidence !== undefined
        ? { data: { mutationEvidence: settlement.mutationEvidence } }
        : {}),
    },
  };
  await fixture.commit({
    authority: "runtime",
    type: "settle_capability_execution",
    callId: call.callId,
    executionId: execution.executionId,
    outcome: settlement.outcome,
    observedEffect: settlement.observedEffect,
    summary: exactOutput,
    exactResult,
  });
  return { executionId: execution.executionId, exactResult };
}

function buildInputs(fixture: Fixture) {
  const head = fixture.ledger.current();
  const common = {
    head,
    call: activeEvidenceCall(head),
    steeringSnapshot: fixture.steering.snapshot(),
  };
  return [
    buildExecutionAgentInput(fixture.request, {
      ...common,
      includeAcknowledgement: false,
      includeTitle: false,
      allowPlanner: false,
      allowAuditor: false,
    }),
    buildExecutionAgentResponseInput(fixture.request, common),
  ];
}

function toolResult(messages: readonly ChatMessage[]) {
  const message = messages.find((item) => item.role === "tool");
  if (!message || message.role !== "tool")
    throw new Error("test_tool_result_missing");
  return { message, envelope: JSON.parse(message.content) };
}

const missingMutationEvidence: Settlement = {
  declaredEffect: "mutation",
  outcome: "failed",
  observedEffect: "none",
  rawOk: true,
};

describe("EA canonical execution result consistency", () => {
  test.each<Settlement>([
    missingMutationEvidence,
    {
      declaredEffect: "observation",
      outcome: "succeeded",
      observedEffect: "observation",
      rawOk: true,
    },
    {
      declaredEffect: "mutation",
      outcome: "succeeded",
      observedEffect: "mutation",
      rawOk: true,
      mutationEvidence: true,
    },
    {
      declaredEffect: "mutation",
      outcome: "failed",
      observedEffect: "mutation",
      rawOk: false,
      mutationEvidence: true,
    },
  ])(
    "projects $outcome/$observedEffect consistently without replacing raw claims",
    async (settlement) => {
      const fixture = await createControlsEvidenceFixture();
      const { executionId, exactResult } = await settle(fixture, settlement);
      const head = fixture.ledger.current();
      const call = activeEvidenceCall(head);
      const canonical = projectCanonicalRequestToolResult(
        head,
        head.state.capabilityExecutions[0]!,
      );
      const controls = projectSelectedControlsEvidence({
        requestId: fixture.request.requestId,
        head,
        call,
        steering: fixture.steering.snapshot(),
        slots: [
          {
            slot: "invocation_1",
            capabilityId: evidenceDescriptor.capabilityId,
            selectionControls: { path: "explicit-new-target.txt" },
            remainingControls: {
              type: "object",
              additionalProperties: false,
              properties: { query: { type: "string", minLength: 1 } },
              required: ["query"],
            },
            controlsEvidenceExecutionIds: [executionId],
            guidance: "Use source evidence only.",
          },
        ],
      });
      const inputs = buildInputs(fixture);
      for (const input of inputs) {
        expect(() =>
          validateModelGatewayMessages(input.messages),
        ).not.toThrow();
        expect(
          input.messages.filter(
            ({ role, content }) =>
              role === "user" && content === fixture.request.prompt,
          ),
        ).toHaveLength(1);
        const { message, envelope } = toolResult(input.messages);
        expect(envelope).toEqual({
          kind: "runtime_execution_capability_result_v1",
          authority: "canonical_role_call_ledger",
          presenceEffect: "runtime_result_only_not_user_intent",
          invocationAttempt: canonical.invocationAttempt,
          result: {
            executionId,
            capabilityId: canonical.capabilityId,
            outcome: canonical.outcome,
            observedEffect: canonical.observedEffect,
            summary: canonical.summary,
            adapterResult: exactResult,
          },
        });
        expect(message.toolCallId).toBe(executionId);
        const action = input.messages[input.messages.indexOf(message) - 1]!;
        expect(action.role).toBe("assistant");
        expect(action.toolCalls?.[0]?.callId).toBe(executionId);
        expect(envelope.result.adapterResult.result.output).toBe(exactOutput);
        expect(controls.view.results[0]).toMatchObject(envelope.result);
      }
      expect(toolResult(inputs[0]!.messages).message).toEqual(
        toolResult(inputs[1]!.messages).message,
      );
      expect(controls.slots[0]!.selectionControls).toEqual({
        path: "explicit-new-target.txt",
      });
      expect(fixture.ledger.current()).toBe(head);
    },
  );

  test("does not add a native result or a second active request to an unrelated empty root", async () => {
    const historyMessages = [
      {
        id: "historical-user", role: "user" as const, content: "Historical source.",
        createdAt: "2026-10-09T10:00:00.000Z",
      },
      {
        id: "historical-assistant", role: "assistant" as const, content: "Historical response.",
        createdAt: "2026-10-09T10:00:01.000Z",
      },
    ];
    const unrelated = await createControlsEvidenceFixture({ historyMessages });
    const before = buildInputs(unrelated).map(({ messages }) => messages);
    const other = await createControlsEvidenceFixture();
    await settle(other, missingMutationEvidence);
    expect(buildInputs(unrelated).map(({ messages }) => messages)).toEqual(
      before,
    );
    expect(
      buildExecutionContinuationMessages(unrelated.ledger.current()),
    ).toEqual([]);
    for (const messages of before) {
      expect(messages.some(({ role }) => role === "tool")).toBe(false);
      expect(
        messages.filter(({ content }) => content === unrelated.request.prompt),
      ).toHaveLength(1);
      for (const { role, content } of historyMessages)
        expect(messages).toContainEqual({ role, content });
    }
  });

  test.each(["outcome", "observedEffect", "summary"] as const)(
    "rejects a settled record missing canonical %s instead of trusting raw ok",
    async (field) => {
      const fixture = await createControlsEvidenceFixture();
      await settle(fixture, missingMutationEvidence);
      const head = fixture.ledger.current();
      const invalid: RoleCallLedgerHead = {
        ...head,
        state: {
          ...head.state,
          capabilityExecutions: head.state.capabilityExecutions.map(
            (execution) => ({ ...execution, [field]: null }),
          ),
        },
      };
      expect(() => buildExecutionContinuationMessages(invalid)).toThrow(
        "request_tool_results_execution_invalid",
      );
    },
  );

  test("passes canonical failure and exact plugin success together to native-source compaction", async () => {
    const compaction = semanticContractFixture({
      policy: "execution-agent-v1",
    });
    const sourceRequest = compaction.params.request;
    const fixture = await createControlsEvidenceFixture({
      contextCompactionStore: compaction.store,
      modelGatewayClient: sourceRequest.modelGatewayClient,
      runnerConfig: sourceRequest.runnerConfig,
      modelPolicy: sourceRequest.modelPolicy,
    });
    const { executionId, exactResult } = await settle(
      fixture,
      missingMutationEvidence,
    );
    const head = fixture.ledger.current();
    const native = buildExecutionContinuationMessages(head);
    const controller = createModelStepCompactionController(fixture.request, {
      call: { ...activeEvidenceCall(head), objective: fixture.request.prompt },
      sourceRevision: head.revision,
      allowedConsumers: ["execution.decision", "execution.response"],
      consumer: "execution.decision",
    });
    const prepared = await controller.getStages()[0]!.prepare(native);
    expect(prepared.kind).toBe("prepared");
    const source = compaction.captured
      .flatMap((messages) => readCompactionEnvelope(messages).newSources ?? [])
      .find(({ sourceRef }) => sourceRef === `tool-result:${executionId}`);
    expect(source).toBeDefined();
    const sourceMessage = JSON.parse(source!.content);
    expect(sourceMessage).toEqual(toolResult(native).message);
    expect(JSON.parse(sourceMessage.content).result).toMatchObject({
      outcome: "failed",
      observedEffect: "none",
      summary: exactOutput.trim(),
      adapterResult: exactResult,
    });
  });
});
