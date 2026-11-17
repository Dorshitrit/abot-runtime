import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { LearningMemoryService } from "../long-term-memory/maturation/contracts.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { RequestExecutionScope } from "../request/execution-scope.js";
import { buildSupervisorDecisionInput } from "../steps/supervisor-decision/input.js";
import { buildSupervisorProcedureGateInput } from "../steps/supervisor-decision/procedure-gate.js";
import { buildSupervisorMemoryAvailabilityInstructions } from "../steps/supervisor-decision/prompt.js";
import { createMemoryRecallHarness } from "./support/memory-recall-runner.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { resetDebugLoggerConfig(); vi.restoreAllMocks(); });

const diagnostic = { requestId: "memory-recall-request", modelStep: "supervisor.decision" as const };
const builders = [
  ["compact gate", (request: RequestExecutionScope) => buildSupervisorProcedureGateInput(request, { diagnostic })],
  ["full decision", (request: RequestExecutionScope) => buildSupervisorDecisionInput(request, {
    diagnostic, toolResults: { sourceRevision: 0, results: [] },
  })],
] as const;

function fixture(prompt = "Remember that I prefer concise explanations.") {
  const harness = createMemoryRecallHarness({
    policy: "supervisor-worker-v1", decide: () => ({ action: "respond" }),
  });
  const learning: LearningMemoryService = {
    prepare: vi.fn(), policy: vi.fn(), configurePolicy: vi.fn(), reviewAdmission: vi.fn(),
    nextReconsiderationAt: vi.fn(), reconsiderationContext: vi.fn(), maintenance: vi.fn(),
    nextExpiryAt: vi.fn(), overview: vi.fn(), sourceVersions: vi.fn(), apply: vi.fn(),
    list: vi.fn(), receipt: vi.fn(),
  };
  const memory = { ...harness.memory, learning };
  const request = deriveTestRequestExecutionScope(harness.request, { prompt, longTermMemory: memory });
  return { ...harness, memory, request };
}

test.each(builders)("%s projects active save availability without changing schema, user intent, or invoking memory", (_phase, buildInput) => {
  for (const prompt of ["Remember that I prefer concise explanations.", "Explain why the sky appears blue."]) {
    const f = fixture(prompt);
    const baseline = buildInput(deriveTestRequestExecutionScope(f.request, { longTermMemory: undefined }));
    const active = buildInput(f.request);
    const guidance = buildSupervisorMemoryAvailabilityInstructions(f.memory).join("\n");
    expect(guidance.length).toBeGreaterThan(0);
    expect(active.format).toEqual(baseline.format);
    expect(active.context.messages.map(({ role }) => role)).toEqual(baseline.context.messages.map(({ role }) => role));
    expect(active.context.messages.filter(({ role }) => role === "user")).toEqual([{ role: "user", content: prompt }]);
    expect(active.context.selectedHistoryMessageIds).toEqual(baseline.context.selectedHistoryMessageIds);
    expect(active.context.messages.filter(({ content }) => content.includes(guidance))).toHaveLength(1);
    expect(active.context.messages.map((message) => ({
      ...message, content: message.content.replace(`\n${guidance}`, ""),
    }))).toEqual(baseline.context.messages);
    expect(f.gatewayInvoke).not.toHaveBeenCalled();
    expect(f.getAdapters).not.toHaveBeenCalled();
    for (const operation of Object.values(f.memory)) {
      if (vi.isMockFunction(operation)) expect(operation).not.toHaveBeenCalled();
    }
    for (const operation of Object.values(f.memory.learning)) expect(operation).not.toHaveBeenCalled();
  }
});

test.each(builders)("%s omits save availability for absent, disabled, or learning-free services", (_phase, buildInput) => {
  const f = fixture();
  const inactive = [undefined, { ...f.memory, enabled: false }, { ...f.memory, learning: undefined }];
  const baseline = buildInput(deriveTestRequestExecutionScope(f.request, { longTermMemory: undefined }));
  for (const memory of inactive) {
    expect(buildSupervisorMemoryAvailabilityInstructions(memory)).toEqual([]);
    const input = buildInput(deriveTestRequestExecutionScope(f.request, { longTermMemory: memory }));
    expect(input).toEqual(baseline);
  }
});
