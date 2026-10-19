import { vi } from "vitest";
import type { ChatMessage } from "../../../model-gateway/types.js";
import type { ModelGatewayClient } from "../../ports.js";
import { createRoleCallLedger, type RoleCallLedger } from "../../orchestration/role-calls/index.js";
import { createRequestRoleCallPolicy } from "../../request/role-call-policy.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import type { KnowledgeSkillDocument } from "../../knowledge-skills/store.js";
import { projectRequestToolResults } from "../../context/request-tool-results.js";
import { buildSupervisorDecisionInput } from "../../steps/supervisor-decision/input.js";
import type { SupervisorResumeContext } from "../../steps/supervisor-decision/contracts.js";
import { projectRoleChildReturnContext } from "../../orchestration/role-calls/child-return.js";
import { projectRootMemoryRecallMessage } from "../../long-term-memory/recall-context.js";
import { buildPlannerDecisionInput } from "../../steps/planner-decision/input.js";
import { buildWorkerDecisionInput } from "../../steps/worker-decision/input.js";
import { deriveTestRequestExecutionScope } from "./request-execution-scope.js";
import { COMPACTION_FACT, semanticContractFixture } from "./semantic-compaction-contract-fixture.js";

export const CORE_SKILL_PADDING = "captured-core-skill-detail ".repeat(100);
export const CORE_SKILL_DOCUMENT: KnowledgeSkillDocument = Object.freeze({
  skillId: "personal-guidance", name: "Project procedure", description: "A scoped procedure.",
  source: "personal" as const, revision: 1,
  content: `${COMPACTION_FACT}\n${CORE_SKILL_PADDING}`,
});
export const CORE_SKILL_OBJECTIVE = "Verify the requested target.";

export async function commitSkillFixture(ledger: RoleCallLedger, command: unknown) {
  const result = await ledger.apply({ expectedHead: ledger.current(), command });
  if (!result.ok) throw new Error(result.code);
  return result;
}

export function activeCoreSkillCall(ledger: RoleCallLedger) {
  const head = ledger.current();
  const call = head.state.calls.find((entry) => entry.callId === head.state.activeCallId);
  if (!call) throw new Error("core_skill_fixture_active_call_missing");
  return call;
}

