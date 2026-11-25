import { vi } from "vitest";
import type { ChatMessage } from "../../../model-gateway/types.js";
import type { ModelGatewayClient } from "../../ports.js";
import { createModelStepCompactionController } from "../../context/model-step-compaction.js";
import { projectRequestToolResults } from "../../context/request-tool-results.js";
import { readSuperWorkerCompactionSidecar } from "../../context/super-worker-compaction-sidecar.js";
import { prepareSuperSourceInventory } from "../../context/super-compaction/source-inventory.js";
import {
  createRequestContextCompactionStore,
  createSemanticCompactionSha256Fingerprint as hash,
  type SemanticCompactionGenerationParams,
} from "../../context/semantic-compaction/index.js";
import type { RequestContextCompactionStore } from "../../context/semantic-compaction/store.js";
import { createRoleCallLedger, type RoleCallLedgerHead } from "../../orchestration/role-calls/index.js";
import { WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS } from "../../orchestration/worker-capabilities/index.js";
import { createRequestRoleCallPolicy } from "../../request/role-call-policy.js";
import { resolveRequestExecutionPolicy } from "../../request/role-executor-composition.js";
import { buildWorkerDecisionInput } from "../../steps/worker-decision/input.js";
import { runWorkerDecision } from "../../steps/worker-decision/run.js";
import { createTestRequestExecutionScope, deriveTestRequestExecutionScope } from "./request-execution-scope.js";
import { compactContinuation } from "./semantic-compaction-contract-fixture.js";
import { commitDependencyCommand } from "./super-dependency-observation-fixture.js";
import { workerFusedReply } from "./worker-evidence-script.js";

export const DEPENDENCY_BODY_MARKER = "LARGE_CANONICAL_DEPENDENCY_BODY";
export const UNSELECTED_RESULT_MARKER = "UNSELECTED_RESULT_MUST_STAY_OUT";
const BODY = `${DEPENDENCY_BODY_MARKER}\n${"exact observed source detail ".repeat(4_000)}\nSOURCE_END`;

