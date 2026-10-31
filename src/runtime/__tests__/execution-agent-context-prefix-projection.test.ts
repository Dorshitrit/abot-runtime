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
  expect(projected.messages).toEqual(admitted.messages);
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
