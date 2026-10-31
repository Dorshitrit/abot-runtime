import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";
import { finalizeResponse } from "../orchestration/final-response/finalization.js";
import { runRootExecutionKernel } from "../request/root-execution-kernel.js";
import { SUPERVISOR_WORKER_V1_EXECUTION_POLICY } from "../request/role-executor-composition.js";
import { projectExecutionHistoryObservation } from "../steps/execution-agent/history-observation.js";
import { buildExecutionCapabilityResultSource } from "../steps/execution-agent/capability-result-context.js";
import { readExecutionToolObservation } from "../../sessions/memory/execution-observation.js";
import { createRequestSessionMemory } from "../context/session-memory/controller.js";
import { createControlsEvidenceFixture, activeEvidenceCall } from "./support/execution-controls-evidence-fixture.js";
import { executionCompactionSteeringFixture, STEERED_FACT, STEERED_RAW } from "./support/execution-compaction-steering-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { resetDebugLoggerConfig(); vi.restoreAllMocks(); });

const toolOnlyFact = "A source-only fact: the archive marker is AMBER-731.";

test("captures settled EA results at the real root completion and saves them with the answer", async () => {
  const f = await createControlsEvidenceFixture();
  await f.addResult(toolOnlyFact);
  f.invoke.mockImplementation(async (input) => ({
    text: input.modelStep === "execution.response" ? "The source was read." : JSON.stringify({
      decision: { action: "respond" },
    }), meta: {},
  }));
  vi.mocked(f.request.modelGatewayClient.invokeRaw).mockResolvedValue({ text: "The source was read.", meta: { status: 200, outputLength: 20, thinkingLength: 0 } });
  const result = await runRootExecutionKernel({ request: f.request, ledger: f.ledger,
    presentation: { acknowledgementPublished: true, titlePublished: true } });
  expect(result.output).toBe("The source was read.");
  expect(result.output).not.toContain(toolOnlyFact);
  expect(result.finalObservation?.observationContent).toContain(toolOnlyFact);
  const store = createInMemorySessionStore();
  await store.appendMessage(f.request.sessionId, "user", "Read the source.", { requestId: f.request.requestId });
  const completed = vi.fn();
  await finalizeResponse({
    sessionId: f.request.sessionId,
    requestId: f.request.requestId,
    agentMode: f.request.agentMode,
    sessionStore: store,
    output: result.output,
    ...result.finalObservation,
    events: { event: vi.fn(), completed, failed: vi.fn(), publish: vi.fn(), runtimeState: vi.fn(),
      token: vi.fn(), legacyToken: vi.fn(), thinkingDelta: vi.fn(), drain: vi.fn(async () => {}), dispose: vi.fn() },
  });
  expect(completed).toHaveBeenCalledExactlyOnceWith(result.output);
  const session = await store.getOrCreateSession(f.request.sessionId);
  const saved = session.messages.at(-1)!;
  expect(saved.content).toBe(result.output);
  expect(readExecutionToolObservation(saved)?.results).toHaveLength(1);
  const memory = createRequestSessionMemory({
    scope: "execution_agent", sessionId: session.id, session, repository: store,
    compactor: { compact: vi.fn(async () => "unused") },
  });
  expect(JSON.stringify(memory.project())).toContain(toolOnlyFact);
});

test("keeps existing compacted evidence as its single historical representation", async () => {
  const f = await executionCompactionSteeringFixture();
  await f.run();
  const head = f.ledger.current();
  const observation = projectExecutionHistoryObservation(f.request, head, activeEvidenceCall(head));
  expect(observation?.observationContent).toContain(STEERED_FACT);
  expect(observation?.observationContent).not.toContain(STEERED_RAW);
  expect(JSON.parse(observation!.observationContent).results[0].representation).toBe("compacted");
});

test("captures failed results as failures without changing SUPER or empty EA turns", async () => {
  const f = await createControlsEvidenceFixture();
  expect(projectExecutionHistoryObservation(f.request, f.ledger.current(), activeEvidenceCall(f.ledger.current()))).toBeUndefined();
  await f.addResult("The source returned access denied.", { failed: true });
  const head = f.ledger.current();
  const call = activeEvidenceCall(head);
  const observation = projectExecutionHistoryObservation(f.request, head, call);
  expect(JSON.parse(observation!.observationContent).results[0].outcome).toBe("failed");
  expect(projectExecutionHistoryObservation(
    { ...f.request, executionPolicy: SUPERVISOR_WORKER_V1_EXECUTION_POLICY }, head, call,
  )).toBeUndefined();
});

test.each([
  { summary: toolOnlyFact, failed: false, keepsSummary: false },
  { summary: "A separate observation summary.", failed: false, keepsSummary: true },
  { summary: `${toolOnlyFact}\n`, failed: false, keepsSummary: true },
  { summary: toolOnlyFact, failed: true, keepsSummary: false },
])("stores registered tool output once when summary is identical: %j", async ({ summary, failed, keepsSummary }) => {
  const f = await createControlsEvidenceFixture();
  await f.addResult(toolOnlyFact, { failed });
  const base = f.ledger.current();
  const head = { ...base, state: { ...base.state, capabilityExecutions: base.state.capabilityExecutions.map((execution) => ({
    ...execution, summary,
    exactResult: { kind: "registered_tool_execution_result_v1" as const, authority: "registered_plugin" as const,
      status: "executed" as const, result: { ok: !failed, tool: "fixture", output: toolOnlyFact, producedNewInformation: true } },
  })) } };
  const sourceBefore = buildExecutionCapabilityResultSource(head, head.state.capabilityExecutions[0]!);
  const ledgerBefore = JSON.stringify(head);
  const observation = projectExecutionHistoryObservation(f.request, head, activeEvidenceCall(head))!;
  const savedResult = JSON.parse(observation.observationContent).results[0];
  expect(savedResult.adapterResult).toEqual(head.state.capabilityExecutions[0]!.exactResult);
  expect(savedResult.outcome).toBe(failed ? "failed" : "succeeded");
  if (keepsSummary) expect(savedResult.summary).toBe(summary);
  else expect(savedResult).not.toHaveProperty("summary");
  expect(savedResult).not.toHaveProperty("referenceData");
  expect(JSON.stringify(head)).toBe(ledgerBefore);
  expect(buildExecutionCapabilityResultSource(head, head.state.capabilityExecutions[0]!)).toEqual(sourceBefore);
  const store = createInMemorySessionStore();
  await store.appendMessage(f.request.sessionId, "user", "Read the source.", { requestId: f.request.requestId });
  await store.appendMessage(f.request.sessionId, "assistant", "The source was read.", {
    requestId: f.request.requestId, ...observation,
  });
  const session = await store.getOrCreateSession(f.request.sessionId);
  const memory = createRequestSessionMemory({ scope: "execution_agent", sessionId: session.id, session, repository: store,
    compactor: { compact: vi.fn(async () => "unused") } });
  const history = JSON.stringify(memory.project().historyMessages);
  expect(history.split(toolOnlyFact)).toHaveLength(summary === `${toolOnlyFact}\n` ? 3 : 2);
  expect(projectExecutionHistoryObservation({ ...f.request, executionPolicy: SUPERVISOR_WORKER_V1_EXECUTION_POLICY },
    head, activeEvidenceCall(head))).toBeUndefined();
});
