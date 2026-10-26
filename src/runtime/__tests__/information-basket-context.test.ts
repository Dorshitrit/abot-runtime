import type { ChatMessage } from "../../model-gateway/types.js";
import { afterEach, beforeEach, expect, test } from "vitest";
import { projectOllamaFormat, toOpenAIResponsesTextFormat } from "../../model-gateway/structured-output.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { INFORMATION_BASKET_CANDIDATES_KIND, projectInformationBasketCandidates } from "../information-basket/candidate-context.js";
import type { RequestBasketCandidates } from "../information-basket/request-candidates.js";
import { createRequestExecutionScope } from "../request/execution-scope.js";
import { buildExecutionAgentInput } from "../steps/execution-agent/input.js";
import { buildExecutionAgentResponseInput } from "../steps/execution-agent/response-input.js";
import { createSupervisorDecisionFormat } from "../steps/supervisor-decision/format.js";
import { createSupervisorDelegationFormat } from "../steps/supervisor-decision/delegation-contract.js";
import { parseSupervisorDecisionOutput } from "../steps/supervisor-decision/parser.js";
import { runSupervisorDecision } from "../steps/supervisor-decision/run.js";
import { projectRequestToolResults } from "../context/request-tool-results.js";
import { createRoleCallLedger } from "../orchestration/role-calls/index.js";
import { createRequestRoleCallPolicy } from "../request/role-call-policy.js";
import { createKnowledgeSkillsCompactionFixture, activeSkillCall } from "./support/knowledge-skills-compaction-fixture.js";
import { createProcedureOrchestrationFixture } from "./support/supervisor-procedure-orchestration-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

const sourceId = "basket-a8c4c17f-5e8a-4af9-8ee4-cd89b137f497";
const candidate: RequestBasketCandidates = {
  requestId: "request", steeringVersion: 0, discoveryRevision: 1,
  result: { status: "found", omittedCount: 0, sources: [{
    sourceId, expectedRevision: 7, displayName: "UNTRUSTED_DOCUMENT_NAME", path: "/registered/plan.md", score: 0.9,
    matches: [{ chunkId: "chunk-4", startChar: 6400, endChar: 8200 }], excerpt: "BODY_MUST_NOT_BE_PROJECTED",
  }] },
};

test("EA receives bounded source cards with exact relevant offsets only at its decision", async () => {
  const f = await createKnowledgeSkillsCompactionFixture("execution-agent-v1");
  const request = createRequestExecutionScope({
    seed: f.request, executionPolicy: f.request.executionPolicy,
    createWorkerCapabilities: () => ({ ...f.request.workerCapabilities.provider,
      getInformationBasketCandidates: () => ({ ...candidate, requestId: f.request.requestId }) }),
  });
  const options = { head: f.ledger.current(), call: activeSkillCall(f.ledger), steeringSnapshot: { version: 0, updates: [] },
    includeAcknowledgement: false, includeTitle: false, allowPlanner: false, allowAuditor: false };
  const baseline = buildExecutionAgentInput(f.request, options);
  const projected = buildExecutionAgentInput(request, options);
  const capsule = projected.messages.find(({ content }) => content.includes(INFORMATION_BASKET_CANDIDATES_KIND))!;
  expect(capsule.role).toBe("assistant");
  expect(JSON.parse(capsule.content).sources).toEqual([{
    sourceId, expectedRevision: 7, displayName: "UNTRUSTED_DOCUMENT_NAME", path: "/registered/plan.md", score: 0.9,
    match: { chunkId: "chunk-4", startChar: 6400, endChar: 8200 },
  }]);
  expect(capsule.content).not.toContain("BODY_MUST_NOT_BE_PROJECTED");
  expect(projected.basketCandidates!.remove(structuredClone(projected.messages))).toEqual(baseline.messages);
  expect(projected.context.selectedHistoryMessageIds).toEqual(baseline.context.selectedHistoryMessageIds);
  expect(projected.context.omittedHistoryMessageIds).toEqual(baseline.context.omittedHistoryMessageIds);
  expect(buildExecutionAgentResponseInput(request, options).messages)
    .toEqual(buildExecutionAgentResponseInput(f.request, options).messages);
  expect(f.ledger.current().state).not.toHaveProperty("basketReferences");
});

