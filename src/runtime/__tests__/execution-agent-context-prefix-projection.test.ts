import { expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { projectRequestContext } from "../context/request-context.js";
import { findExecutionActivationBoundary, projectExecutionContextPrefix } from "../steps/execution-agent/context-prefix.js";

const state: ChatMessage = { role: "user", content: "state" };
const catalog: ChatMessage = { role: "user", content: "catalog" };
const fixed: ChatMessage = { role: "user", content: "fixed" };
const references = [fixed, state, catalog];
const context = () => projectRequestContext({
  instructions: "system", prompt: "exact request", historyMessages: [],
  referenceMessages: references, budget: {
    contextWindowTokens: 32000, outputReserveTokens: 1000,
    safetyReserveTokens: 100, attachmentReserveTokens: 0,
  },
});

test("does not resurrect removed or replaced references from an admitted projection", () => {
  const original = context();
  const replacement: ChatMessage = { role: "user", content: "compacted replacement" };
  const admitted = { ...original, messages: original.messages
    .filter((message) => message !== catalog)
    .map((message) => message === state ? replacement : message) };
  const projected = projectExecutionContextPrefix({
    context: admitted, referenceMessages: references,
    catalogMessages: [catalog], activationMessages: [state],
  });
  expect(projected.messages).toEqual([
    admitted.messages[0], replacement, admitted.messages.at(-1), fixed,
  ]);
  expect(projected.messages).not.toContain(catalog);
  expect(projected.messages).not.toContain(state);
  expect(projected.messages.filter((message) => message === replacement)).toHaveLength(1);
  expect(projected.budget).toBe(admitted.budget);
});

test("uses projected occurrences, never the supplied list's duplicate or overlapping entries", () => {
  const original = context();
  const admitted = { ...original, messages: [...original.messages, fixed] };
  const projected = projectExecutionContextPrefix({
    context: admitted, referenceMessages: [...references, catalog],
    catalogMessages: [catalog, catalog, state], activationMessages: [state, state],
  });
  expect(projected.messages.filter((message) => message === catalog)).toHaveLength(1);
  expect(projected.messages.filter((message) => message === state)).toHaveLength(1);
  expect(projected.messages.filter((message) => message === fixed)).toHaveLength(2);
  expect(projected.messages).toHaveLength(admitted.messages.length);
  expect(projected.messages.at(-1)).toBe(state);
});

test("binds the first retained activation reference after omission, without text matching", () => {
  const omitted: ChatMessage = { role: "user", content: "state" };
  const sameBytes: ChatMessage = { ...state };
  const messages = [catalog, sameBytes, state];
  expect(findExecutionActivationBoundary(messages, [omitted, state])).toBe(state);
  expect(findExecutionActivationBoundary([catalog, sameBytes], [state])).toBeUndefined();
});

function nativeGroup(id: string): readonly ChatMessage[] {
  return [
    { role: "assistant", content: "", toolCalls: [
      { callId: `${id}-a`, name: "runtime_capability", arguments: '{"target":"a"}' },
      { callId: `${id}-b`, name: "runtime_capability", arguments: '{"target":"b"}' },
    ] },
    { role: "tool", content: "first exact result", toolCallId: `${id}-a`, toolName: "runtime_capability" },
    { role: "tool", content: "second exact result", toolCallId: `${id}-b`, toolName: "runtime_capability" },
  ];
}

test("moves retained objects for the whole terminal group without copying its bytes or changing the budget", () => {
  const older = nativeGroup("older"), latest = nativeGroup("latest");
  const original = context();
  const admitted = { ...original, messages: [...original.messages, ...older, ...latest] };
  const projected = projectExecutionContextPrefix({
    context: admitted, referenceMessages: references, catalogMessages: [catalog],
    activationMessages: [state], latestContinuationGroup: latest,
  });
  expect(projected.messages.slice(-latest.length)).toEqual(latest);
  for (const [index, message] of latest.entries())
    expect(projected.messages.at(-latest.length + index)).toBe(message);
  expect(projected.messages.indexOf(state)).toBeLessThan(projected.messages.indexOf(latest[0]!));
  expect(projected.messages.indexOf(older.at(-1)!)).toBeLessThan(projected.messages.indexOf(state));
  expect(projected.messages).toHaveLength(admitted.messages.length);
  expect(projected.budget).toBe(admitted.budget);
});

const rejectedTailCases: readonly {
  name: string;
  retained(group: readonly ChatMessage[]): readonly ChatMessage[];
  hasOriginalObjects: boolean;
}[] = [
  { name: "omitted", retained: () => [], hasOriginalObjects: false },
  { name: "partial", retained: (group) => group.slice(0, -1), hasOriginalObjects: true },
  { name: "same-bytes-replacement", retained: (group) => group.map((message) => structuredClone(message)), hasOriginalObjects: false },
  { name: "duplicate", retained: (group) => [...group, group.at(-1)!], hasOriginalObjects: true },
  { name: "newer-native-group", retained: (group) => [...group, ...nativeGroup("newer")], hasOriginalObjects: true },
];

test.each(rejectedTailCases)(
  "does not relocate or resurrect a $name group",
  ({ retained, hasOriginalObjects }) => {
    const latest = nativeGroup("latest");
    const original = context();
    const admitted = { ...original, messages: [...original.messages, ...retained(latest)] };
    const params = {
      context: admitted, referenceMessages: references, catalogMessages: [catalog], activationMessages: [state],
    };
    const unchanged = projectExecutionContextPrefix(params);
    const projected = projectExecutionContextPrefix({ ...params, latestContinuationGroup: latest });
    expect(projected.messages).toEqual(unchanged.messages);
    expect(projected.messages).toHaveLength(admitted.messages.length);
    if (!hasOriginalObjects)
      for (const message of latest) expect(projected.messages.includes(message)).toBe(false);
  },
);
