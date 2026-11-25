import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resolveModelInvocation } from "../../model-gateway/invocation-policy.js";
import { createKnowledgeSkillStore } from "../knowledge-skills/store.js";
import { validateJsonSchemaValue } from "../model/json-schema-value.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import { createRequestExecutionScope } from "../request/execution-scope.js";
import { runRequestRunner } from "../request/runner.js";
import { createSupervisorDecisionFormat } from "../steps/supervisor-decision/format.js";
import { createSupervisorMemoryRoutingFormat, parseSupervisorMemoryRoutingOutput } from "../steps/supervisor-decision/memory-fusion.js";
import { parseSupervisorDecisionOutput } from "../steps/supervisor-decision/parser.js";
import { createSupervisorResumeSkillRoutingFormat, parseSupervisorResumeSkillRead } from "../steps/supervisor-decision/resume-skill-routing.js";
import {
  CHILD_FACT, createSupervisorMemoryFusionFixture, isAfterChildRouting,
  MEMORY_KNOWLEDGE, MEMORY_PROPOSAL, memoryFusionCapsules, memoryFusionFormat,
  RAW_ANSWER, type MemoryFusionInput,
} from "./support/supervisor-memory-fusion-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

const GUIDE = {
  skillId: "comparison-response", name: "Comparison response", description: "Present the completed cobalt comparison.",
  content: "CAPTURED_RESPONSE_GUIDANCE: explain the observed cobalt fact without inventing further work.",
};
const CORE_SKILL_KIND = "runtime_core_skill_read_v1";
const MEMORY_FORMAT = "supervisor_decision_with_memory_candidates";

function offersResumeSkillRead(input: MemoryFusionInput): boolean {
  return isAfterChildRouting(input) && JSON.stringify(input.format).includes('"read_skills"');
}

function createResumeFixture(selectRead = false) {
  const f = createSupervisorMemoryFusionFixture();
  const source = createKnowledgeSkillStore([GUIDE]);
  const store = { ...source, read: vi.fn(source.read) };
  const original = f.invoke.getMockImplementation()!;
  f.invoke.mockImplementation(async input => {
    if (memoryFusionFormat(input) === "supervisor_skill_selection")
      return { text: JSON.stringify({ decision: { action: "continue" } }), meta: {} };
    if (!isAfterChildRouting(input)) return original(input);
    if (offersResumeSkillRead(input)) {
      expect(store.read).not.toHaveBeenCalled();
      expect(JSON.stringify(input.messages)).not.toContain(GUIDE.content);
      expect(memoryFusionCapsules(input, "runtime_child_result")).toMatchObject([{ summary: CHILD_FACT }]);
      if (selectRead) return { text: JSON.stringify({ decision: {
        action: "read_skills", skillIds: [GUIDE.skillId],
      } }), meta: {} };
    }
    if (selectRead) {
      expect(store.read).toHaveBeenCalledExactlyOnceWith(GUIDE.skillId);
      expect(memoryFusionCapsules(input, CORE_SKILL_KIND)).toMatchObject([{
        authority: "passive_reference", purpose: "skill_guidance", document: GUIDE,
      }]);
    }
    return { text: JSON.stringify({ decision: {
      action: "respond", memoryCandidates: [MEMORY_PROPOSAL],
    } }), meta: {} };
  });
  const request = createRequestExecutionScope({
    seed: f.request, executionPolicy: f.request.executionPolicy, knowledgeSkillStore: store,
    createWorkerCapabilities: () => f.request.workerCapabilities.provider,
  });
  const calls = () => f.invoke.mock.calls.map(([input]) => input);
  const postChildCalls = () => {
    const inputs = calls();
    return inputs.slice(inputs.findIndex(input => input.modelStep === "worker.result") + 1);
  };
  return { ...f, request, store, calls, postChildCalls };
}

test("an unread eligible Skill needs no separate selection when returned evidence supports respond", async () => {
  const f = createResumeFixture();
  const result = await runRequestRunner(f.request);
  expect(result.output).toBe(RAW_ANSWER);
  expect(f.postChildCalls().map(input => memoryFusionFormat(input) ?? input.modelStep))
    .toEqual([MEMORY_FORMAT, "supervisor.response"]);
  expect(offersResumeSkillRead(f.postChildCalls()[0]!)).toBe(true);
  expect(f.postChildCalls()[1]).not.toHaveProperty("format");
  expect(f.store.read).not.toHaveBeenCalled();
  expect(f.prepare).toHaveBeenCalledTimes(2);
  expect(result.memoryCandidates).toMatchObject([{
    content: MEMORY_PROPOSAL.content, assessment: { target: MEMORY_KNOWLEDGE.entries[0] },
  }]);
  expect(f.calls().some(input => memoryFusionFormat(input) === "supervisor_memory_candidates")).toBe(false);
});