test("insufficient budget and empty source batches do not alter mandatory context", () => {
  const context = {
    instructions: "System", prompt: "Explicit exact user target", historyMessages: [], referenceMessages: [],
    budget: { contextWindowTokens: 64, outputReserveTokens: 16, safetyReserveTokens: 8, attachmentReserveTokens: 0 },
  };
  expect(projectInformationBasketCandidates({ snapshot: candidate, context })).toBeUndefined();
  expect(projectInformationBasketCandidates({ snapshot: { ...candidate,
    result: { status: "empty", sources: [], omittedCount: 0 } }, context })).toBeUndefined();
});

test("SUPER ignores candidate providers and keeps ordinary procedure routing", async () => {
  const f = createProcedureOrchestrationFixture((input) => {
    const name = typeof input.format === "object" ? input.format?.name : undefined;
    if (name === "supervisor_procedure_gate") return { requiresProcedure: true };
    if (name === "supervisor_working_directory") return JSON.stringify({ workingDirectory: "." });
    return { action: "invoke_role", roleId: "worker", objective: "Perform the explicit task." };
  });
  const request = createRequestExecutionScope({
    seed: f.request, executionPolicy: f.request.executionPolicy,
    createWorkerCapabilities: () => ({ ...f.request.workerCapabilities.provider,
      getInformationBasketCandidates: () => ({ ...candidate, requestId: f.request.requestId }) }),
  });
  const ledger = createRoleCallLedger({ requestId: request.requestId, policy: createRequestRoleCallPolicy(request.executionPolicy) });
  await ledger.apply({ expectedHead: ledger.current(), command: { authority: "runtime", type: "create_root" } });
  const head = ledger.current(), call = head.state.calls[0]!;
  const result = await runSupervisorDecision(request, {
    call: { rootCallId: call.callId, callId: call.callId, parentCallId: null, depth: call.depth, invocationAttempt: call.activationCount },
    toolResults: projectRequestToolResults({ ledger, head, callId: call.callId, modelStep: "supervisor.decision" }),
    skillReadHead: head, includeAcknowledgement: false, includeTitle: false,
  });
  expect(result.decision.action).toBe("invoke_role");
  const inputs = f.invoke.mock.calls.map(([input]) => input);
  expect(inputs.some(input => typeof input.format === "object" && input.format?.name === "supervisor_basket_selection")).toBe(false);
  expect(JSON.stringify(inputs.map(input => ({ messages: input.messages, format: input.format }))))
    .not.toMatch(/runtime_information_basket|UNTRUSTED_DOCUMENT_NAME|read_information_source|search_information_sources/);
  expect(f.requestSteering.snapshot()).toEqual({ version: 0, updates: [] });
});

test.each([false, true])("restored SUPER schemas remain provider-compatible with memory recall=%s", (allowMemoryRecall) => {
  for (const format of [
    createSupervisorDecisionFormat({ allowMemoryRecall, includeAcknowledgement: true, includeTitle: true }),
    createSupervisorDelegationFormat({ allowMemoryRecall }),
  ]) {
    expect(() => projectOllamaFormat(format)).not.toThrow();
    expect(() => toOpenAIResponsesTextFormat(format)).not.toThrow();
  }
});

test.each([
  { action: "read_information_source", sourceId, expectedRevision: 0, startChar: 0, maxChars: 100 },
  { action: "read_information_source", sourceId: "/arbitrary/file", expectedRevision: 1, startChar: 0, maxChars: 100 },
  { action: "read_information_source", sourceId, expectedRevision: 1, startChar: 0, maxChars: 24001 },
  { action: "search_information_sources", query: "x".repeat(4097) },
])("provider-bypassed malformed basket action is rejected: $action", (decision) => {
  expect(parseSupervisorDecisionOutput(JSON.stringify({ decision })).ok).toBe(false);
});
