import { vi } from "vitest";
import type { ChatMessage } from "../../../model-gateway/types.js";
import type { ModelGatewayClient } from "../../ports.js";
import type { RequestExecutionPolicyId } from "../../config/model-execution-policy.js";
import { createConfiguredToolRegistry } from "../../capabilities/configured-tool-registry.js";
import { createKnowledgeSkillsToolModule } from "../../capabilities/knowledge-skills/tool-module.js";
import { createKnowledgeSkillStore } from "../../knowledge-skills/store.js";
import { createRegisteredToolWorkerCapabilityProvider } from "../../adapters/registered-tool-worker-capabilities.js";
import { createRoleCallLedger, type RoleCallLedger } from "../../orchestration/role-calls/index.js";
import { createRoleCapabilityBinding } from "../../orchestration/worker-capabilities/index.js";
import { projectRequestToolResults } from "../../context/request-tool-results.js";
import { createSemanticCompactionSha256Fingerprint } from "../../context/semantic-compaction/contracts.js";
import { createRequestRoleCallPolicy } from "../../request/role-call-policy.js";
import { createRequestExecutionScope, type RequestExecutionScope } from "../../request/execution-scope.js";
import { createRequestSteeringInbox } from "../../request/request-steering.js";
import { performRootSkillRead } from "../../request/root-skill-read.js";
import { runExecutionAgentDecision } from "../../steps/execution-agent/run.js";
import { runExecutionAgentResponse } from "../../steps/execution-agent/response-run.js";
import { runWorkerDecision } from "../../steps/worker-decision/run.js";
import { createTestRequestExecutionScope } from "./request-execution-scope.js";
import { compactContinuation, readCompactionEnvelope } from "./semantic-compaction-contract-fixture.js";
import { workerEvidenceReply } from "./worker-evidence-script.js";
import { semanticCompactionReplacementSlots } from "./semantic-compaction-replacement-fixture.js";

export const SKILL_COMPACTION_FACT = "Read the exact current state before choosing an input action.";
export const SKILL_COMPACTION_PADDING = "skill-compaction-source-detail";
export const UNREQUESTED_SKILL_CONTENT = "A second document must not be loaded implicitly.";
// Exceed the ordinary result-summary limit; keep the padding beyond its retained preview.
export const SKILL_COMPACTION_CONTENT =
  SKILL_COMPACTION_FACT + "\n" + "Reference background. ".repeat(50) + "\n" +
  (SKILL_COMPACTION_PADDING + " ").repeat(320);
export const SKILL_COMPACTION_PROMPT = "Explain the documented procedure without executing it.";
export const SKILL_COMPACTION_ANSWER = "The documented procedure starts with observing the current state.";

