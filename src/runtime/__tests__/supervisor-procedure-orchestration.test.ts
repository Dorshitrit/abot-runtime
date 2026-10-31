import type { ChatMessage } from "../../model-gateway/types.js";
import { CORE_SKILL_READ_MESSAGE_KIND } from "../context/core-skill-read-context.js";
import { workerEvidenceDecision } from "./support/worker-evidence-script.js";
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


test("a false procedure gate retains its recommendation after a Skill read and creates no child", async () => {
  let gateGuidance: readonly ChatMessage[] | undefined;
  const f = createProcedureOrchestrationFixture((input) => {
    if (supervisorFormatName(input) === "supervisor_procedure_gate") {
      gateGuidance = capturedGuidance(input);
      expect(JSON.stringify(input.messages)).not.toContain(PROCEDURE_OLD_HISTORY);
      return { requiresProcedure: false, responseRecommendation: recommendation };
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
    "supervisor_presentation", "supervisor_skill_selection", "supervisor_procedure_gate", "supervisor.response",
  ]);
  expect(f.store.read).toHaveBeenCalledOnce();
  expect(f.getAdapters).not.toHaveBeenCalled();
  expect(JSON.stringify(vi.mocked(f.request.onEvent).mock.calls)).not.toContain('"name":"role.delegated"');
  expect(f.request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(finalAnswer);
});

test("one Skill read reaches gate, delegation, Worker and the returning Supervisor without extra calls", async () => {
  let routedAfterReturn = false;
  let gateGuidance: readonly ChatMessage[] | undefined;
  const f = createProcedureOrchestrationFixture((input) => {
    const phase = supervisorFormatName(input);
    if (phase === "supervisor_procedure_gate") {
      gateGuidance = capturedGuidance(input);
      expect(JSON.stringify(input.messages)).not.toContain(PROCEDURE_OLD_HISTORY);
      return { requiresProcedure: true };
    }
    if (phase === "supervisor_delegation") {
      const text = JSON.stringify(input.messages);
      expect(text).not.toContain(PROCEDURE_OLD_HISTORY);
      expect(capturedGuidance(input)).toEqual(gateGuidance);
      expect(text).not.toContain("runtime_capability_brief");
      for (const capability of PROCEDURE_CAPABILITIES) expect(text).not.toContain(capability.capabilityId);
      expect(procedureMessages(input).filter(({ role, content }) => role === "user" && content === PROCEDURE_PROMPT))
        .toHaveLength(1);
      expect(procedureMessages(input).some(({ content }) => content === PROCEDURE_SOURCE)).toBe(true);
      expect(JSON.stringify(input.format)).not.toContain("workerCapabilityScope");
      return { action: "invoke_role", roleId: "worker", objective };
    }
    if (phase === "supervisor_working_directory") return JSON.stringify({ workingDirectory: "." });
    if (input.modelStep === "worker.evidence") {
      const text = JSON.stringify(input.messages);
      for (const capability of PROCEDURE_CAPABILITIES) expect(text).toContain(capability.capabilityId);
      expect(capturedGuidance(input)).toEqual(gateGuidance);
      expect(procedureCapsules(input).find(({ kind }) => kind === "runtime_request_source_v1"))
        .toMatchObject({ currentRequest: PROCEDURE_PROMPT, precedingTurn: {
          assistant: { id: "prior-assistant", content: PROCEDURE_SOURCE, requestId: "prior" },
        } });
      expect(procedureCapsules(input).find(({ kind }) => kind === "runtime_worker_assignment"))
        .toMatchObject({ objective });
      return workerEvidenceDecision(input, false);
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
    "supervisor_presentation", "supervisor_skill_selection", "supervisor_procedure_gate", "supervisor_delegation",
    "supervisor_working_directory", "worker.evidence", "worker.result", "supervisor_decision", "supervisor.response",
  ]);
  expect(f.store.read).toHaveBeenCalledOnce();
});

test.each(["gate", "delegation"] as const)("steering during %s discards the stale procedure before child dispatch", async (checkpoint) => {
  const updated = "Answer only the new question; do not perform the earlier assignment.";
  let gates = 0;
  let delegations = 0;
  const f = createProcedureOrchestrationFixture((input) => {
    const phase = supervisorFormatName(input);
    if (phase === "supervisor_procedure_gate") {
      if (++gates === 1) {
        if (checkpoint === "gate")
          expect(f.requestSteering.append({ steerId: "supersede-gate", text: updated }).ok).toBe(true);
        return { requiresProcedure: true };
      }
      expect(gates).toBe(2);
      expect(JSON.stringify(input.messages)).toContain(updated);
      return { requiresProcedure: false, responseRecommendation: recommendation };
    }
    if (phase === "supervisor_delegation") {
      expect(checkpoint).toBe("delegation");
      expect(++delegations).toBe(1);
      expect(f.requestSteering.append({ steerId: "supersede-delegation", text: updated }).ok).toBe(true);
      return { action: "invoke_role", roleId: "worker", objective: "STALE_PROCEDURE_OBJECTIVE" };
    }
    expect(input.modelStep).toBe("supervisor.response");
    expect(JSON.stringify(input.messages)).toContain(updated);
    expect(JSON.stringify(input.messages)).not.toContain("STALE_PROCEDURE_OBJECTIVE");
    return finalAnswer;
  });
  await expect(runRequestRunner(f.request)).resolves.toEqual({ output: finalAnswer });
  expect(gates).toBe(2);
  expect(delegations).toBe(checkpoint === "delegation" ? 1 : 0);
  expect(f.invoke.mock.calls.some(([input]) => input.modelStep === "worker.evidence")).toBe(false);
  expect(JSON.stringify(vi.mocked(f.request.onEvent).mock.calls)).not.toContain('"name":"role.delegated"');
  expect(f.request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(finalAnswer);
});
