import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { CapabilityAdapterResult } from "../orchestration/capability-adapters/index.js";
import type { RoleCallLedger, RoleCallLedgerCommand } from "../orchestration/role-calls/index.js";
import { captureRoleCallLedgerCheckpoint, restoreRoleCallLedgerCheckpoint } from "../orchestration/role-calls/checkpoint.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { captureRequestContextCompaction, restoreRequestContextCompaction } from "../context/semantic-compaction/snapshot.js";
import { createRequestRoleCallPolicy } from "../request/role-call-policy.js";
import { buildPlannerGraphInput } from "../steps/planner-graph/input.js";
import { EXECUTION_AGENT_PLANNER_EXECUTOR, runPlannerGraph } from "../steps/planner-graph/run.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";
import {
  activeSkillCall, createKnowledgeSkillsCompactionFixture,
  SKILL_COMPACTION_FACT, SKILL_COMPACTION_PADDING, UNREQUESTED_SKILL_CONTENT,
} from "./support/knowledge-skills-compaction-fixture.js";

const RESULTS = "runtime_request_tool_results_v1";
const ASSIGNMENT = "runtime_execution_agent_planner_assignment_v1";
const objective = "Plan the requested change within its existing scope.";
const decline = { text: JSON.stringify({ decision: { action: "decline", reason: "One bounded change." } }), meta: {} };

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { resetDebugLoggerConfig(); vi.restoreAllMocks(); });

function capsule(messages: readonly ChatMessage[], kind: string) {
  for (const { content } of messages) {
    try {
      const parsed = JSON.parse(content);
      if (parsed.kind === kind) return parsed;
    } catch { /* Non-JSON instructions. */ }
  }
  return undefined;
}

async function commit(ledger: RoleCallLedger, command: RoleCallLedgerCommand) {
  const result = await ledger.apply({ expectedHead: ledger.current(), command });
  if (!result.ok) throw new Error(`fixture_commit_failed:${result.code}`);
  return result;
}

async function openPlanner(ledger: RoleCallLedger) {
  await commit(ledger, {
    authority: "active_role", type: "open_child", callerCallId: "call-1",
    roleId: "planner", objective,
  });
  return activeSkillCall(ledger);
}

function registeredResult(tool = "abot_skills", ok = true): CapabilityAdapterResult {
  return {
    kind: "registered_tool_execution_result_v1", authority: "registered_plugin", status: "executed",
    result: { tool, ok, producedNewInformation: ok,
      output: JSON.stringify({ skillId: "fixture-skill", name: "Fixture Skill", content: "Respect the user's QA limits." }) },
  };
}

async function appendResult(
  ledger: RoleCallLedger,
  capabilityId: string,
  exactResult = registeredResult(),
  outcome: "succeeded" | "failed" = "succeeded",
) {
  const call = activeSkillCall(ledger);
  const started = await commit(ledger, {
    authority: "active_role", type: "begin_capability_execution", callId: call.callId,
    invocationAttempt: call.activationCount, capabilityId, declaredEffect: "observation",
    intent: "Capture the requested record.", controlsJson: "{}",
  });
  if (started.effect.type !== "capability_execution_begun") throw new Error("missing_execution");
  await commit(ledger, {
    authority: "runtime", type: "settle_capability_execution", callId: call.callId,
    executionId: started.effect.executionId, outcome,
    observedEffect: outcome === "succeeded" ? "observation" : "none",
    summary: "Captured the record.", exactResult,
  });
  return started.effect.executionId;
}

function plannerRequest(f: Awaited<ReturnType<typeof createKnowledgeSkillsCompactionFixture>>) {
  const originalInvoke = f.invoke.getMockImplementation()!;
  f.invoke.mockImplementation(async (input) => input.modelStep === "planner.graph" ? decline : originalInvoke(input));
  return deriveTestRequestExecutionScope(f.request, {
    runnerConfig: { ...f.request.runnerConfig,
      steps: { ...f.request.runnerConfig.steps, "planner.graph": { timeoutMs: 20_000 } } },
  });
}

