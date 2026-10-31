import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { EventSink } from "../ports.js";
import type { CompiledRequestExecutionPolicy, RequestExecutionScope } from "../request/execution-scope.js";
import { runRequestRunner } from "../request/runner.js";
import { createRequestCallbacks, type RequestPresentationSnapshot } from "../streaming/request-callbacks.js";
import { USER_INTERACTION_EVENT_NAME } from "../user-interactions/contracts.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { actionFingerprint, createApprovalRunnerFixture } from "./support/request-approval-runner-fixture.js";
import { deriveTestRequestExecutionScope, rebindTestRequestExecutionPolicy } from "./support/request-execution-scope.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

function presentationFixture(restored?: RequestPresentationSnapshot, order: string[] = []) {
  const event = vi.fn((name: string, payload?: Record<string, unknown>) => {
    if (name === USER_INTERACTION_EVENT_NAME) order.push("message");
  });
  const events: EventSink = {
    event, publish: vi.fn(), runtimeState: vi.fn(), token: vi.fn(),
    legacyToken: vi.fn(), thinkingDelta: vi.fn(), completed: vi.fn(), failed: vi.fn(),
    drain: async () => {}, dispose: vi.fn(),
  };
  return { events, event, callbacks: createRequestCallbacks(events, "runner-approval", restored) };
}

function withPresentation(
  source: RequestExecutionScope,
  presentation: ReturnType<typeof presentationFixture>,
  decide: CompiledRequestExecutionPolicy["rootContract"]["decide"],
  enabled = true,
) {
  const policy: CompiledRequestExecutionPolicy = {
    ...source.executionPolicy,
    rootContract: {
      ...source.executionPolicy.rootContract,
      deferRespondPresentation: true,
      ...(enabled ? { supportedInteractionKinds: ["message"] as const } : {}),
      decide,
    },
  };
  return deriveTestRequestExecutionScope(rebindTestRequestExecutionPolicy(source, policy), {
    userInteractions: presentation.callbacks.userInteractions,
    onAnswerToken: presentation.callbacks.onAnswerToken,
    onAcknowledgement: presentation.callbacks.onAcknowledgement,
    onEvent: presentation.events.event,
  });
}

test.each([true, false])(
  "an update survives approval snapshot and resumes once with decision=%s",
  async (approved) => {
    const f = createApprovalRunnerFixture();
    const order: string[] = [];
    const initial = presentationFixture(undefined, order);
    const prepare = f.prepare.getMockImplementation()!;
    f.prepare.mockImplementation(async () => {
      order.push("prepare");
      return prepare();
    });
    f.performed.mockImplementation(() => { order.push("effect"); });
    const decide: CompiledRequestExecutionPolicy["rootContract"]["decide"] =
      async (request, options) => {
        const outcome = await f.decide(request, options);
        if (outcome.decision.action !== "invoke_capability") return outcome;
        return { ...outcome, interaction: { kind: "message", text: "I will inspect the selected target." } };
      };
    const waiting = await runRequestRunner(withPresentation(f.makeRequest(), initial, decide), {
      durableApproval: true,
    });
    if (waiting.kind !== "awaiting_approval") throw new Error("expected approval wait");
    expect(order).toEqual(["message", "prepare"]);
    expect(f.performed).not.toHaveBeenCalled();
    expect(initial.callbacks.getAnswerText()).toBe("");
    const stored = JSON.parse(JSON.stringify({
      continuation: waiting.continuation,
      presentation: initial.callbacks.snapshot(),
    }));
    const resumedPresentation = presentationFixture(stored.presentation, order);
    const resumedRequest = withPresentation(f.makeRequest(), resumedPresentation, decide);
    expect(resumedRequest.workerCapabilities.executionContext).not.toHaveProperty("userInteractions");
    const resumed = await runRequestRunner(resumedRequest, {
      durableApproval: true,
      continuation: stored.continuation,
      decisions: [{ approvalId: "approval-exact", actionFingerprint, decision: { approved } }],
    });
    expect(resumed).toMatchObject({
      kind: "completed",
      result: { output: `Finished: ${approved ? "succeeded" : "failed"}.`, outputTextMode: "exact" },
    });
    expect(initial.event.mock.calls.filter(([name]) => name === USER_INTERACTION_EVENT_NAME)).toHaveLength(1);
    expect(resumedPresentation.events.event).not.toHaveBeenCalledWith(USER_INTERACTION_EVENT_NAME, expect.anything());
    expect(resumedPresentation.callbacks.snapshot().userInteractions).toEqual(stored.presentation.userInteractions);
    expect(resumedPresentation.callbacks.getAnswerText()).toBe(`Finished: ${approved ? "succeeded" : "failed"}.`);
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.restore).toHaveBeenCalledOnce();
    expect(f.decide).toHaveBeenCalledTimes(2);
    expect(f.performed).toHaveBeenCalledTimes(approved ? 1 : 0);
  },
);

