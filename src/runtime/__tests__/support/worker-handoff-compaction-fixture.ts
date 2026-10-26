import { vi } from "vitest";
import type { ModelGatewayClient } from "../../ports.js";
import type { RequestRunnerConfig } from "../../config/runner/contracts.js";
import { projectRequestToolResults } from "../../context/request-tool-results.js";
import { createSemanticCompactionSha256Fingerprint as hash } from "../../context/semantic-compaction/index.js";
import type {
  RoleCallFrame,
  RoleCallLedger,
} from "../../orchestration/role-calls/index.js";
import { buildWorkerDecisionInput } from "../../steps/worker-decision/input.js";
import { completeWorkerHandoffEvidence } from "../../steps/worker-decision/worker-handoff-compaction.js";
import {
  createTestRequestExecutionScope,
  deriveTestRequestExecutionScope,
} from "./request-execution-scope.js";
import { projectSuperCompactionConfiguration } from "../../context/super-compaction/configuration.js";
import {
  commit,
  mixedWorkerFixture,
} from "./super-mixed-compaction-fixture.js";

export const LATE_HANDOFF_MARKER = "LATE_CANONICAL_HANDOFF_MARKER";

export async function createWorkerHandoffFixture(
  options: {
    lateEvidence?: boolean;
    duringCompaction?: (state: {
      ledger: RoleCallLedger;
      call: RoleCallFrame;
      abort: AbortController;
    }) => void | Promise<void>;
  } = {},
) {
  const base = await mixedWorkerFixture();
  if (options.lateEvidence) await appendLateHandoffEvidence(base.ledger);
  const head = base.ledger.current();
  const call = head.state.calls.at(-1)!;
  const view = projectRequestToolResults({
    ledger: base.ledger,
    head,
    callId: call.callId,
    modelStep: "worker.decision",
  });
  const abort = new AbortController();
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    if (input.modelStep === "worker.evidence")
      return {
        text: JSON.stringify({
          decision: {
            requiresExecution: false,
            established:
              "The supplied observations establish the bounded inspection.",
            remaining: "",
            evidenceRefs: view.results.map(({ executionId }) => executionId),
          },
        }),
        meta: {},
      };
    if (input.modelStep === "worker.result")
      return { text: LATE_HANDOFF_MARKER, meta: {} };
    if (!input.modelStep?.startsWith("super.compact."))
      throw new Error("unexpected_handoff_model_step");
    await options.duringCompaction?.({ ledger: base.ledger, call, abort });
    return { text: LATE_HANDOFF_MARKER, meta: {} };
  });
  const original = createTestRequestExecutionScope({
    requestId: head.state.requestId,
    sessionId: "worker-handoff-session",
    prompt: "Inspect the target.",
    historyMessages: [],
    shouldGenerateSessionTitle: false,
    agentMode: "reasoning",
    runnerConfig: {
      models: { defaults: { profileId: "test", steps: {} } },
      context: {
        outputReserveTokens: 2048,
        safetyReserveTokens: 512,
        attachmentReserveTokens: 0,
      },
      steps: {
        "worker.evidence": { timeoutMs: 20000 },
        "worker.decision": { timeoutMs: 20000 },
        "worker.result": { timeoutMs: 20000 },
        "context.compact": { timeoutMs: 20000 },
      },
    } as RequestRunnerConfig,
    modelPolicy: {
      providers: { test: { type: "ollama" } },
      profiles: {
        test: { provider: "test", model: "test", contextWindowTokens: 128000 },
      },
      defaults: {
        profileId: "test",
        steps: {
          "worker.evidence": "test",
          "worker.decision": "test",
          "worker.result": "test",
          "context.compact": "test",
        },
      },
    },
    modelGatewayClient: { invoke, invokeRaw: vi.fn() },
    contextCompactionStore: base.store,
    workerCapabilityProvider: {
      getDescriptors: () => [],
      getAdapters: () => [],
    },
    toolPermissionMode: "full_access",
    abortSignal: abort.signal,
    onAcknowledgement: vi.fn(),
    onSessionTitle: vi.fn(),
    onThinkingDelta: vi.fn(),
    onThinkingTrace: vi.fn(),
    onAnswerToken: vi.fn(),
    onEvent: vi.fn(),
  });
  const request = deriveTestRequestExecutionScope(
    original,
    projectSuperCompactionConfiguration(
      original,
      original.executionPolicy.authority,
    ),
  );
  const decisionOptions: Parameters<typeof buildWorkerDecisionInput>[1] = {
    call,
    requestToolResults: view,
    capabilitySource: {
      ledger: base.ledger,
      head,
      binding: Object.freeze({
        requestId: head.state.requestId,
        ledger: base.ledger,
        callId: call.callId,
        invocationAttempt: call.activationCount,
        capabilities: Object.freeze([]),
      }),
    },
  };
  return {
    ...base,
    head,
    call,
    view,
    request,
    decisionOptions,
    invoke,
    abort,
    refresh: () =>
      completeWorkerHandoffEvidence(
        request,
        decisionOptions,
        buildWorkerDecisionInput(request, decisionOptions),
      ),
  };
}

async function appendLateHandoffEvidence(ledger: RoleCallLedger) {
  const call = ledger.current().state.calls.at(-1)!;
  await commit(ledger, {
    authority: "active_role",
    type: "begin_capability_execution",
    callId: call.callId,
    invocationAttempt: call.activationCount,
    capabilityId: "files.read",
    declaredEffect: "observation",
    intent: "Read another target.",
    controlsJson: '{"path":"later.txt"}',
    actionFingerprint: hash("new handoff evidence"),
  });
  await commit(ledger, {
    authority: "runtime",
    type: "settle_capability_execution",
    callId: call.callId,
    executionId: ledger.current().state.capabilityExecutions.at(-1)!
      .executionId,
    outcome: "succeeded",
    observedEffect: "observation",
    summary: "Read later target.",
    referenceData: LATE_HANDOFF_MARKER,
    exactResult: {
      kind: "generic_capability_result_v1",
      authority: "capability_adapter",
      status: "executed",
      ok: true,
      payload: { content: LATE_HANDOFF_MARKER },
    },
  });
}
