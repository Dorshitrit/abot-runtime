import { vi } from "vitest";
import { MODEL_STEPS } from "../../../shared/model-steps.js";
import { createWorkerCapabilityDirectActionFingerprint } from "../../orchestration/worker-capabilities/preparation-fingerprint.js";
import { createModelStepCompactionController } from "../../context/model-step-compaction.js";
import {
  buildRequestToolResultsMessage,
  projectRequestToolResults,
} from "../../context/request-tool-results.js";
import { createRoleCallLedger } from "../../orchestration/role-calls/index.js";
import { projectWorkerCapabilityPayloadSourceProvenance } from "../../orchestration/worker-capabilities/payload-source-provenance.js";
import { projectExecutionSettledCapabilityResults } from "../../orchestration/worker-capabilities/execution/context-projection.js";
import { createRequestWorkerCapabilityPayloadAuthor } from "../../request/worker-capability-payload.js";
import { createTestRequestExecutionScope } from "./request-execution-scope.js";

export async function createSuperCompactionSourceFixture(
  requestId = "canonical-source-test",
  target = "catalog.json",
) {
  const ledger = createRoleCallLedger({
    requestId,
    policy: {
      limits: {
        maxDepth: 4,
        maxCalls: 8,
        maxCapabilityExecutions: 8,
        maxObjectiveChars: 16000,
        maxResultChars: 64000,
        maxResponseChars: 64000,
      },
    },
  });
  async function commit(command: unknown) {
    const result = await ledger.apply({
      expectedHead: ledger.current(),
      command,
    });
    if (!result.ok) throw new Error(result.code);
  }
  await commit({ authority: "runtime", type: "create_root" });
  await commit({
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId: "worker",
    objective: "Read the catalog and prepare a draft.",
  });
  await commit({
    authority: "active_role",
    type: "begin_capability_execution",
    callId: "call-2",
    invocationAttempt: 1,
    capabilityId: "example.catalog",
    declaredEffect: "observation",
    intent: "Read catalog",
    controlsJson: "{}",
    actionFingerprint: createWorkerCapabilityDirectActionFingerprint({
      capabilityId: "example.catalog",
      controls: {},
    }),
  });
  await commit({
    authority: "runtime",
    type: "settle_capability_execution",
    callId: "call-2",
    executionId: "capability-execution-1",
    outcome: "succeeded",
    observedEffect: "observation",
    summary: "Catalog read",
    referenceData: "Complete catalog evidence.",
    references: [{ kind: "tool_target", target }],
    exactResult: {
      kind: "generic_capability_result_v1",
      authority: "capability_adapter",
      status: "executed",
      ok: true,
      payload: { referenceData: "Complete catalog evidence." },
    },
  });
  const head = ledger.current();
  const call = head.state.calls.find(({ callId }) => callId === "call-2")!;
  const invoke = vi
    .fn()
    .mockRejectedValue(new Error("fixture_compactor_failure"));
  const request = createTestRequestExecutionScope({
    requestId: head.state.requestId,
    sessionId: "canonical-source-session",
    prompt: "Prepare a draft.",
    historyMessages: [],
    shouldGenerateSessionTitle: false,
    agentMode: "reasoning",
    runnerConfig: {
      models: { defaults: { profileId: "test", steps: {} } },
      context: {
        outputReserveTokens: 1000,
        safetyReserveTokens: 100,
        attachmentReserveTokens: 100,
      },
      steps: {
        "context.compact": { timeoutMs: 1000 },
        [MODEL_STEPS.TOOL_PAYLOAD_RAW]: { timeoutMs: 1000 },
      },
    },
    modelPolicy: {
      providers: { test: { type: "ollama" } },
      profiles: {
        test: { provider: "test", model: "test", contextWindowTokens: 32000 },
      },
      defaults: { profileId: "test", steps: {} },
    },
    modelGatewayClient: { invoke, invokeRaw: vi.fn() },
    workerCapabilityProvider: {
      getDescriptors: () => [],
      getAdapters: () => [],
    },
    toolPermissionMode: "full_access",
    abortSignal: new AbortController().signal,
    onAcknowledgement: vi.fn(),
    onSessionTitle: vi.fn(),
    onThinkingDelta: vi.fn(),
    onThinkingTrace: vi.fn(),
    onAnswerToken: vi.fn(),
    onEvent: vi.fn(),
  });
  const view = projectRequestToolResults({
    ledger,
    head,
    callId: call.callId,
    modelStep: MODEL_STEPS.WORKER_DECISION,
  });
  const worker = () =>
    createModelStepCompactionController(request, {
      call,
      sourceRevision: head.revision,
      scopeId: `worker:${call.callId}:request-tool-results`,
      allowedConsumers: [
        MODEL_STEPS.WORKER_DECISION,
        MODEL_STEPS.TOOL_PAYLOAD_RAW,
      ],
      consumer: MODEL_STEPS.WORKER_DECISION,
    })
      .getStages()[0]!
      .prepare([buildRequestToolResultsMessage(view)]);
  const payloadInput = {
    call,
    executionId: "capability-preparation:call-2:2:1",
    assignmentProvenance: projectWorkerCapabilityPayloadSourceProvenance({
      ledger,
      head,
      call,
    }),
    descriptor: {
      capabilityId: "example.write",
      summary: "Write a draft",
      effect: "mutation",
      requiresPayloadAuthoringObjective: true,
      controls: {
        type: "object",
        additionalProperties: false,
        properties: {},
        required: [],
      },
    },
    authoringObjective: "Write the draft.",
    controls: {},
    settledCapabilityResults: projectExecutionSettledCapabilityResults({
      ledger,
      head,
      call,
      descriptors: [],
      diagnostic: {
        requestId: request.requestId,
        call,
        capabilityIds: [],
        scopeMode: "full",
        scopeCatalogGroupIds: [],
        knownCatalogGroupCount: 0,
        fullCapabilityCount: 0,
        filteredCapabilityCount: 0,
      },
    }),
    contract: { instructions: "Draft body", minBytes: 1, maxBytes: 1000 },
  } satisfies Parameters<
    ReturnType<typeof createRequestWorkerCapabilityPayloadAuthor>["author"]
  >[0];
  const payload = (
    overrides: Partial<
      Parameters<
        ReturnType<typeof createRequestWorkerCapabilityPayloadAuthor>["author"]
      >[0]
    > = {},
  ) =>
    createRequestWorkerCapabilityPayloadAuthor(request).author({
      ...payloadInput,
      ...overrides,
    });
  return {
    request,
    worker,
    payload,
    invoke,
    ledger,
    head,
    call,
    view,
    commit,
    payloadInput,
  };
}