test("a steering update invalidates the pending message before any tool preparation", async () => {
  const f = createApprovalRunnerFixture();
  const p = presentationFixture();
  let decisions = 0;
  const decide: CompiledRequestExecutionPolicy["rootContract"]["decide"] =
    async (request, options) => {
      decisions += 1;
      if (decisions > 1) return {
        steeringVersion: f.requestSteering.snapshot().version,
        decision: { action: "blocked", response: "Updated direction." },
      };
      const old = await f.decide(request, options);
      f.requestSteering.append({ steerId: "new", text: "Stop inspecting; report current state." });
      return { ...old, interaction: { kind: "message", text: "STALE MESSAGE" } };
    };
  const result = await runRequestRunner(withPresentation(f.makeRequest(), p, decide));
  expect(result.output).toBe("Updated direction.");
  expect(f.prepare).not.toHaveBeenCalled();
  expect(p.event.mock.calls.filter(([name]) => name === USER_INTERACTION_EVENT_NAME)).toEqual([]);
  expect(p.callbacks.snapshot().userInteractions).toBeUndefined();
});

test("cancellation after a decision suppresses its message and tool preparation", async () => {
  const f = createApprovalRunnerFixture();
  const p = presentationFixture();
  const cancelled = new Error("cancelled-before-message");
  const decide: CompiledRequestExecutionPolicy["rootContract"]["decide"] =
    async (request, options) => {
      const outcome = await f.decide(request, options);
      f.abortController.abort(cancelled);
      return { ...outcome, interaction: { kind: "message", text: "Never publish." } };
    };
  await expect(runRequestRunner(withPresentation(f.makeRequest(), p, decide))).rejects.toBe(cancelled);
  expect(f.prepare).not.toHaveBeenCalled();
  expect(p.event.mock.calls.filter(([name]) => name === USER_INTERACTION_EVENT_NAME)).toEqual([]);
});

test("the shared kernel rejects publication from a root that did not opt in", async () => {
  const f = createApprovalRunnerFixture();
  const p = presentationFixture();
  const decide: CompiledRequestExecutionPolicy["rootContract"]["decide"] =
    async (request, options) => ({
      ...await f.decide(request, options),
      interaction: { kind: "message", text: "Unauthorized root message." },
    });
  await expect(runRequestRunner(withPresentation(f.makeRequest(), p, decide, false)))
    .rejects.toThrow("root_user_interaction_not_supported");
  expect(f.prepare).not.toHaveBeenCalled();
  expect(p.event.mock.calls.filter(([name]) => name === USER_INTERACTION_EVENT_NAME)).toEqual([]);
});

test("omitting an optional update leaves presentation receipts absent", async () => {
  const f = createApprovalRunnerFixture();
  const p = presentationFixture();
  const request = withPresentation(f.makeRequest(), p, async () => ({
    steeringVersion: 0,
    decision: { action: "blocked", response: "No extra message was needed." },
  }));
  const result = await runRequestRunner(request);
  expect(result.output).toBe("No extra message was needed.");
  expect(p.callbacks.snapshot().userInteractions).toBeUndefined();
  expect(p.event.mock.calls.filter(([name]) => name === USER_INTERACTION_EVENT_NAME)).toEqual([]);
});
