import type { ChatMessage } from "../../model-gateway/types.js";
import { CORE_SKILL_READ_MESSAGE_KIND } from "../context/core-skill-read-context.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { runRequestRunner } from "../request/runner.js";
import { SUPERVISOR_RESPONSE_RECOMMENDATION_KIND } from "../steps/supervisor-response/response-recommendation.js";
import { supervisorFormatName } from "./support/supervisor-model-phases.js";
import {
  createProcedureOrchestrationFixture, procedureCapsules, procedureMessages, type ProcedureModelInput,
  PROCEDURE_CAPABILITIES, PROCEDURE_OLD_HISTORY, PROCEDURE_PROMPT, PROCEDURE_SKILL, PROCEDURE_SOURCE,
} from "./support/supervisor-procedure-orchestration-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { resetDebugLoggerConfig(); vi.restoreAllMocks(); });

const recommendation = "Explain the distinction using the supplied source.";
const objective = "Save the exact preceding summary in report.txt.";
const finalAnswer = "The requested outcome is complete.";

function capturedGuidance(input: ProcedureModelInput): readonly ChatMessage[] {
  const messages = procedureMessages(input).filter(({ content }) => {
    try { return JSON.parse(content).kind === CORE_SKILL_READ_MESSAGE_KIND; }
    catch { return false; }
  });
  expect(messages).toHaveLength(1);
  expect(messages[0]!.role).toBe("user");
  expect(JSON.parse(messages[0]!.content)).toMatchObject({
    kind: CORE_SKILL_READ_MESSAGE_KIND,
    authority: "passive_reference",
    purpose: "skill_guidance",
    requestId: "procedure-orchestration-request",
    read: { callId: "call-1", readId: "skill-read-1", operation: "read_skills", selectors: [PROCEDURE_SKILL.skillId] },
    document: PROCEDURE_SKILL,
  });
  return messages;
}


