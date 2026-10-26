import { vi } from "vitest";
import type { ChatMessage } from "../../../model-gateway/types.js";
import type { ModelGatewayClient } from "../../ports.js";
import type { CapabilityDescriptor } from "../../orchestration/capability-adapters/index.js";
import type { WorkerCapabilityAdapter, WorkerCapabilityPreparedExecution } from "../../orchestration/worker-capabilities/index.js";
import type { RequestCapabilityExecutionView } from "../../request/execution-scope.js";
import { createRoleCallLedger } from "../../orchestration/role-calls/index.js";
import { EXECUTION_AGENT_V1_EXECUTION_POLICY } from "../../request/role-executor-composition.js";
import { createRequestSteeringInbox } from "../../request/request-steering.js";
import { createTestRequestExecutionScope } from "./request-execution-scope.js";
import { compactContinuation, readCompactionEnvelope } from "./semantic-compaction-contract-fixture.js";
import { semanticCompactionReplacementSlots } from "./semantic-compaction-replacement-fixture.js";

export const observationDescriptor: CapabilityDescriptor = Object.freeze({
  capabilityId: "source.observe_window",
  summary: "Inspect one bounded source window by path and optional line range or locator.",
  effect: "observation",
  catalogGroups: Object.freeze(["read"]),
  selectionControlIds: Object.freeze(["path"]),
  controls: Object.freeze({
    type: "object", additionalProperties: false,
    properties: Object.freeze({
      path: Object.freeze({ type: "string", minLength: 1, maxLength: 4096 }),
      start_line: Object.freeze({ type: "integer", minimum: 1, maximum: 10000 }),
      end_line: Object.freeze({ type: "integer", minimum: 1, maximum: 10000 }),
      locator: Object.freeze({ type: "string", minLength: 1, maxLength: 512 }),
    }),
    required: Object.freeze(["path"]),
  }),
});

export const observationApprovalFingerprint = `sha256:${"d".repeat(64)}`;

export const observedRange = (start: number, end: number) => ({
  path: "project/styles.css", start_line: start, end_line: end, locator: null,
});

export const observationDecision = (controls: Record<string, unknown>) => ({
  action: "invoke_capability", capabilityId: observationDescriptor.capabilityId,
  intent: "Inspect the selected source window.", selectionControls: controls,
});

export function observationCapsule(messages: readonly ChatMessage[], kind: string) {
  for (const message of messages) {
    try {
      const value = JSON.parse(message.content) as Record<string, unknown>;
      if (value.kind === kind) return value;
    } catch { /* Non-capsule message. */ }
  }
  return undefined;
}

const encode = (decision: unknown) => ({ text: JSON.stringify({ decision }), meta: {} });
const rawMarker = "OBSERVATION_FIRST_WINDOW_RAW";