/** A real registered tool and ledger; only model generation and token counts are scripted. */
export async function createKnowledgeSkillsCompactionFixture(policy: RequestExecutionPolicyId) {
  const requestId = `skills-compaction-${policy}`;
  const sessionId = `session-${requestId}`;
  const profileId = "skills-compaction-model";
  const compactionSteps = policy === "supervisor-worker-v1"
    ? ["super.compact.coverage", "super.compact.content", "super.compact.merge", "super.compact.continuation"]
    : ["context.compact"];
  const store = createKnowledgeSkillStore([
    { skillId: "abot-studio", name: "ABot Studio", description: "A procedural reference.", content: SKILL_COMPACTION_CONTENT },
    { skillId: "other", name: "Other", description: "An unrelated reference.", content: UNREQUESTED_SKILL_CONTENT },
  ]);
  const registry = createConfiguredToolRegistry(undefined, [createKnowledgeSkillsToolModule(store)]);
  const execute = vi.spyOn(registry, "execute");
  const abortSignal = new AbortController().signal;
  const provider = createRegisteredToolWorkerCapabilityProvider<unknown>({
    getRequestToolRegistry: () => registry,
    requestId, sessionId, abortSignal, toolPermissionMode: "full_access",
    nextApprovalId: () => "unused-read-approval",
  });
  let forceCompaction = false;
  const modelInputs: Array<{ step: string; messages: readonly ChatMessage[] }> = [];
  const measuredInputs: Array<{ step: string; inputTokens: number }> = [];
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    const messages = input.messages as readonly ChatMessage[];
    modelInputs.push({ step: input.modelStep!, messages });
    if (policy === "supervisor-worker-v1" && compactionSteps.includes(input.modelStep!))
      return { text: SKILL_COMPACTION_FACT, meta: {} };
    if (input.modelStep === "context.compact") {
      const envelope = readCompactionEnvelope(messages);
      const refs = envelope.sourceSlice
        ? [envelope.sourceSlice.sourceRef]
        : envelope.newSources!.map(({ sourceRef }) => sourceRef);
      return {
        text: JSON.stringify({
          sourceDigests: semanticCompactionReplacementSlots(envelope, () => SKILL_COMPACTION_FACT),
          continuation: compactContinuation({
            currentState: SKILL_COMPACTION_FACT,
            findings: [SKILL_COMPACTION_FACT], evidenceRefs: refs,
            nextStep: "Explain the documented procedure.",
          }),
        }),
        meta: {},
      };
    }
    if (input.modelStep === "execution.decision")
      return { text: JSON.stringify({ decision: { action: "respond" } }), meta: {} };
    if (input.modelStep === "worker.evidence")
      return workerEvidenceReply(input, false, SKILL_COMPACTION_FACT);
    if (input.modelStep === "execution.response" || input.modelStep === "worker.result")
      return { text: SKILL_COMPACTION_ANSWER, meta: {} };
    throw new Error(`unexpected_skill_compaction_step:${input.modelStep}`);
  });
  const countInputTokens = vi.fn<NonNullable<ModelGatewayClient["countInputTokens"]>>(async (input) => {
    const isUncompactedConsumer = !compactionSteps.includes(input.modelStep!) &&
      JSON.stringify(input.messages).includes(SKILL_COMPACTION_PADDING);
    const inputTokens = forceCompaction && isUncompactedConsumer ? 63_500 : 1_000;
    measuredInputs.push({ step: input.modelStep!, inputTokens });
    return {
      inputTokens, profileId, provider: "openai", model: "scripted",
      contextWindowTokens: 64_000, source: "provider_input_token_count",
    };
  });
  const steps = ["execution.decision", "execution.response", "worker.evidence", "worker.decision", "worker.result", ...compactionSteps];
  const baseRequest = createTestRequestExecutionScope({
    requestId, sessionId, prompt: SKILL_COMPACTION_PROMPT,
    historyMessages: [], shouldGenerateSessionTitle: false, agentMode: "reasoning",
    executionPolicySelection: { policy, primaryProfileId: profileId, source: "model_profile" },
    runnerConfig: {
      models: { defaults: { profileId, steps: {} } },
      context: { outputReserveTokens: 1500, safetyReserveTokens: 500, attachmentReserveTokens: 0 },
      steps: Object.fromEntries(steps.map((step) => [step, { timeoutMs: 20_000 }])),
    },
    modelPolicy: {
      providers: { openai: { type: "openai" } },
      profiles: { [profileId]: { provider: "openai", model: "scripted", contextWindowTokens: 64_000 } },
      defaults: { profileId, steps: {} },
    },
    modelGatewayClient: { invoke, invokeRaw: vi.fn(), countInputTokens },
    workerCapabilityProvider: provider,
    toolPermissionMode: "full_access", abortSignal,
    onAcknowledgement: vi.fn(), onSessionTitle: vi.fn(), onThinkingDelta: vi.fn(),
    onThinkingTrace: vi.fn(), onAnswerToken: vi.fn(), onEvent: vi.fn(),
  });
  const request = policy === "execution-agent-v1" ? baseRequest : createRequestExecutionScope({
    seed: baseRequest, executionPolicy: baseRequest.executionPolicy, knowledgeSkillStore: store,
    createWorkerCapabilities: () => baseRequest.workerCapabilities.provider,
  });
  const ledger = createRoleCallLedger({ requestId, policy: createRequestRoleCallPolicy(request.executionPolicy) });
  const commit = async (command: unknown) => {
    const result = await ledger.apply({ expectedHead: ledger.current(), command });
    if (!result.ok) throw new Error(result.code);
  };
  await commit({ authority: "runtime", type: "create_root" });
  if (policy === "execution-agent-v1") {
    const call = activeSkillCall(ledger);
    await commit({
      authority: "active_role", type: "update_capability_scope", callId: call.callId,
      invocationAttempt: call.activationCount, mode: "open", catalogGroupIds: ["knowledge"],
    });
  }
  const steeringSnapshot = createRequestSteeringInbox({ requestId }).snapshot();
  const binding = (currentRequest = request, currentLedger = ledger) => createRoleCapabilityBinding({
    requestId, context: currentRequest, call: activeSkillCall(currentLedger), ledger: currentLedger,
    adapters: provider.getAdapters(),
  });
  async function readSkill() {
    if (policy === "execution-agent-v1")
      return binding().execute({ capabilityId: "read_skill", intent: "Read the selected procedure.", controls: { skillId: "abot-studio" } });
    await performRootSkillRead({
      request, ledger, head: ledger.current(), call: activeSkillCall(ledger),
      steeringVersion: steeringSnapshot.version,
      decision: { action: "read_skills", skillIds: ["abot-studio"] },
    });
    await commit({
      authority: "active_role", type: "open_child", callerCallId: "call-1", roleId: "worker",
      objective: SKILL_COMPACTION_PROMPT,
    });
  }
  async function runDecision(currentRequest: RequestExecutionScope = request, currentLedger: RoleCallLedger = ledger) {
    const head = currentLedger.current();
    const call = activeSkillCall(currentLedger);
    if (policy === "execution-agent-v1")
      return runExecutionAgentDecision(currentRequest, {
        head, call, steeringSnapshot, includeAcknowledgement: false, includeTitle: false,
        allowPlanner: false, allowAuditor: false,
      });
    return runWorkerDecision(currentRequest, {
      call,
      requestToolResults: projectRequestToolResults({ ledger: currentLedger, head, callId: call.callId, modelStep: "worker.decision" }),
      capabilitySource: { binding: binding(currentRequest, currentLedger), ledger: currentLedger, head },
    });
  }
  async function runRootResponse(currentRequest: RequestExecutionScope = request, currentLedger: RoleCallLedger = ledger) {
    return runExecutionAgentResponse(currentRequest, {
      head: currentLedger.current(), call: activeSkillCall(currentLedger), steeringSnapshot,
    });
  }
  async function parkForApproval() {
    const call = activeSkillCall(ledger);
    await commit({
      authority: "active_role", type: "begin_capability_execution",
      callId: call.callId, invocationAttempt: call.activationCount,
      capabilityId: "fixture.save_report", declaredEffect: "mutation", intent: "Save the documented result.",
      controlsJson: "{}", actionFingerprint: createSemanticCompactionSha256Fingerprint("fixture.pending-save"),
    });
  }
  return {
    request, ledger, execute, modelInputs, measuredInputs, invoke, readSkill, runDecision, runRootResponse, parkForApproval,
    forceCompaction() { forceCompaction = true; },
  };
}

export function activeSkillCall(ledger: RoleCallLedger) {
  const head = ledger.current();
  const call = head.state.calls.find(({ callId }) => callId === head.state.activeCallId);
  if (!call) throw new Error("skill_compaction_active_call_missing");
  return call;
}
