import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { projectRequestToolResults } from "../context/request-tool-results.js";
import { ModelStepSteeringSupersededError } from "../model/model-step-steering.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createRoleCallLedger } from "../orchestration/role-calls/index.js";
import { createRequestExecutionScope } from "../request/execution-scope.js";
import { createRequestRoleCallPolicy } from "../request/role-call-policy.js";
import { projectSupervisorCallIdentity } from "../steps/supervisor-decision/ledger-projection.js";
import { runSupervisorDecision } from "../steps/supervisor-decision/run.js";
import { createMemoryRecallHarness, MEMORY_RECORD, RECALL_QUERY, recallCapsules } from "./support/memory-recall-runner.js";
import { defaultSupervisorPresentation, supervisorFormatName } from "./support/supervisor-model-phases.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { resetDebugLoggerConfig(); vi.restoreAllMocks(); });

test.each([
  ["found", "presentation"], ["found", "skill_selection"],
  ["superseded", "presentation"], ["superseded", "skill_selection"],
] as const)("canonical %s recall without an incoming capsule binds %s to its entry intent", async (outcome, stage) => {
  let hasSteered = false;
  const nextQuery = "the updated preference";
  const classifyProcedure = vi.fn(() => ({ requiresProcedure: true }));
  const delegate = vi.fn((input: Parameters<typeof recallCapsules>[0]) => {
    expect(JSON.stringify(input.format)).toContain('"recall_memory"');
    expect(recallCapsules(input)).toEqual([]);
    expect(JSON.stringify(input.messages)).not.toContain(MEMORY_RECORD.content);
    return { action: "recall_memory", query: nextQuery };
  });
  function steer() {
    if (hasSteered) return;
    hasSteered = true;
    expect(f.requestSteering.append({ steerId: "preparation-steer", text: "Recall the updated preference instead." }).ok).toBe(true);
  }
  const f = createMemoryRecallHarness({
    policy: "supervisor-worker-v1", memoryRecallLimit: 2,
    present(input) { if (stage === "presentation") steer(); return defaultSupervisorPresentation(input); },
    selectSkills() { if (stage === "skill_selection") steer(); return { action: "continue" }; },
    classifyProcedure, delegate,
    decide: () => { throw new Error("Unexpected legacy routing or child"); },
  });
  const skill = { skillId: "fixture-guide", name: "Fixture guide", description: "Guidance for this request.", content: "Keep the task bounded." };
  const request = createRequestExecutionScope({
    seed: f.request, executionPolicy: f.request.executionPolicy,
    knowledgeSkillStore: { list: () => [skill], read: () => skill },
    createWorkerCapabilities: () => f.request.workerCapabilities.provider,
  });
  const ledger = createRoleCallLedger({
    requestId: request.requestId, policy: createRequestRoleCallPolicy(request.executionPolicy),
  });
  const root = await ledger.apply({ expectedHead: ledger.current(), command: { authority: "runtime", type: "create_root" } });
  expect(root.ok).toBe(true);
  const identity = projectSupervisorCallIdentity(ledger.current());
  const begun = await ledger.transactions!.beginMemoryRecall({
    expectedHead: ledger.current(), callId: identity.callId,
    invocationAttempt: identity.invocationAttempt, steeringVersion: 0, query: RECALL_QUERY,
  });
  if (!begun.ok) throw new Error(begun.issueCode);
  const settled = await ledger.transactions!.settleMemoryRecall({
    expectedHead: ledger.current(), callId: identity.callId,
    invocationAttempt: identity.invocationAttempt, steeringVersion: 0, recallId: begun.commit.effect.recallId,
    result: { outcome, records: outcome === "found" ? [MEMORY_RECORD] : [], omittedRecordCount: 0 },
  });
  if (!settled.ok) throw new Error(settled.issueCode);
  const head = ledger.current();
  const call = projectSupervisorCallIdentity(head);
  const options = {
    call, skillReadHead: head, memoryRecallCount: head.state.memoryRecalls.length,
    toolResults: projectRequestToolResults({ ledger, head, callId: call.callId, modelStep: "supervisor.decision" }),
    includeAcknowledgement: stage === "presentation", allowSkillReads: stage === "skill_selection",
  };
  expect(options).not.toHaveProperty("memoryRecallMessage");
  const decision = runSupervisorDecision(request, options);
  await expect(decision).rejects.toBeInstanceOf(ModelStepSteeringSupersededError);
  await expect(decision).rejects.toMatchObject({ boundSteeringVersion: 0 });
  expect(classifyProcedure).not.toHaveBeenCalled();
  expect(delegate).not.toHaveBeenCalled();
  expect(f.gatewayInvoke.mock.calls.map(([input]) => supervisorFormatName(input))).toEqual([
    stage === "presentation" ? "supervisor_presentation" : "supervisor_skill_selection",
  ]);
  expect(ledger.current()).toBe(head);

  // Only a new root decision invocation may project the new intent's allowance.
  await expect(runSupervisorDecision(request, options)).resolves.toMatchObject({
    decision: { action: "recall_memory", query: nextQuery }, steeringVersion: 1,
  });
  expect(classifyProcedure).toHaveBeenCalledOnce();
  expect(delegate).toHaveBeenCalledOnce();
  expect(f.memory.retrieve).not.toHaveBeenCalled();
  expect(ledger.current()).toBe(head);
});
