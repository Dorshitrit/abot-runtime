import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { EventSink, ModelGatewayClient } from "../ports.js";
import type { WorkerCapabilityAdapter } from "../orchestration/worker-capabilities/index.js";
import type { RequestCapabilityExecutionView } from "../request/execution-scope.js";
import { runRequestRunner } from "../request/runner.js";
import { createRequestCallbacks } from "../streaming/request-callbacks.js";
import { USER_INTERACTION_EVENT_NAME } from "../user-interactions/contracts.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createRootInvalidOutputRequest } from "./support/root-invalid-output-fixture.js";
import { runtimeCapsule } from "./support/execution-controls-evidence-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

const finalText = "  The observation is complete.\n\t";
const encode = (decision: Record<string, unknown>) => ({ text: JSON.stringify({ decision }), meta: {} });

function createFixture(emitMessages: boolean, invalidFirst = false) {
  const order: string[] = [];
  const event = vi.fn((name: string, payload?: Record<string, unknown>) => {
    if (name === USER_INTERACTION_EVENT_NAME) order.push("message");
  });
  const events: EventSink = {
    event, publish: vi.fn(), runtimeState: vi.fn(), token: vi.fn(),
    legacyToken: vi.fn(), thinkingDelta: vi.fn(), completed: vi.fn(), failed: vi.fn(),
    drain: async () => {}, dispose: vi.fn(),
  };
  const callbacks = createRequestCallbacks(events, "root-invalid-request");
  const execute = vi.fn<WorkerCapabilityAdapter<RequestCapabilityExecutionView>["execute"]>(async () => {
    order.push("tool");
    return {
      outcome: "succeeded", observedEffect: "observation",
      summary: "Observed the requested target.", referenceData: "observed-value",
    };
  });
  const adapter: WorkerCapabilityAdapter<RequestCapabilityExecutionView> = {
    descriptor: {
      capabilityId: "fixture.observe",
      summary: "Observe one exact target.",
      effect: "observation",
      catalogGroups: ["fixture"],
      controls: {
        type: "object", additionalProperties: false,
        properties: { target: { type: "string", minLength: 1, maxLength: 256 } }, required: ["target"],
      },
      selectionControlIds: ["target"],
      controlsRefinement: "mechanical_when_complete",
    },
    execute,
  };
  const contexts: (Record<string, unknown> | undefined)[] = [];
  let stage = 0;
  let repairOffered = false;
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    order.push(`model:${input.modelStep}`);
    contexts.push(runtimeCapsule(input.messages, "runtime_user_interaction_receipts_v1"));
    if (invalidFirst && !repairOffered) {
      repairOffered = true;
      return encode({
        action: "open_capability_scope", catalogGroupIds: ["fixture"],
        interaction: { kind: "message", text: "DRAFT MUST NOT PUBLISH", interactionId: "model-invented" },
      });
    }
    stage += 1;
    if (stage === 1) return encode({
      action: "open_capability_scope", catalogGroupIds: ["fixture"],
      interaction: emitMessages ? { kind: "message", text: "I will inspect the requested target." } : null,
    });
    if (stage === 2) return encode({
      action: "invoke_capability", capabilityId: "fixture.observe",
      selectionControls: { target: "requested" },
      workingDirectory: ".",
      interaction: emitMessages ? { kind: "message", text: "The observation is starting." } : null,
    });
    if (stage === 3) return encode({ action: "respond" });
    if (stage === 4) {
      expect(input.modelStep).toBe("execution.response");
      return { text: finalText, meta: {} };
    }
    throw new Error("unexpected extra model step");
  });
  const onAcknowledgement = vi.fn(callbacks.onAcknowledgement);
  const request = createRootInvalidOutputRequest(invoke, "execution-agent-v1", {
    userInteractions: callbacks.userInteractions,
    workerCapabilityProvider: {
      getDescriptors: () => [adapter.descriptor],
      getAdapters: () => [adapter],
    },
    onEvent: events.event,
    onAcknowledgement,
    onAnswerToken: callbacks.onAnswerToken,
  });
  return { request, order, event, contexts, callbacks, invoke, execute, onAcknowledgement };
}

test.each([true, false])(
  "EA may publish updates=%s, execute its tool, then deliver the exact final response",
  async (emitMessages) => {
    const f = createFixture(emitMessages);
    const result = await runRequestRunner(f.request);
    expect(result).toMatchObject({ output: finalText, outputTextMode: "exact" });
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.onAcknowledgement).not.toHaveBeenCalled();
    expect(f.execute.mock.calls[0]![0]).not.toHaveProperty("intent");
    expect(f.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
      "execution.decision", "execution.decision", "execution.decision", "execution.response",
    ]);
    expect(f.callbacks.getAnswerText()).toBe(finalText);
    const messages = f.event.mock.calls.filter(([name]) => name === USER_INTERACTION_EVENT_NAME);
    expect(messages).toHaveLength(emitMessages ? 2 : 0);
    if (!emitMessages) {
      expect(f.contexts).toEqual([undefined, undefined, undefined, undefined]);
      expect(f.callbacks.snapshot().userInteractions).toBeUndefined();
      return;
    }
    expect(f.order).toEqual([
      "model:execution.decision", "message",
      "model:execution.decision", "message", "tool",
      "model:execution.decision", "model:execution.response",
    ]);
    expect(messages.map(([, payload]) => payload?.interaction)).toMatchObject([
      { requestId: "root-invalid-request", sequence: 1, payload: { text: "I will inspect the requested target." } },
      { requestId: "root-invalid-request", sequence: 2, payload: { text: "The observation is starting." } },
    ]);
    expect(f.contexts[0]).toBeUndefined();
    expect(f.contexts.slice(1).map((context) => context?.publishedCount)).toEqual([1, 2, 2]);
    expect(f.contexts[3]).toMatchObject({
      authority: "assistant_communication", omittedCount: 0,
      entries: [{ sequence: 1 }, { sequence: 2 }],
    });
  },
);

test("a rejected structured output is repaired before any draft message becomes visible", async () => {
  const f = createFixture(true, true);
  const result = await runRequestRunner(f.request);
  expect(result.output).toBe(finalText);
  expect(f.execute).toHaveBeenCalledOnce();
  expect(f.invoke).toHaveBeenCalledTimes(5);
  expect(f.event.mock.calls.filter(([name]) => name === USER_INTERACTION_EVENT_NAME)).toHaveLength(2);
  expect(JSON.stringify(f.event.mock.calls)).not.toContain("DRAFT MUST NOT PUBLISH");
  expect(f.order.slice(0, 3)).toEqual(["model:execution.decision", "model:execution.decision", "message"]);
});