test("Planner receives captured single and multiple Skill reads before budget accounting, without changing its objective", async () => {
  const f = await createKnowledgeSkillsCompactionFixture("execution-agent-v1");
  await f.readSkill();
  const multipleId = await appendResult(f.ledger, "read_skills");
  const call = await openPlanner(f.ledger);
  const head = f.ledger.current();
  const before = JSON.stringify(head);
  const input = buildPlannerGraphInput(f.request, call, head);
  const guidance = capsule(input.context.messages, RESULTS);
  expect(guidance).toMatchObject({ authority: "reference_data", callerCallId: "call-1",
    purpose: "skill_guidance_for_the_current_assignment",
    presenceEffect: "procedural_guidance_not_user_intent_criteria_or_completion_evidence" });
  expect(guidance.results.map((entry: { capabilityId: string }) => entry.capabilityId)).toEqual(["read_skill", "read_skills"]);
  expect(guidance.results[1]).toMatchObject({ executionId: multipleId, adapterResult: registeredResult() });
  expect(JSON.stringify(guidance)).toContain(SKILL_COMPACTION_PADDING);
  expect(JSON.stringify(guidance)).not.toContain(UNREQUESTED_SKILL_CONTENT);
  expect(capsule(input.context.messages, ASSIGNMENT).objective).toBe(objective);
  const without = buildPlannerGraphInput(f.request, call, {
    ...head, state: { ...head.state, capabilityExecutions: [] },
  });
  expect(input.context.budget.parts.referenceInputTokens).toBeGreaterThan(without.context.budget.parts.referenceInputTokens);
  expect(input.context.budget.estimatedInputTokens).toBeGreaterThan(without.context.budget.estimatedInputTokens);
  expect(JSON.stringify(head)).toBe(before);
  expect(f.execute).toHaveBeenCalledOnce();
});

test.each([
  { label: "list", capabilityId: "list_skills", result: registeredResult() },
  { label: "write", capabilityId: "create_skill", result: registeredResult() },
  { label: "foreign tool", capabilityId: "read_skill", result: registeredResult("foreign_tool") },
  { label: "foreign capability", capabilityId: "read_file", result: registeredResult() },
  { label: "failed output", capabilityId: "read_skill", result: registeredResult("abot_skills", false) },
  { label: "failed execution", capabilityId: "read_skill", result: registeredResult(), outcome: "failed" as const },
  { label: "generic imitation", capabilityId: "read_skill", result: {
    kind: "generic_capability_result_v1", authority: "capability_adapter", status: "executed",
    ok: true, payload: { tool: "abot_skills", output: "Claimed Skill guidance." },
  } as CapabilityAdapterResult },
])("$label does not alter Planner context", async ({ capabilityId, result, outcome }) => {
  const f = await createKnowledgeSkillsCompactionFixture("execution-agent-v1");
  await appendResult(f.ledger, capabilityId, result, outcome);
  const call = await openPlanner(f.ledger);
  const head = f.ledger.current();
  const actual = buildPlannerGraphInput(f.request, call, head);
  const empty = buildPlannerGraphInput(f.request, call, { ...head, state: { ...head.state, capabilityExecutions: [] } });
  expect(actual.context.messages).toEqual(empty.context.messages);
  expect(capsule(actual.context.messages, RESULTS)).toBeUndefined();
});