/** A real Worker report enters the ledger before a later Worker selects it. */
export async function dependencyResultCompactionFixture() {
  const policy = resolveRequestExecutionPolicy("supervisor-worker-v1");
  const requestId = "dependency-result-compaction";
  const prompt = "Use the selected observation to assess the assigned source.";
  const ledger = createRoleCallLedger({ requestId, policy: createRequestRoleCallPolicy(policy) });
  const commit = (command: unknown) => commitDependencyCommand(ledger, command);
  await commit({ authority: "runtime", type: "create_root" });
  await commit({ authority: "active_role", type: "open_child", callerCallId: "call-1",
    roleId: "worker", objective: "Observe the assigned source." });
  const producer = ledger.current().state.calls.at(-1)!;
  await commit({ authority: "active_role", type: "begin_capability_execution",
    callId: producer.callId, invocationAttempt: producer.activationCount,
    capabilityId: "source.read", declaredEffect: "observation", intent: "Read the assigned source.",
    controlsJson: "{}", actionFingerprint: hash("canonical source read") });
  await commit({ authority: "runtime", type: "settle_capability_execution",
    callId: producer.callId, executionId: "capability-execution-1", outcome: "succeeded",
    observedEffect: "observation", summary: "Observed the complete assigned source.",
    exactResult: { kind: "registered_tool_execution_result_v1", authority: "registered_plugin", status: "executed",
      result: { ok: true, tool: "source.read", output: BODY, producedNewInformation: true } } });
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async input => {
    if (input.modelStep !== "worker.decision") throw new Error("unexpected_report_model_step");
    return workerFusedReply(input, { action: "return_result" }, "The assigned source was observed.");
  });
  const request = createTestRequestExecutionScope({
    requestId, sessionId: "dependency-result-session", prompt, historyMessages: [],
    shouldGenerateSessionTitle: false, agentMode: "reasoning", toolPermissionMode: "full_access",
    runnerConfig: { models: { defaults: { profileId: "test", steps: {} } },
      context: { outputReserveTokens: 1_000, safetyReserveTokens: 200, attachmentReserveTokens: 0 },
      steps: { "worker.decision": { timeoutMs: 20_000 } } },
    modelPolicy: { providers: { test: { type: "ollama" } },
      profiles: { test: { provider: "test", model: "test", contextWindowTokens: 128_000 } },
      defaults: { profileId: "test", steps: {} } },
    modelGatewayClient: { invoke, invokeRaw: vi.fn() },
    workerCapabilityProvider: { getDescriptors: () => [], getAdapters: () => [] },
    contextCompactionStore: createRequestContextCompactionStore(),
    abortSignal: new AbortController().signal,
    onAcknowledgement: vi.fn(), onSessionTitle: vi.fn(), onThinkingDelta: vi.fn(),
    onThinkingTrace: vi.fn(), onAnswerToken: vi.fn(), onEvent: vi.fn(),
  }, { executionPolicy: policy });
  function options(head: RoleCallLedgerHead, callId: string) {
    const call = head.state.calls.find(candidate => candidate.callId === callId)!;
    const view = projectRequestToolResults({ ledger, head, callId, modelStep: "worker.decision" });
    return { call, requestToolResults: view, capabilitySource: { ledger, head,
      binding: Object.freeze({ requestId, ledger, callId, invocationAttempt: call.activationCount,
        capabilities: Object.freeze([]) }) } };
  }
  const report = await runWorkerDecision(request, options(ledger.current(), producer.callId));
  if (report.action !== "return_result") throw new Error("expected_canonical_worker_report");
  await commit({ authority: "runtime", type: "return_child", callerCallId: "call-1",
    childCallId: producer.callId, outcome: "completed", summary: report.result });
  const selected = ledger.current().state.results.at(-1)!;
  await commit({ authority: "active_role", type: "open_child", callerCallId: "call-1",
    roleId: "worker", objective: "Unrelated sibling work." });
  await commit({ authority: "runtime", type: "return_child", callerCallId: "call-1",
    childCallId: ledger.current().state.calls.at(-1)!.callId, outcome: "completed", summary: UNSELECTED_RESULT_MARKER });
  const unselected = ledger.current().state.results.at(-1)!;
  await commit({ authority: "active_role", type: "open_child", callerCallId: "call-1",
    roleId: "worker", objective: prompt, dependencyResultRefs: [selected.resultRef] });
  const head = ledger.current();
  const call = head.state.calls.at(-1)!;
  const store = createRequestContextCompactionStore();
  const scopeId = `worker:${call.callId}:request-tool-results`;
  const generated: SemanticCompactionGenerationParams[] = [];
  const decisionOptions = options(head, call.callId);
  const sidecar = readSuperWorkerCompactionSidecar(decisionOptions.requestToolResults)!;
  const messages = buildWorkerDecisionInput(request, decisionOptions).context.messages;
  function messagesFor(currentStore: RequestContextCompactionStore, currentHead = head) {
    return buildWorkerDecisionInput(
      deriveTestRequestExecutionScope(request, { contextCompactionStore: currentStore }),
      options(currentHead, call.callId),
    ).context.messages;
  }
  function controller(currentStore: RequestContextCompactionStore = store, currentHead = head) {
    const currentCall = currentHead.state.calls.find(candidate => candidate.callId === call.callId)!;
    return createModelStepCompactionController(
      deriveTestRequestExecutionScope(request, { contextCompactionStore: currentStore }),
      { call: currentCall, sourceRevision: currentHead.revision, scopeId,
        requireSuperWorkerSources: true, consumer: "worker.decision",
        allowedConsumers: WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS },
      async params => {
        generated.push(params);
        const sources = prepareSuperSourceInventory(params);
        return { kind: "runtime_semantic_compaction_checkpoint_v2", ...params.binding,
          scopeId: params.scopeId, sourceRevision: params.sourceRevision,
          sourceDigests: sources.map(source => ({ sourceRef: source.sourceRef,
            sourceFingerprint: source.sourceFingerprint, digest: `RETAINED_FACT_${source.sourceRef}` })),
          continuation: compactContinuation({ evidenceRefs: sources.map(source => source.sourceRef) }) };
      },
    );
  }
  async function compact(input: readonly ChatMessage[] = messages) {
    const prepared = await controller().getStages()[0]!.prepare(input);
    if (prepared.kind !== "prepared") throw new Error(`dependency_compaction_${prepared.reason}`);
    prepared.preparation.commit();
    return prepared.preparation.messages;
  }
  return { policy, request, requestId, prompt, ledger, head, call, selected, unselected,
    store, scopeId, sidecar, messages, messagesFor, generated, invoke, controller, compact, commit };
}
