import { semanticCompactionDigestSlots } from "./semantic-compaction-model-fixture.js";
import { vi } from "vitest";
import type { ChatMessage } from "../../../model-gateway/types.js";
import type { ModelGatewayClient } from "../../ports.js";
import type {
  WorkerCapabilityAdapter,
  WorkerCapabilityPreparedExecution,
} from "../../orchestration/worker-capabilities/index.js";
import type { RequestCapabilityExecutionView } from "../../request/execution-scope.js";
import { createRequestSteeringInbox } from "../../request/request-steering.js";
import { createTestRequestExecutionScope } from "./request-execution-scope.js";
import {
  compactContinuation,
  readCompactionEnvelope,
} from "./semantic-compaction-contract-fixture.js";

export const CONTROLS_APPROVAL_FINGERPRINT = `sha256:${"c".repeat(64)}`;
const RAW_EVIDENCE = "CONTROL_LIFECYCLE_EXACT_SOURCE";
const TARGET = "chosen/report.txt";

export function supervisionApprovalFixture() {
  const options = { approval: true };
  const requestId = "execution-controls-lifecycle";
  const profileId = "controls-lifecycle";
  const steering = createRequestSteeringInbox({ requestId });
  const performed = vi.fn();
  const calls: Array<{ step: string; messages: readonly ChatMessage[] }> = [];
  const events: Array<{ name: string; data?: Record<string, unknown> }> = [];
  let rootTurns = 0;
  let selected = false;
  const needsSource = true;
  const encode = (decision: unknown) => ({
    text: JSON.stringify({ decision }),
    meta: {},
  });
  const descriptor = {
    capabilityId: "apply_selected",
    summary: "Apply one explicitly selected target.",
    effect: "mutation" as const,
    catalogGroups: ["files"],
    controls: {
      type: "object" as const,
      additionalProperties: false as const,
      properties: {
        target: { type: "string" as const, minLength: 1, maxLength: 200 },
      },
      required: ["target"],
    },
  };
  function prepared(
    controls: Readonly<Record<string, unknown>>,
  ): WorkerCapabilityPreparedExecution {
    const target = controls.target;
    if (typeof target !== "string") throw new Error("invalid_lifecycle_target");
    let approved = !options.approval;
    return {
      actionFingerprint: CONTROLS_APPROVAL_FINGERPRINT,
      acceptedControls: controls,
      snapshot: { target: controls.target },
      ...(options.approval
        ? {
            approvalRequest: {
              requestId,
              approvalId: "controls-exact-approval",
              call: { tool: "apply_selected", params: controls },
            },
          }
        : {}),
      applyApprovalDecision: (decision) => {
        approved = decision.decision.approved;
      },
      execute: async (executionId) => {
        if (!approved) throw new Error("unexpected_unapproved_effect");
        performed(executionId, controls);
        return {
          outcome: "succeeded",
          observedEffect: "mutation",
          summary: `Applied ${controls.target}.`,
          exactResult: {
            kind: "generic_capability_result_v1",
            authority: "capability_adapter",
            status: "executed",
            ok: true,
            payload: { target },
          },
        };
      },
    };
  }
  const prepare = vi.fn<
    NonNullable<
      WorkerCapabilityAdapter<RequestCapabilityExecutionView>["prepare"]
    >
  >(async (input) => {
    return prepared(input.controls);
  });
  const restore = vi.fn<
    NonNullable<
      WorkerCapabilityAdapter<RequestCapabilityExecutionView>["restore"]
    >
  >(async (input, snapshot) => {
    if (JSON.stringify(snapshot) !== JSON.stringify({ target: TARGET }))
      throw new Error("changed_approval_target");
    return prepared(input.controls);
  });
  const adapter: WorkerCapabilityAdapter<RequestCapabilityExecutionView> = {
    descriptor,
    prepare,
    restore,
    execute: async () => {
      throw new Error("unexpected_unprepared_effect");
    },
  };
  const sourceExecute = vi.fn<
    WorkerCapabilityAdapter<RequestCapabilityExecutionView>["execute"]
  >(async () => ({
    outcome: "succeeded",
    observedEffect: "observation",
    summary: `Target ${TARGET}.`,
    referenceData: `${RAW_EVIDENCE}:${"source detail ".repeat(700)}:${TARGET}`,
    references: [{ kind: "tool_target", target: TARGET }],
    exactResult: {
      kind: "generic_capability_result_v1",
      authority: "capability_adapter",
      status: "executed",
      ok: true,
      payload: { target: TARGET },
    },
  }));
  const sourceAdapter: WorkerCapabilityAdapter<RequestCapabilityExecutionView> =
    {
      descriptor: {
        capabilityId: "read_source",
        summary: "Read the existing source.",
        effect: "observation",
        catalogGroups: ["files"],
        controls: {
          type: "object",
          additionalProperties: false,
          properties: {},
          required: [],
        },
        controlsRefinement: "mechanical_when_complete",
      },
      execute: sourceExecute,
    };
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    const step = input.modelStep!;
    const messages = input.messages as readonly ChatMessage[];
    calls.push({ step, messages });
    if (step === "execution.response")
      return { text: "The request settled.", meta: {} };
    if (step === "execution.decision") {
      rootTurns += 1;
      if (rootTurns === 1)
        return encode({
          action: "open_capability_scope",
          catalogGroupIds: ["files"],
          acknowledgement: "Checking the target.",
        });
      if (steering.snapshot().version > 0 || selected)
        return encode({ action: "respond" });
      if (needsSource && (rootTurns === 2 || rootTurns === 3))
        return encode({
          action: "invoke_capability",
          capabilityId: "read_source",
          intent: "Read the source.",
          ...(rootTurns === 2 ? { workingDirectory: "." } : {}),
        });
      selected = true;
      return encode({
        action: "invoke_capability",
        capabilityId: descriptor.capabilityId,
        intent: "Apply the target.",
        operationObjective: `Apply only ${TARGET}.`,
        controlsEvidenceExecutionIds: needsSource
          ? ["capability-execution-2"]
          : [],
        ...(!needsSource ? { workingDirectory: "." } : {}),
      });
    }
    if (step === "capability.controls") {
      return encode({
        invocations: {
          invocation_1: {
            disposition: "execute",
            controls: { target: TARGET },
          },
        },
      });
    }
    if (step === "context.compact") {
      const envelope = readCompactionEnvelope(messages);
      const refs = envelope.newSources!.map(({ sourceRef }) => sourceRef);
      return {
        text: JSON.stringify({
          continuation: compactContinuation({
            currentState: `Target ${TARGET}.`,
            evidenceRefs: refs,
          }),
          sourceDigests: semanticCompactionDigestSlots(
            refs.map(() => `Target ${TARGET}.`),
          ),
        }),
        meta: {},
      };
    }
    throw new Error(`unexpected_lifecycle_model_step:${step}`);
  });
  const countInputTokens = vi.fn<
    NonNullable<ModelGatewayClient["countInputTokens"]>
  >(async (input) => {
    return {
      inputTokens:
        input.modelStep === "execution.decision" &&
        (input.messages as readonly ChatMessage[]).some(
          ({ role }) => role === "tool",
        ) &&
        (input.messages as readonly ChatMessage[]).some(
          ({ role, content }) =>
            role === "user" &&
            content.startsWith(
              '{"kind":"runtime_operation_supervision_evidence_v1"',
            ),
        )
          ? 24_000
          : 1_000,
      profileId,
      provider: "openai",
      model: "controls-lifecycle-test",
      contextWindowTokens: 32_000,
      source: "provider_input_token_count",
    };
  });
  const makeRequest = () =>
    createTestRequestExecutionScope({
      requestId,
      sessionId: "controls-lifecycle-session",
      prompt: `Apply the requested operation to ${TARGET}.`,
      historyMessages: [],
      shouldGenerateSessionTitle: false,
      agentMode: "reasoning",
      executionPolicySelection: {
        policy: "execution-agent-v1",
        primaryProfileId: profileId,
        source: "model_profile",
      },
      requestSteering: steering,
      runnerConfig: {
        models: { defaults: { profileId, steps: {} } },
        context: {
          outputReserveTokens: 2_048,
          safetyReserveTokens: 512,
          attachmentReserveTokens: 0,
        },
        steps: {
          "execution.decision": { timeoutMs: 20_000 },
          "execution.response": { timeoutMs: 20_000 },
          "capability.controls": { timeoutMs: 20_000 },
          "context.compact": { timeoutMs: 20_000 },
        },
      },
      modelPolicy: {
        providers: { test: { type: "openai" } },
        profiles: {
          [profileId]: {
            provider: "test",
            model: "controls-lifecycle-test",
            contextWindowTokens: 32_000,
          },
        },
        defaults: { profileId, steps: {} },
      },
      modelGatewayClient: { invoke, invokeRaw: vi.fn(), countInputTokens },
      workerCapabilityProvider: {
        getDescriptors: () => [descriptor, sourceAdapter.descriptor],
        getAdapters: () => [adapter, sourceAdapter],
      },
      toolPermissionMode: options.approval ? "ask" : "full_access",
      ...(options.approval
        ? {
            approvalGate: {
              resolve: async () => ({ kind: "awaiting_approval" as const }),
            },
          }
        : {}),
      abortSignal: new AbortController().signal,
      onAcknowledgement: vi.fn(),
      onSessionTitle: vi.fn(async () => undefined),
      onThinkingDelta: vi.fn(),
      onThinkingTrace: vi.fn(),
      onAnswerToken: vi.fn(),
      onEvent: (name, data) => {
        events.push({ name, data });
      },
    });
  return {
    makeRequest,
    calls,
    events,
    invoke,
    countInputTokens,
    prepare,
    restore,
    performed,
    sourceExecute,
    steering,
  };
}
