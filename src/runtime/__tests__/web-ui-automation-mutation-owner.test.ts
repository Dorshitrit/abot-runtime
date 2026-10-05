import { expect, test, vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createAutomationMutationRunner } from "../../web-ui/app/controllers/automation-mutation-lifecycle.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test.each(["success", "failure"])("an obsolete invocation cannot settle a newer same-label mutation: %s", async (outcome) => {
  const state = { mutation: "", feedback: "", error: "" };
  const publish = vi.fn();
  const mutation = createAutomationMutationRunner({ state, publish, onStart: vi.fn(), errorLabel: String });
  const first = deferred<boolean>(), second = deferred<boolean>();
  const old = mutation("Draft", () => first.promise, "Old feedback");
  // Owner-invariant fixture: production environmentChanged deliberately does
  // not reset this lock. Simulate external supersession to test token identity.
  state.mutation = "";
  const current = mutation("Draft", () => second.promise, "New feedback");
  const rendered = publish.mock.calls.length;
  if (outcome === "success") first.resolve(true);
  else first.reject(new Error("Old failure"));
  expect(await old).toBe(false);
  expect(state).toEqual({ mutation: "Draft", feedback: "", error: "" });
  expect(publish).toHaveBeenCalledTimes(rendered);
  const duplicate = vi.fn(async () => true);
  expect(await mutation("Draft", duplicate)).toBe(false);
  expect(duplicate).not.toHaveBeenCalled();
  second.resolve(true);
  expect(await current).toBe(true);
  expect(state).toEqual({ mutation: "", feedback: "New feedback", error: "" });
});

test.each(["success", "failure"])("default view scope composes with caller-specific guards: %s", async (outcome) => {
  let currentView = 1;
  const state = { mutation: "", feedback: "Keep", error: "" };
  const mutation = createAutomationMutationRunner({ state, publish: vi.fn(), onStart: vi.fn(), errorLabel: String,
    captureCurrentView: () => { const captured = currentView; return () => captured === currentView; } });
  const held = deferred<boolean>();
  const pending = mutation("Publication", () => held.promise, "Old view saved", () => true);
  currentView += 1;
  if (outcome === "success") held.resolve(true);
  else held.reject(new Error("Old view failed"));
  expect(await pending).toBe(false);
  expect(state).toEqual({ mutation: "", feedback: "Keep", error: "" });
});

test("a stricter caller guard still rejects an outcome in the same view", async () => {
  const state = { mutation: "", feedback: "", error: "" };
  const mutation = createAutomationMutationRunner({ state, publish: vi.fn(), onStart: vi.fn(), errorLabel: String,
    captureCurrentView: () => () => true });
  expect(await mutation("Validation", async () => true, "Saved", () => false)).toBe(false);
  expect(state).toEqual({ mutation: "", feedback: "", error: "" });
});
