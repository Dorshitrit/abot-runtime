import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { runRequestRunner } from "../request/runner.js";
import { SUPERVISOR_RESPONSE_RECOMMENDATION_KIND } from "../steps/supervisor-response/response-recommendation.js";
import { supervisorFormatName } from "./support/supervisor-model-phases.js";
import {
  createProcedureOrchestrationFixture, procedureCapsules, procedureMessages,
  PROCEDURE_CAPABILITIES, PROCEDURE_OLD_HISTORY, PROCEDURE_PROMPT, PROCEDURE_SKILL, PROCEDURE_SOURCE,
} from "./support/supervisor-procedure-orchestration-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { resetDebugLoggerConfig(); vi.restoreAllMocks(); });

const recommendation = "Explain the distinction using the supplied source.";
const objective = "Save the exact preceding summary in report.txt.";
const finalAnswer = "The requested outcome is complete.";

test("a false procedure gate retains its recommendation after a Skill read and creates no child", async () => {
  const f = createProcedureOrchestrationFixture((input) => {
    if (supervisorFormatName(input) === "supervisor_procedure_gate")
      return { requiresProcedure: false, responseRecommendation: recommendation };
    expect(input.modelStep).toBe("supervisor.response");
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

test("unscoped delegation minimizes its context and preserves exact source plus all authorized capabilities for Worker", async () => {
  let routedAfterReturn = false;
  const f = createProcedureOrchestrationFixture((input) => {
    const phase = supervisorFormatName(input);
    if (phase === "supervisor_procedure_gate") return { requiresProcedure: true };
    if (phase === "supervisor_delegation") {
      const text = JSON.stringify(input.messages);
      expect(text).not.toContain(PROCEDURE_OLD_HISTORY);
      expect(text).not.toContain(PROCEDURE_SKILL.content);
      expect(text).not.toContain("runtime_core_skill_read_v1");
      expect(text).not.toContain("runtime_capability_brief");
      for (const capability of PROCEDURE_CAPABILITIES) expect(text).not.toContain(capability.capabilityId);
      expect(procedureMessages(input).filter(({ role, content }) => role === "user" && content === PROCEDURE_PROMPT))
        .toHaveLength(1);
      expect(procedureMessages(input).some(({ content }) => content === PROCEDURE_SOURCE)).toBe(true);
      expect(JSON.stringify(input.format)).not.toContain("workerCapabilityScope");
      return { action: "invoke_role", roleId: "worker", objective };
    }
    if (phase === "supervisor_working_directory") return JSON.stringify({ workingDirectory: "." });
    if (input.modelStep === "worker.decision") {
      const text = JSON.stringify(input.messages);
      for (const capability of PROCEDURE_CAPABILITIES) expect(text).toContain(capability.capabilityId);
      expect(text).toContain(PROCEDURE_SKILL.content);
      expect(procedureCapsules(input).find(({ kind }) => kind === "runtime_request_source_v1"))
        .toMatchObject({ currentRequest: PROCEDURE_PROMPT, precedingTurn: {
          assistant: { id: "prior-assistant", content: PROCEDURE_SOURCE, requestId: "prior" },
        } });
      expect(procedureCapsules(input).find(({ kind }) => kind === "runtime_worker_assignment"))
        .toMatchObject({ objective });
      return { action: "return_result" };
    }
    if (input.modelStep === "worker.result") return "The bounded assignment returned its result.";
    if (phase === "supervisor_decision") {
      expect(routedAfterReturn).toBe(false);
      routedAfterReturn = true;
      const child = procedureCapsules(input).find(({ kind }) => kind === "runtime_child_result");
      expect(child).toMatchObject({ roleId: "worker", outcome: "completed" });
      expect(child).not.toHaveProperty("workerCapabilityScope");
      return { action: "respond" };
    }
    expect(input.modelStep).toBe("supervisor.response");
    expect(routedAfterReturn).toBe(true);
    return finalAnswer;
  }, { skills: true });
  await expect(runRequestRunner(f.request)).resolves.toEqual({ output: finalAnswer });
  expect(f.invoke.mock.calls.map(([input]) => supervisorFormatName(input) ?? input.modelStep)).toEqual([
    "supervisor_presentation", "supervisor_skill_selection", "supervisor_procedure_gate", "supervisor_delegation",
    "supervisor_working_directory", "worker.decision", "worker.result", "supervisor_decision", "supervisor.response",
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
  expect(f.invoke.mock.calls.some(([input]) => input.modelStep === "worker.decision")).toBe(false);
  expect(JSON.stringify(vi.mocked(f.request.onEvent).mock.calls)).not.toContain('"name":"role.delegated"');
  expect(f.request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(finalAnswer);
});
