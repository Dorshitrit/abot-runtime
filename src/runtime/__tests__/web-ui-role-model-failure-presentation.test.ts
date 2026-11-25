import { afterEach, beforeEach, expect, test } from "vitest";
import { ModelGatewayInvocationError } from "../../model-gateway/client/invocation-error.js";
import { createConversationRoleReturns } from "../../web-ui/app/components/conversation-role-returns.js";
import { buildConversationActivityModel } from "../../web-ui/app/components/conversation-activity.js";
import type { RoleReturn } from "../../web-ui/app/lib/role-return-event.js";
import { ModelProviderFailure } from "../model/provider-failure.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { ROLE_CALL_RESULT_MAX_LENGTH } from "../orchestration/role-calls/index.js";
import { executeRoleWithModelOutputFailure } from "../orchestration/role-executors/activation/model-output-failure.js";
import { ContextElement } from "./support/composer-context-window-dom.js";
import { createObservedReturnLedger, openChild, requestId, returnChild } from "./support/role-return-events-fixture.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

const failure = Object.freeze({
  kind: "runtime_role_model_output_failure_v1",
  authority: "runtime_validation",
  presenceEffect: "passive_failure_not_work_or_review_evidence",
  callId: "call-2", parentCallId: "call-1", roleId: "planner",
  reason: "model_provider_failure", modelStep: "super.compact.content",
  validationStage: "model_provider_http",
});
const providerMessage = "The Planner could not finish because a model request failed.";

function receipt(summary = JSON.stringify(failure), overrides: Partial<RoleReturn> = {}): RoleReturn {
  return { id: "return-1", generation: "generation-1", callerCallId: "call-1", callerRole: "supervisor",
    childCallId: "call-2", childRole: "planner", outcome: "failed", summary, ...overrides };
}

function render(value: RoleReturn, displayRequestId = "request-1") {
  const documentRoot = { createElement: (tag: string) => new ContextElement(tag) } as unknown as Document;
  const node = createConversationRoleReturns({ documentRoot })
    .createNode({ requestId: displayRequestId, returns: [value] }) as unknown as ContextElement;
  return { node, summary: node.querySelector(".conversation-role-return-summary")! };
}

test.each([false, true])("presents a delegated provider failure through its committed live/replayed event without changing evidence (replay=%s)", async replay => {
  const { ledger, onEvent } = await createObservedReturnLedger();
  await openChild(ledger);
  const output = await executeRoleWithModelOutputFailure({
    roleId: "planner",
    async execute() { throw new ModelProviderFailure("super.compact.content",
      new ModelGatewayInvocationError("http", "bridge_request_failed:400:model_context_window_exceeded")); },
  }, { context: undefined, call: ledger.current().state.calls[1]!, ledger, availableChildRoleIds: [] },
  ROLE_CALL_RESULT_MAX_LENGTH, requestId);
  expect(output).toMatchObject({ kind: "terminal", outcome: "failed" });
  if (output.kind !== "terminal" || output.outcome !== "failed") throw new Error("Expected contained role failure");
  const { summary } = output;
  expect(JSON.parse(summary)).toEqual(failure);
  await returnChild(ledger, { outcome: output.outcome, summary });
  expect(onEvent).toHaveBeenCalledTimes(1);
  const [name, payload] = onEvent.mock.calls[0]!;
  const canonicalHead = ledger.current();
  expect(canonicalHead.state.results[0]!.summary).toBe(summary);
  const event = {
    type: "event", name, requestId, sessionId: "session-1", eventSequence: 104,
    payload: { ...payload, generation: "generation-1" },
  };
  const snapshot = {
    sessionId: "session-1",
    messages: [{ id: "answer", role: "assistant", content: "Supervisor continued.", requestId }],
    requests: [{ requestId, status: "completed", events: [{ ...event, seqNo: 104 }],
      finalState: { status: "completed", output: "Supervisor continued." } }],
  };
  const original = JSON.stringify({ event, snapshot });
  const harness = createPlanLifecycleHarness(replay ? snapshot : {});
  harness.state.activeRequestId = requestId;
  harness.state.messages = harness.state.messages.map(message => ({ ...message, requestId }));
  harness.state.requestMessages = new Map([[requestId, "assistant-1"]]);
  if (replay) await harness.conversationSession.openSession("session-1");
  else harness.realtime.handle(event);
  const beforeRender = JSON.stringify(harness.state.events);
  const model = buildConversationActivityModel({ requestId, events: harness.state.events, streaming: !replay });
  const value = model.roleCards.find(card => card.role === "planner")!.returns![0]!;
  const shown = render(value, requestId);
  expect(shown.summary.textContent).toBe(providerMessage);
  expect(shown.summary.children).toHaveLength(0);
  expect(shown.summary.getAttribute("dir")).toBe("auto");
  expect(shown.node.querySelector(".conversation-role-return-label")!.textContent).toBe("Planner failed");
  expect(value.summary).toBe(summary);
  expect(ledger.current()).toBe(canonicalHead);
  expect(canonicalHead.state.results[0]!.summary).toBe(summary);
  expect(harness.state.events.find(item => item.eventName === "role.returned")?.summary).toBe(summary);
  expect(JSON.stringify(harness.state.events)).toBe(beforeRender);
  expect(JSON.stringify({ event, snapshot })).toBe(original);
  expect(model.failureCount).toBe(0);
  expect(model.toolCount).toBe(0);
});

