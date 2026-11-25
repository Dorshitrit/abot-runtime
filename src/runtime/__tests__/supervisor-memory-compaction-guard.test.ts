import { expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { isInvocationContextMessage, markInvocationContextMessage } from "../../model-gateway/protocol/invocation-context.js";
import { buildConversationMemoryAuthoringContext } from "../long-term-memory/conversation-authoring/context.js";
import { preserveSupervisorMemoryRoutingContext } from "../steps/supervisor-decision/memory-compaction.js";
import { createSupervisorMemoryFusionFixture, MEMORY_KNOWLEDGE } from "./support/supervisor-memory-fusion-fixture.js";

const APPENDIX = "BOUND_MEMORY_SCOPE";
type ChangeProjection = (messages: readonly ChatMessage[], reference: ChatMessage) => ChatMessage[];

function fixture(change: ChangeProjection) {
  const f = createSupervisorMemoryFusionFixture();
  const context = buildConversationMemoryAuthoringContext(f.request, f.requestSteering.snapshot(), MEMORY_KNOWLEDGE);
  const reference = markInvocationContextMessage(context.message);
  const messages: ChatMessage[] = [
    { role: "system", content: `ROUTING_POLICY\n${APPENDIX}` }, reference,
    { role: "user", content: "CURRENT_REQUEST" },
  ];
  const commit = vi.fn();
  const prepare = vi.fn(async () => ({ kind: "prepared" as const, preparation: {
    messages: change(messages, reference), scopeId: "guarded-scope", sourceRevision: 1,
    coveredSourceCount: 1, commit,
  } }));
  const controller = preserveSupervisorMemoryRoutingContext({
    project: input => [...input],
    getStages: () => [{ compactionScope: "active_request", scopeId: "guarded-scope", prepare }],
  }, { instructionAppendix: APPENDIX, context });
  return { messages, reference, commit, prepare, controller };
}

const invalidProjections: readonly { name: string; change: ChangeProjection }[] = [
  { name: "dropped memory reference", change: (messages, reference) => messages.filter(message => message !== reference) },
  { name: "altered memory reference", change: (messages, reference) => messages.map(message =>
    message === reference ? { role: "system" as const, content: "ALTERED_REFERENCE" } : message) },
  { name: "copied memory reference without invocation binding", change: (messages, reference) => messages.map(message =>
    message === reference ? { ...message } : message) },
  { name: "removed memory instruction appendix", change: messages => messages.map((message, index) =>
    index === 0 ? { role: "system" as const, content: "ROUTING_POLICY" } : message) },
];

test.each(invalidProjections)("$name fails before a provisional checkpoint can commit", async ({ change }) => {
  const f = fixture(change);
  expect(isInvocationContextMessage(f.reference)).toBe(true);
  expect(isInvocationContextMessage({ ...f.reference })).toBe(false);
  const attempt = async () => {
    const outcome = await f.controller.getStages()[0]!.prepare(f.messages);
    if (outcome.kind === "prepared") await outcome.preparation.commit();
  };
  await expect(attempt()).rejects.toThrow("supervisor_memory_routing_context_changed");
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(f.commit).not.toHaveBeenCalled();
});

test("an unchanged bound reference survives preparation and the original commit runs once", async () => {
  const f = fixture(messages => [...messages]);
  const outcome = await f.controller.getStages()[0]!.prepare(f.messages);
  if (outcome.kind !== "prepared") throw new Error("Expected a provisional checkpoint");
  expect(outcome.preparation.messages[1]).toBe(f.reference);
  expect(outcome.preparation.messages[0]).toBe(f.messages[0]);
  await outcome.preparation.commit();
  expect(f.commit).toHaveBeenCalledOnce();
});