test("guidance must belong to the same request and canonical parent call", async () => {
  const f = await createKnowledgeSkillsCompactionFixture("execution-agent-v1");
  await f.readSkill();
  const call = await openPlanner(f.ledger);
  const head = f.ledger.current();
  const foreignResults = { ...head, state: { ...head.state,
    capabilityExecutions: head.state.capabilityExecutions.map((entry) => ({ ...entry, callId: "other-call" })),
  } };
  expect(capsule(buildPlannerGraphInput(f.request, call, foreignResults).context.messages, RESULTS)).toBeUndefined();
  expect(() => buildPlannerGraphInput({ ...f.request, requestId: "another-request" }, call, head)).toThrow("planner_graph_skill_caller_invalid");
  expect(() => buildPlannerGraphInput(f.request, { ...call, parentCallId: "other-call" }, head)).toThrow("planner_graph_skill_caller_invalid");
});

test("the real EA Planner executor forwards guidance without a Store read or another role", async () => {
  const f = await createKnowledgeSkillsCompactionFixture("execution-agent-v1");
  await f.readSkill();
  const call = await openPlanner(f.ledger);
  const request = plannerRequest(f);
  expect(await EXECUTION_AGENT_PLANNER_EXECUTOR.execute({ context: request, call, ledger: f.ledger, availableChildRoleIds: [] }))
    .toMatchObject({ kind: "terminal", outcome: "completed" });
  const inputs = f.invoke.mock.calls.map(([input]) => input);
  expect(inputs.map(({ modelStep }) => modelStep)).toEqual(["planner.graph"]);
  expect(JSON.stringify(capsule(inputs[0]!.messages as ChatMessage[], RESULTS))).toContain(SKILL_COMPACTION_PADDING);
  expect(f.execute).toHaveBeenCalledOnce();
});

test("fresh Skill evidence uses the existing Planner compaction lifecycle and reuses its checkpoint", async () => {
  const f = await createKnowledgeSkillsCompactionFixture("execution-agent-v1");
  await f.readSkill();
  const call = await openPlanner(f.ledger);
  const request = plannerRequest(f);
  f.forceCompaction();
  const before = JSON.stringify(f.ledger.current());
  await runPlannerGraph(request, call, f.ledger.current());
  const compactCount = f.invoke.mock.calls.filter(([input]) => input.modelStep === "context.compact").length;
  expect(compactCount).toBeGreaterThan(0);
  const finalInput = f.invoke.mock.calls.filter(([input]) => input.modelStep === "planner.graph").at(-1)![0];
  expect(JSON.stringify(finalInput.messages)).toContain(SKILL_COMPACTION_FACT);
  expect(JSON.stringify(finalInput.messages)).not.toContain(SKILL_COMPACTION_PADDING);
  expect(capsule(finalInput.messages as ChatMessage[], ASSIGNMENT).objective).toBe(objective);
  const checkpoint = request.contextCompactionStore!.findByCallIds([call.callId])[0]!;
  expect(checkpoint).toMatchObject({ callId: call.callId, roleId: "planner" });
  expect(request.contextCompactionStore!.materializeSource(checkpoint.sourceDigests[0]!.sourceRef,
    checkpoint.sourceDigests[0]!.sourceFingerprint)!.content).toContain(SKILL_COMPACTION_PADDING);
  await runPlannerGraph(request, call, f.ledger.current());
  expect(f.invoke.mock.calls.filter(([input]) => input.modelStep === "context.compact")).toHaveLength(compactCount);
  expect(JSON.stringify(f.ledger.current())).toBe(before);
  expect(f.execute).toHaveBeenCalledOnce();
});