test.each([
  [{ reason: "planner_decision_timeout", modelStep: "planner.decision", validationStage: "model_step_timeout" },
    "The Planner could not finish because a model request timed out."],
  [{ reason: "output_incomplete", validationStage: "provider_completion" },
    "The Planner could not finish because the model response was incomplete."],
  [{ reason: "invalid_super_compaction_content_output", validationStage: "raw_compaction_content" },
    "The Planner could not finish because the model returned an invalid response."],
  [{ reason: "future_model_failure", validationStage: "future_model_stage" },
    "The Planner could not complete a model step."],
] as const)("describes the recorded failure category without exposing its internal capsule: %j", (fields, message) => {
  const value = Object.freeze(receipt(JSON.stringify({ ...failure, ...fields })));
  expect(render(value).summary.textContent).toBe(message);
  expect(value.summary).toBe(JSON.stringify({ ...failure, ...fields }));
});

test.each([
  "  Could not access the requested resource.\n<script>literal</script>  ",
  '{"status":"failed","reason":"model_provider_failure","details":"legitimate authored JSON"}',
  "{broken JSON",
  "null",
  JSON.stringify([failure]),
  JSON.stringify({ ...failure, kind: "runtime_role_model_output_failure_v2" }),
  JSON.stringify({ ...failure, authority: "model" }),
  JSON.stringify({ ...failure, presenceEffect: "work_evidence" }),
  JSON.stringify({ ...failure, callId: "different-child" }),
  JSON.stringify({ ...failure, parentCallId: "different-caller" }),
  JSON.stringify({ ...failure, roleId: "worker" }),
  JSON.stringify({ ...failure, modelStep: 4 }),
  JSON.stringify({ ...failure, validationStage: "" }),
  JSON.stringify({ ...failure, reason: undefined }),
  JSON.stringify({ ...failure, extra: "ordinary extra content" }),
])("preserves ordinary content and nonmatching capsules exactly: %s", summary => {
  const value = Object.freeze(receipt(summary));
  const shown = render(value).summary;
  expect(shown.textContent).toBe(summary);
  expect(shown.children).toHaveLength(0);
  expect(value.summary).toBe(summary);
});

test("does not interpret a completed role's JSON result as a failure", () => {
  const value = Object.freeze(receipt(JSON.stringify(failure), { outcome: "completed" }));
  const shown = render(value);
  expect(shown.summary.textContent).toBe(value.summary);
  expect(shown.node.querySelector(".conversation-role-return-label")!.textContent).toBe("Returned result");
});