test("direct routing retains its recommendation after a Skill read and creates no child", async () => {
  let gateGuidance: readonly ChatMessage[] | undefined;
  const f = createProcedureOrchestrationFixture((input) => {
    if (supervisorFormatName(input) === "supervisor_fused_routing") {
      gateGuidance = capturedGuidance(input);
      expect(JSON.stringify(input.messages)).not.toContain(PROCEDURE_OLD_HISTORY);
      return { action: "respond", responseRecommendation: recommendation };
    }
    expect(input.modelStep).toBe("supervisor.response");
    expect(capturedGuidance(input)).toEqual(gateGuidance);
    expect(input.format).toBeUndefined();
    expect(procedureCapsules(input).filter(({ kind }) => kind === SUPERVISOR_RESPONSE_RECOMMENDATION_KIND))
      .toEqual([expect.objectContaining({ responseRecommendation: recommendation, callId: "call-1" })]);
    return finalAnswer;
  }, { skills: true });
  await expect(runRequestRunner(f.request)).resolves.toEqual({ output: finalAnswer });
  expect(f.invoke.mock.calls.map(([input]) => supervisorFormatName(input) ?? input.modelStep)).toEqual([
    "supervisor_fused_entry", "supervisor_fused_routing", "supervisor.response",
  ]);
  expect(f.store.read).toHaveBeenCalledOnce();
  expect(f.getAdapters).not.toHaveBeenCalled();
  expect(JSON.stringify(vi.mocked(f.request.onEvent).mock.calls)).not.toContain('"name":"role.delegated"');
  expect(f.request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(finalAnswer);
});

test("one Skill read reaches fused routing, Worker and the returning Supervisor without extra calls", async () => {
  let routedAfterReturn = false;
  let gateGuidance: readonly ChatMessage[] | undefined;
  const workerCapabilityScope = { catalogGroupIds: ["write"] };
  const f = createProcedureOrchestrationFixture((input) => {
    const phase = supervisorFormatName(input);
    if (phase === "supervisor_fused_routing") {
      gateGuidance = capturedGuidance(input);
      const text = JSON.stringify(input.messages);
      expect(text).not.toContain(PROCEDURE_OLD_HISTORY);
      expect(capturedGuidance(input)).toEqual(gateGuidance);
      expect(text).toContain("runtime_capability_brief");
      for (const capability of PROCEDURE_CAPABILITIES) expect(text).not.toContain(capability.capabilityId);
      expect(procedureMessages(input).filter(({ role, content }) => role === "user" && content === PROCEDURE_PROMPT))
        .toHaveLength(1);
      expect(procedureMessages(input).some(({ content }) => content === PROCEDURE_SOURCE)).toBe(true);
      expect(JSON.stringify(input.format)).toContain("workerCapabilityScope");
      return { action: "invoke_role", roleId: "worker", objective, workerCapabilityScope, workingDirectory: "." };
    }
    if (input.modelStep === "worker.decision") {
      const text = JSON.stringify(input.messages);
      for (const capability of PROCEDURE_CAPABILITIES) {
        if (capability.catalogGroups?.includes("write")) expect(text).toContain(capability.capabilityId);
        else expect(text).not.toContain(capability.capabilityId);
      }
      expect(capturedGuidance(input)).toEqual(gateGuidance);
      expect(procedureCapsules(input).find(({ kind }) => kind === "runtime_request_source_v1"))
        .toMatchObject({ currentRequest: PROCEDURE_PROMPT, precedingTurn: {
          assistant: { id: "prior-assistant", content: PROCEDURE_SOURCE, requestId: "prior" },
        } });
      expect(procedureCapsules(input).find(({ kind }) => kind === "runtime_worker_assignment"))
        .toMatchObject({ objective, workingDirectory: "." });
      return { assessment: { requiresExecution: false, established: "", remaining: "", evidenceRefs: [] }, selection: { action: "return_result" } };
    }
    if (input.modelStep === "worker.result") return "The bounded assignment returned its result.";
    if (phase === "supervisor_decision") {
      expect(routedAfterReturn).toBe(false);
      routedAfterReturn = true;
      expect(capturedGuidance(input)).toEqual(gateGuidance);
      const child = procedureCapsules(input).find(({ kind }) => kind === "runtime_child_result");
      expect(child).toMatchObject({ roleId: "worker", outcome: "completed" });
      expect(child).not.toHaveProperty("workerCapabilityScope");
      return { action: "respond" };
    }
    expect(input.modelStep).toBe("supervisor.response");
    expect(routedAfterReturn).toBe(true);
    expect(capturedGuidance(input)).toEqual(gateGuidance);
    return finalAnswer;
  }, { skills: true });
  await expect(runRequestRunner(f.request)).resolves.toEqual({ output: finalAnswer });
  expect(f.invoke.mock.calls.map(([input]) => supervisorFormatName(input) ?? input.modelStep)).toEqual([
    "supervisor_fused_entry", "supervisor_fused_routing", "worker.decision", "worker.result", "supervisor_decision", "supervisor.response",
  ]);
  expect(f.store.read).toHaveBeenCalledOnce();
});

test.each(["entry", "routing"] as const)("steering during fused %s discards the stale procedure before child dispatch", async (checkpoint) => {
  const updated = "Answer only the new question; do not perform the earlier assignment.";
  let gates = 0;
  let delegations = 0;
  const f = createProcedureOrchestrationFixture((input) => {
    const phase = supervisorFormatName(input);
    if (phase === "supervisor_fused_entry") {
      if (++gates === 1) {
        if (checkpoint === "entry")
          expect(f.requestSteering.append({ steerId: "supersede-gate", text: updated }).ok).toBe(true);
        return { requiresProcedure: true };
      }
      expect(gates).toBe(2);
      expect(JSON.stringify(input.messages)).toContain(updated);
      return { requiresProcedure: false, responseRecommendation: recommendation };
    }
    if (phase === "supervisor_fused_routing") {
      expect(checkpoint).toBe("routing");
      if (++delegations === 1) {
        expect(f.requestSteering.append({ steerId: "supersede-delegation", text: updated }).ok).toBe(true);
        return { action: "invoke_role", roleId: "worker", objective: "STALE_PROCEDURE_OBJECTIVE", workerCapabilityScope: { catalogGroupIds: ["write"] }, workingDirectory: "." };
      }
      expect(delegations).toBe(2);
      expect(JSON.stringify(input.messages)).toContain(updated);
      return { action: "respond", responseRecommendation: recommendation, acknowledgement: "I will answer the updated request." };
    }
    expect(input.modelStep).toBe("supervisor.response");
    expect(JSON.stringify(input.messages)).toContain(updated);
    expect(JSON.stringify(input.messages)).not.toContain("STALE_PROCEDURE_OBJECTIVE");
    return finalAnswer;
  });
  await expect(runRequestRunner(f.request)).resolves.toEqual({ output: finalAnswer });
  expect(gates).toBe(checkpoint === "entry" ? 2 : 1);
  expect(delegations).toBe(checkpoint === "routing" ? 2 : 0);
  expect(f.invoke.mock.calls.some(([input]) => input.modelStep === "worker.decision")).toBe(false);
  expect(JSON.stringify(vi.mocked(f.request.onEvent).mock.calls)).not.toContain('"name":"role.delegated"');
  expect(f.request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(finalAnswer);
});
