import { describe, expect, test } from "vitest";
import { projectConversationInteractionEntries } from "../../web-ui/app/components/conversation-interaction.js";

type Message = Record<string, unknown>;
const answer = (id: string, requestId = "r1"): Message => ({ id, requestId, role: "assistant", text: id });
const update = (id: string, requestId = "r1"): Message => ({
  ...answer(id, requestId), kind: "user_interaction", interactionSequence: Number(id.slice(-1)) || 1,
});

function projectWithoutMutation(messages: Message[]) {
  const before = structuredClone(messages);
  const frozen = Object.freeze(messages.map((message) => Object.freeze(message)));
  const entries = projectConversationInteractionEntries(frozen);
  expect(frozen).toEqual(before);
  return entries;
}

describe("conversation progress grouping", () => {
  test("attaches all source-ordered updates to the latest same-request assistant regardless of arrival position", () => {
    const first = update("update-1"), second = update("update-2");
    const early = answer("early"), final = answer("final");
    const entries = projectWithoutMutation([first, early, second, final]);
    expect(entries).toEqual([{ message: early, updates: [] }, { message: final, updates: [first, second] }]);
    expect(entries[1]!.message).toBe(final);
    expect(entries[1]!.updates[0]).toBe(first);
    expect(entries[1]!.updates[1]).toBe(second);
  });

  test("renders one fallback at the first update when there is no same-request assistant host", () => {
    const user = { id: "user", requestId: "r1", role: "user", text: "Start" };
    const first = update("update-1"), second = update("update-2"), unrelated = answer("other", "r2");
    expect(projectWithoutMutation([user, first, unrelated, second])).toEqual([
      { message: user, updates: [] }, { message: first, updates: [first, second] }, { message: unrelated, updates: [] },
    ]);
  });

  test("keeps requests and ordinary message identities separate", () => {
    const a1 = answer("answer-1"), a2 = answer("answer-2", "r2");
    const u1 = update("update-1"), u2 = update("update-2", "r2"), u3 = update("update-3");
    const entries = projectWithoutMutation([a1, u1, a2, u2, u3]);
    expect(entries).toEqual([{ message: a1, updates: [u1, u3] }, { message: a2, updates: [u2] }]);
    expect(entries.map(({ message }) => message)).toEqual([a1, a2]);
  });

  test("uses an approval row as a visual host until the final response exists", () => {
    const first = update("update-1"), second = update("update-2");
    const approval = { ...answer("approval"), kind: "tool_approval_request", approvalRequest: { approvalId: "bound-action" } };
    expect(projectWithoutMutation([first, approval, second])).toEqual([
      { message: approval, updates: [first, second] },
    ]);
    const final = answer("final");
    expect(projectWithoutMutation([first, approval, second, final])).toEqual([
      { message: approval, updates: [] }, { message: final, updates: [first, second] },
    ]);
    expect(approval.approvalRequest).toEqual({ approvalId: "bound-action" });
  });

  test("keeps empty and no-interaction conversations unchanged", () => {
    expect(projectWithoutMutation([])).toEqual([]);
    const user = { id: "user", role: "user", text: "Question" }, assistant = answer("answer");
    const entries = projectWithoutMutation([user, assistant]);
    expect(entries).toEqual([{ message: user, updates: [] }, { message: assistant, updates: [] }]);
    expect(entries[0]!.message).toBe(user);
    expect(entries[1]!.message).toBe(assistant);
  });
});