test("restored EA digests pass to Planner alongside fresh Skills without importing the EA continuation", async () => {
  const f = await createKnowledgeSkillsCompactionFixture("execution-agent-v1");
  await f.readSkill();
  f.forceCompaction();
  await f.runDecision();
  const freshId = await appendResult(f.ledger, "read_skills");
  await f.parkForApproval();
  const storeSnapshot = captureRequestContextCompaction(f.request.contextCompactionStore!);
  const ledgerSnapshot = captureRoleCallLedgerCheckpoint(f.ledger);
  const store = restoreRequestContextCompaction(JSON.parse(JSON.stringify(storeSnapshot)));
  const ledger = restoreRoleCallLedgerCheckpoint(JSON.parse(JSON.stringify(ledgerSnapshot)), {
    requestId: f.request.requestId, policy: createRequestRoleCallPolicy(f.request.executionPolicy),
  });
  const parked = ledger.current().state.capabilityExecutions.find(({ status }) => status === "running")!;
  await commit(ledger, {
    authority: "runtime", type: "settle_capability_execution", callId: parked.callId,
    executionId: parked.executionId, outcome: "failed", observedEffect: "none", summary: "Fixture write declined.",
    exactResult: { kind: "runtime_capability_rejection_v1", authority: "runtime", status: "rejected",
      stage: "before_external_execution", code: "fixture_declined", message: "Fixture write declined." },
  });
  const call = await openPlanner(ledger);
  const request = deriveTestRequestExecutionScope(f.request, { contextCompactionStore: store });
  const head = ledger.current();
  const before = JSON.stringify(head);
  const input = buildPlannerGraphInput(request, call, head);
  const guidance = capsule(input.context.messages, RESULTS);
  expect(guidance.results[0]).not.toHaveProperty("adapterResult");
  expect(guidance.results[1]).toMatchObject({ executionId: freshId, adapterResult: registeredResult() });
  expect(guidance.compactedSourceEvidence).toMatchObject([{ digest: SKILL_COMPACTION_FACT,
    authority: "passive_reference_only", sourceRef: `tool-result:${guidance.results[0].executionId}` }]);
  expect(JSON.stringify(input.context.messages)).not.toContain(SKILL_COMPACTION_PADDING);
  expect(JSON.stringify(input.context.messages)).not.toContain("Explain the documented procedure.");
  expect(guidance).not.toHaveProperty("semanticCheckpoint");
  expect(JSON.stringify(store.snapshot!())).toBe(JSON.stringify(storeSnapshot));
  expect(JSON.stringify(head)).toBe(before);

  const changedRequest = deriveTestRequestExecutionScope(request, { prompt: "Different current request." });
  const mismatch = capsule(buildPlannerGraphInput(changedRequest, call, head).context.messages, RESULTS);
  expect(mismatch).not.toHaveProperty("compactedSourceEvidence");
  expect(JSON.stringify(mismatch)).toContain(SKILL_COMPACTION_PADDING);

  const runnerRequest = plannerRequest(f);
  const countInputTokens = runnerRequest.modelGatewayClient.countInputTokens!;
  const compactingRequest = deriveTestRequestExecutionScope(runnerRequest, {
    contextCompactionStore: store,
    modelGatewayClient: { ...runnerRequest.modelGatewayClient,
      countInputTokens: async (countInput) => {
        const measured = await countInputTokens(countInput);
        if (!measured) throw new Error("fixture_token_count_missing");
        const evidence = capsule(countInput.messages as ChatMessage[], RESULTS);
        const hasFreshBody = evidence?.results.some((entry: { executionId: string; adapterResult?: unknown }) =>
          entry.executionId === freshId && entry.adapterResult);
        return { ...measured, inputTokens: countInput.modelStep === "planner.graph" && hasFreshBody ? 63_500 : 1_000 };
      },
    },
  });
  await runPlannerGraph(compactingRequest, call, head);
  const plannerInput = f.invoke.mock.calls.filter(([entry]) => entry.modelStep === "planner.graph").at(-1)![0];
  const afterCompaction = capsule(plannerInput.messages as ChatMessage[], RESULTS);
  expect(afterCompaction.compactedSourceEvidence).toEqual(guidance.compactedSourceEvidence);
  expect(afterCompaction.semanticCheckpoint.coveredResults.map((entry: { executionId: string }) => entry.executionId))
    .toEqual([freshId]);
  expect(store.findByCallIds([call.callId])[0]!.sourceDigests.map(({ sourceRef }) => sourceRef)).toEqual([freshId]);
  expect(f.execute).toHaveBeenCalledOnce();
});