export function createObservationControlsFixture(options: {
  guidance?: string;
  compactFirstRead?: boolean;
  batches?: readonly (readonly Record<string, unknown>[])[];
  refinementControls?: Record<string, unknown>;
  approval?: boolean;
  additionalDescriptors?: readonly CapabilityDescriptor[];
  guidanceByCapability?: Readonly<Record<string, string>>;
} = {}) {
  const requestId = "ea-observation-controls";
  const steering = createRequestSteeringInbox({ requestId });
  const calls: Array<{ step: string; messages: readonly ChatMessage[]; format: unknown }> = [];
  const adapterControls: Record<string, unknown>[] = [];
  const batches = options.batches ?? [[observedRange(1, 240)], [observedRange(241, 480)]];
  let rootCalls = 0;
  const execute = vi.fn<WorkerCapabilityAdapter<RequestCapabilityExecutionView>["execute"]>(async (input) => {
    const controls = { ...input.controls };
    adapterControls.push(controls);
    return {
      outcome: "succeeded", observedEffect: "observation",
      summary: `Observed lines ${String(controls.start_line)}-${String(controls.end_line)}.`,
      referenceData: options.compactFirstRead && adapterControls.length === 1
        ? rawMarker.repeat(500) : "The selected range was observed.",
      references: [{ kind: "tool_target", target: String(controls.path) }],
    };
  });
  function prepared(controls: Readonly<Record<string, unknown>>): WorkerCapabilityPreparedExecution {
    let approved = false;
    return {
      actionFingerprint: observationApprovalFingerprint, acceptedControls: controls, snapshot: { controls },
      approvalRequest: { requestId, approvalId: "observation-exact-approval",
        call: { tool: "observe_window", params: controls } },
      applyApprovalDecision: (decision) => { approved = decision.decision.approved; },
      execute: async () => {
        if (!approved) throw new Error("unexpected_unapproved_observation");
        adapterControls.push({ ...controls });
        return { outcome: "succeeded", observedEffect: "observation", summary: "Observed the approved source window." };
      },
    };
  }
  const prepare = vi.fn<NonNullable<WorkerCapabilityAdapter<RequestCapabilityExecutionView>["prepare"]>>(
    async (input) => prepared(input.controls),
  );
  const restore = vi.fn<NonNullable<WorkerCapabilityAdapter<RequestCapabilityExecutionView>["restore"]>>(
    async (input, snapshot) => {
      if (JSON.stringify(snapshot) !== JSON.stringify({ controls: input.controls }))
        throw new Error("changed_observation_approval_controls");
      return prepared(input.controls);
    },
  );
  const adapter: WorkerCapabilityAdapter<RequestCapabilityExecutionView> = {
    descriptor: observationDescriptor, execute, ...(options.approval ? { prepare, restore } : {}),
  };
  const descriptors = [observationDescriptor, ...(options.additionalDescriptors ?? [])];
  const adapters = [adapter, ...(options.additionalDescriptors ?? []).map((descriptor) => ({
    descriptor, execute: async () => { throw new Error("unexpected_additional_observation_execution"); },
  }))];
  const getExecutionGuidance = vi.fn(async (capabilityId: string) =>
    capabilityId === observationDescriptor.capabilityId ? options.guidance ?? ""
      : options.guidanceByCapability?.[capabilityId] ?? "");
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    const messages = input.messages as readonly ChatMessage[];
    const step = String(input.modelStep);
    calls.push({ step, messages, format: input.format });
    if (step === "context.compact") {
      const envelope = readCompactionEnvelope(messages);
      const sources = envelope.sourceSlice ? [envelope.sourceSlice] : envelope.newSources ?? [];
      return { text: JSON.stringify({
        continuation: compactContinuation({
          completed: ["Inspected lines 1-240 of project/styles.css."],
          currentState: "Lines 1-240 were observed; later source lines remain unread.",
          findings: ["The first window ends at line 240."],
          evidenceRefs: sources.map(({ sourceRef }) => sourceRef),
          openWork: ["Inspect the requested subsequent source range."],
          nextStep: "Inspect lines 241-480 of project/styles.css.",
        }),
        sourceDigests: semanticCompactionReplacementSlots(envelope,
          () => "Observed project/styles.css lines 1-240; the next unread line is 241."),
      }), meta: {} };
    }
    if (step === "capability.controls") {
      const assignment = observationCapsule(messages, "runtime_execution_capability_refinement_v1");
      if (!assignment) throw new Error("observation_controls_assignment_missing");
      const slots = assignment.invocations as Array<{ slot: string }>;
      return encode({ invocations: Object.fromEntries(slots.map(({ slot }) => [slot, {
        disposition: "execute", controls: options.refinementControls ?? {},
      }])) });
    }
    if (step === "execution.response") return { text: "The requested source windows were inspected.", meta: {} };
    if (step !== "execution.decision") throw new Error(`unexpected_observation_step:${step}`);
    rootCalls += 1;
    if (rootCalls === 1) return encode({ action: "open_capability_scope", catalogGroupIds: ["read"],
      acknowledgement: "I will inspect the requested source windows." });
    const batch = batches[rootCalls - 2];
    if (!batch) return encode({ action: "respond" });
    const workingDirectory = rootCalls === 2 ? { workingDirectory: null } : {};
    if (batch.length === 1) return encode({ ...observationDecision(batch[0]!), ...workingDirectory });
    return encode({ action: "invoke_capabilities", invocations: batch.map((controls) => {
      const { action: _action, ...invocation } = observationDecision(controls);
      return invocation;
    }), ...workingDirectory });
  });
  const countInputTokens = vi.fn<NonNullable<ModelGatewayClient["countInputTokens"]>>(async (input) => ({
    inputTokens: options.compactFirstRead && input.modelStep === "execution.decision" &&
      JSON.stringify(input.messages).includes(rawMarker) ? 29_000 : 1000,
    profileId: "observation-test", provider: "openai", model: "observation-test",
    contextWindowTokens: 32000, source: "provider_input_token_count",
  }));
  const steps = { "execution.decision": "execution.decision", "execution.response": "execution.response",
    "capability.controls": "capability.controls", "context.compact": "context.compact" };
  const request = createTestRequestExecutionScope({
    requestId, sessionId: "observation-controls-session", prompt: "Inspect successive source windows without rereading covered lines.",
    historyMessages: [], shouldGenerateSessionTitle: false, agentMode: "reasoning",
    executionPolicySelection: { policy: "execution-agent-v1", primaryProfileId: "observation-test", source: "model_profile" },
    runnerConfig: { models: { defaults: { profileId: "observation-test", steps } },
      context: { outputReserveTokens: 1000, safetyReserveTokens: 200, attachmentReserveTokens: 100 },
      steps: Object.fromEntries(Object.keys(steps).map((step) => [step, { timeoutMs: 20000 }])) },
    modelPolicy: { providers: { test: { type: "openai" } },
      profiles: { "observation-test": { provider: "test", model: "observation-test", contextWindowTokens: 32000 } },
      defaults: { profileId: "observation-test", steps } },
    modelGatewayClient: { invoke, invokeRaw: vi.fn(), countInputTokens }, requestSteering: steering,
    workerCapabilityProvider: { getDescriptors: () => descriptors, getAdapters: () => adapters, getExecutionGuidance },
    toolPermissionMode: options.approval ? "ask" : "full_access", abortSignal: new AbortController().signal,
    ...(options.approval ? { approvalGate: { resolve: async () => ({ kind: "awaiting_approval" as const }) } } : {}),
    onAcknowledgement: vi.fn(), onSessionTitle: vi.fn(async () => undefined),
    onThinkingDelta: vi.fn(), onThinkingTrace: vi.fn(), onAnswerToken: vi.fn(), onEvent: vi.fn(),
  });
  return { request, steering, calls, execute, invoke, countInputTokens, adapterControls, prepare, restore, getExecutionGuidance };
}

export async function observationRefinementCall() {
  const ledger = createRoleCallLedger({ requestId: "ea-observation-controls", policy: {
    authority: EXECUTION_AGENT_V1_EXECUTION_POLICY.authority,
    limits: { maxDepth: 4, maxCalls: 12, maxCapabilityExecutions: 24,
      maxObjectiveChars: 4096, maxResultChars: 8192, maxResponseChars: 8192 },
  } });
  const result = await ledger.apply({ expectedHead: ledger.current(), command: { authority: "runtime", type: "create_root" } });
  if (!result.ok) throw new Error(result.code);
  const head = ledger.current();
  const call = head.state.calls.find(({ callId }) => callId === head.state.activeCallId);
  if (!call) throw new Error("observation_root_missing");
  return { head, call };
}