export async function createCoreSkillContextFixture() {
  const fixture = semanticContractFixture({ contextWindowTokens: 64_000 });
  const modelInputs: Array<{ step: string; messages: readonly ChatMessage[] }> = [];
  const compactInvoke = fixture.invoke.getMockImplementation()!;
  fixture.invoke.mockImplementation(async (input) => {
    if (input.modelStep === "context.compact") return compactInvoke(input);
    modelInputs.push({ step: input.modelStep!, messages: input.messages as readonly ChatMessage[] });
    return { text: "The requested target was verified.", meta: {} };
  });
  const compactCount = fixture.countInputTokens.getMockImplementation()!;
  fixture.countInputTokens.mockImplementation(async (input) =>
    input.modelStep === "context.compact" ? compactCount(input) : {
      inputTokens: 1_000, profileId: "contract-model", provider: "openai", model: "contract-test",
      contextWindowTokens: 64_000, source: "provider_input_token_count",
    });
  const baseRequest = fixture.params.request as RequestExecutionScope;
  const request = deriveTestRequestExecutionScope(baseRequest, {
    runnerConfig: {
      ...baseRequest.runnerConfig,
      steps: { ...baseRequest.runnerConfig.steps,
        "worker.result": { timeoutMs: 20_000 }, "tool_payload.raw": { timeoutMs: 20_000 } },
    },
    modelGatewayClient: {
      invoke: fixture.invoke, countInputTokens: fixture.countInputTokens,
      invokeRaw: vi.fn<ModelGatewayClient["invokeRaw"]>(),
    },
  });
  const ledger = createRoleCallLedger({
    requestId: request.requestId, policy: createRequestRoleCallPolicy(request.executionPolicy),
  });
  await commitSkillFixture(ledger, { authority: "runtime", type: "create_root" });
  async function read(skills: readonly KnowledgeSkillDocument[] = [CORE_SKILL_DOCUMENT]) {
    const call = activeCoreSkillCall(ledger);
    await commitSkillFixture(ledger, {
      authority: "runtime", type: "record_skill_read", callId: call.callId,
      invocationAttempt: call.activationCount, steeringVersion: 0,
      operation: "read_skills", selectors: skills.map((skill) => skill.skillId),
      result: { outcome: "completed", skills },
    });
  }
  async function open(roleId: "planner" | "worker" | "reviewer") {
    const caller = activeCoreSkillCall(ledger);
    await commitSkillFixture(ledger, {
      authority: "active_role", type: "open_child", callerCallId: caller.callId,
      roleId, objective: CORE_SKILL_OBJECTIVE,
      ...(roleId !== "reviewer" ? { workingDirectory: "." } : {}),
      ...(caller.roleId === "planner" ? { plannerPlan: {
        mode: "declare", plan: { summary: CORE_SKILL_OBJECTIVE,
          items: [{ title: "Verify target", objective: CORE_SKILL_OBJECTIVE }] },
        selectedItemIndexes: [0],
      } } : {}),
    });
    return activeCoreSkillCall(ledger);
  }
  async function finish() {
    const child = activeCoreSkillCall(ledger);
    const committed = await commitSkillFixture(ledger, {
      authority: "runtime", type: "return_child", callerCallId: child.parentCallId,
      childCallId: child.callId, outcome: "completed", summary: "The target was checked.",
    });
    return projectRoleChildReturnContext(ledger, committed);
  }
  async function recall() {
    const call = activeCoreSkillCall(ledger);
    const identity = { callId: call.callId, invocationAttempt: call.activationCount, steeringVersion: 0 };
    const begun = await ledger.transactions!.beginMemoryRecall({
      expectedHead: ledger.current(), ...identity, query: "Project conventions",
    });
    if (!begun.ok) throw new Error(begun.issueCode);
    const settled = await ledger.transactions!.settleMemoryRecall({
      expectedHead: ledger.current(), ...identity, recallId: begun.commit.effect.recallId,
      result: { outcome: "empty", records: [], omittedRecordCount: 0 },
    });
    if (!settled.ok) throw new Error(settled.issueCode);
    return projectRootMemoryRecallMessage({ head: ledger.current(), callId: call.callId, steeringVersion: 0 })!;
  }
  function toolResults() {
    const call = activeCoreSkillCall(ledger);
    return projectRequestToolResults({
      ledger, head: ledger.current(), callId: call.callId,
      modelStep: call.roleId === "supervisor" ? "supervisor.decision" :
        call.roleId === "planner" ? "planner.decision" : "worker.decision",
    });
  }
  function workerInput(controls = false) {
    const call = activeCoreSkillCall(ledger);
    return buildWorkerDecisionInput(request, {
      call, requestToolResults: toolResults(), capabilitySource: {
        ledger, head: ledger.current(), binding: Object.freeze({
          requestId: request.requestId, ledger, callId: call.callId,
          invocationAttempt: call.activationCount,
          capabilities: Object.freeze([Object.freeze({
            capabilityId: "fixture.inspect", summary: "Inspect one target.", effect: "observation" as const,
            catalogGroups: Object.freeze(["read" as const]),
            controls: { type: "object" as const, additionalProperties: false as const, properties: {}, required: [] },
          })]),
        }),
      },
      ...(controls ? { selectedCapabilityExecution: {
        capabilityId: "fixture.inspect", intent: "Inspect the requested target.", guidance: "",
      } } : {}),
    });
  }
  function input(options: { resume?: SupervisorResumeContext; memoryRecallMessage?: ChatMessage } = {}) {
    const call = activeCoreSkillCall(ledger);
    if (call.roleId === "worker") return workerInput();
    if (call.roleId === "planner") return buildPlannerDecisionInput(request, {
      call, availableChildRoleIds: ["worker"], toolResults: toolResults(), dependencyHead: ledger.current(),
    });
    return buildSupervisorDecisionInput(request, {
      toolResults: toolResults(), skillReadHead: ledger.current(),
      ...options,
      allowedRoleIds: ["worker", "planner"], includeAcknowledgement: false, includeTitle: false,
      diagnostic: {
        requestId: request.requestId, modelStep: "supervisor.decision", decisionPhase: "routing",
        callId: call.callId, parentCallId: null, depth: 0, invocationAttempt: call.activationCount,
      },
    });
  }
  return { ...fixture, request, ledger, modelInputs, read, open, finish, recall, input, workerInput, toolResults };
}
