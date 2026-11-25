import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createRequestExecutionScope } from "../request/execution-scope.js";
import { runRequestRunner } from "../request/runner.js";
import { parseFusedSupervisorRouting } from "../steps/supervisor-decision/fused-contracts.js";
import { createMemoryRecallHarness, FINAL_RESPONSE } from "./support/memory-recall-runner.js";
import { supervisorFormatName } from "./support/supervisor-model-phases.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { resetDebugLoggerConfig(); vi.restoreAllMocks(); });

const skill = { skillId: "guidance", name: "Guidance", description: "Explain the requested convention.", content: "ACTUAL_READ_CONTENT: use the supplied convention." };

test("greeting fuses memory into the initial decision and keeps RAW separate", async () => {
  const f = createMemoryRecallHarness({
    policy: "supervisor-worker-v1",
    retrieve: async () => ({ available: true, records: [] }),
    decide(input) {
      expect(supervisorFormatName(input)).toBe("supervisor_fused_entry_with_memory_candidates");
      expect(JSON.stringify(input.messages)).toContain(skill.skillId);
      expect(JSON.stringify(input.messages)).not.toContain("runtime_capability_brief_v1");
      return { requiresProcedure: false, responseRecommendation: "Greet the user.", acknowledgement: "Hello there.", memoryCandidates: [] };
    },
  });
  const store = { list: vi.fn(() => [skill]), read: vi.fn(() => skill) };
  const request = createRequestExecutionScope({
    seed: { ...f.request, prompt: "Hello" },
    executionPolicy: f.request.executionPolicy, knowledgeSkillStore: store,
    createWorkerCapabilities: () => f.request.workerCapabilities.provider,
  });
  await expect(runRequestRunner(request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(f.gatewayInvoke.mock.calls.map(([input]) => supervisorFormatName(input) ?? input.modelStep))
    .toEqual(["supervisor_fused_entry_with_memory_candidates", "supervisor.response"]);
  expect(store.read).not.toHaveBeenCalled();
});

test("executes the actual Skill read before offering combined routing", async () => {
  const store = { list: vi.fn(() => [skill]), read: vi.fn(() => skill) };
  const f = createMemoryRecallHarness({
    policy: "supervisor-worker-v1", enabled: false,
    decide(input) {
      if (supervisorFormatName(input) === "supervisor_fused_entry") {
        expect(store.read).not.toHaveBeenCalled();
        expect(JSON.stringify(input.messages)).not.toContain(skill.content);
        return { action: "read_skills", skillIds: [skill.skillId], acknowledgement: "I will read the guidance." };
      }
      expect(supervisorFormatName(input)).toBe("supervisor_fused_routing");
      expect(store.read).toHaveBeenCalledOnce();
      expect(JSON.stringify(input.messages)).toContain(skill.content);
      return { action: "respond", responseRecommendation: "Explain the supplied convention." };
    },
  });
  const request = createRequestExecutionScope({
    seed: f.request,
    executionPolicy: f.request.executionPolicy, knowledgeSkillStore: store,
    createWorkerCapabilities: () => f.request.workerCapabilities.provider,
  });
  await expect(runRequestRunner(request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(f.gatewayInvoke.mock.calls.map(([input]) => supervisorFormatName(input) ?? input.modelStep))
    .toEqual(["supervisor_fused_entry", "supervisor_fused_routing", "supervisor.response"]);
});

test("accepts delegation only with the canonical directory and offered scope", () => {
  const options = {
    includeAcknowledgement: false, includeTitle: false,
    allowedRoleIds: ["worker"] as const,
    availableWorkerCapabilityCatalog: [{ groupId: "web", summary: "Observe external sources.", memberCount: 1, effects: ["observation"] as const }],
  };
  const decision = { action: "invoke_role", roleId: "worker", objective: "Observe current source facts.", workerCapabilityScope: { catalogGroupIds: ["web"] }, workingDirectory: "." };
  expect(parseFusedSupervisorRouting(JSON.stringify({ decision }), options)).toMatchObject({ ok: true, decision });
  expect(parseFusedSupervisorRouting(JSON.stringify({ decision: { ...decision, workingDirectory: "../outside" } }), options).ok).toBe(false);
  expect(parseFusedSupervisorRouting(JSON.stringify({ decision: { ...decision, workerCapabilityScope: { catalogGroupIds: ["other"] } } }), options).ok).toBe(false);
});