test("a resume Skill choice performs its canonical read before routing and cannot reopen the same window", async () => {
  const f = createResumeFixture(true);
  const result = await runRequestRunner(f.request);
  expect(result.output).toBe(RAW_ANSWER);
  const inputs = f.postChildCalls();
  expect(inputs.map(input => memoryFusionFormat(input) ?? input.modelStep))
    .toEqual([MEMORY_FORMAT, MEMORY_FORMAT, "supervisor.response"]);
  expect(inputs.filter(offersResumeSkillRead)).toHaveLength(1);
  expect(f.store.read).toHaveBeenCalledExactlyOnceWith(GUIDE.skillId);
  expect(memoryFusionCapsules(inputs[1]!, CORE_SKILL_KIND)).toMatchObject([{
    read: { operation: "read_skills", selectors: [GUIDE.skillId], readId: "skill-read-1" }, document: GUIDE,
  }]);
  expect(memoryFusionCapsules(inputs[2]!, CORE_SKILL_KIND)).toMatchObject([{ document: GUIDE }]);
  expect(result.memoryCandidates).toHaveLength(1);
});

test("measured union pressure keeps the old selection and routing path before dispatch", async () => {
  const f = createResumeFixture();
  const countInputTokens = vi.fn<NonNullable<ModelGatewayClient["countInputTokens"]>>(async input => {
    const invocation = resolveModelInvocation(input);
    return { inputTokens: offersResumeSkillRead(input) ? 25_000 : 1_000,
      profileId: invocation.profile.id, provider: invocation.profile.provider, model: invocation.model,
      contextWindowTokens: invocation.profile.contextWindowTokens, source: "provider_input_token_count" };
  });
  const request = createRequestExecutionScope({
    seed: { ...f.request, modelGatewayClient: { ...f.request.modelGatewayClient, countInputTokens } },
    executionPolicy: f.request.executionPolicy, knowledgeSkillStore: f.store,
    createWorkerCapabilities: () => f.request.workerCapabilities.provider,
  });
  expect((await runRequestRunner(request)).output).toBe(RAW_ANSWER);
  expect(countInputTokens.mock.calls.some(([input]) => offersResumeSkillRead(input))).toBe(true);
  expect(f.calls().some(offersResumeSkillRead)).toBe(false);
  expect(f.postChildCalls().map(input => memoryFusionFormat(input) ?? input.modelStep))
    .toEqual(["supervisor_skill_selection", MEMORY_FORMAT, "supervisor.response"]);
  expect(f.store.read).not.toHaveBeenCalled();
});

test.each([
  { action: "invoke_role", roleId: "reviewer" },
  { action: "author_skill" },
  { action: "recall_memory", query: "saved response preference" },
])("resume and memory schema composition retains the complete $action routing contract", decision => {
  const options = { allowSkillAuthoring: true, allowMemoryRecall: true };
  const base = createSupervisorDecisionFormat(options);
  const original = structuredClone(base);
  const union = createSupervisorResumeSkillRoutingFormat(base, [GUIDE.skillId]);
  const format = createSupervisorMemoryRoutingFormat(union);
  expect(base).toEqual(original);
  expect(validateJsonSchemaValue(format, { decision })).toBeUndefined();
  const text = JSON.stringify({ decision });
  expect(parseSupervisorResumeSkillRead(text, [GUIDE.skillId])).toBeUndefined();
  expect(parseSupervisorMemoryRoutingOutput(text, value => parseSupervisorDecisionOutput(value, options)))
    .toEqual({ ok: true, decision: { decision } });
  const read = { action: "read_skills", skillIds: [GUIDE.skillId] };
  expect(validateJsonSchemaValue(format, { decision: read })).toBeUndefined();
  expect(parseSupervisorResumeSkillRead(JSON.stringify({ decision: read }), [GUIDE.skillId]))
    .toMatchObject({ ok: true, decision: read });
  expect(validateJsonSchemaValue(format, { decision: { ...read, memoryCandidates: [] } })).toBeDefined();
});
