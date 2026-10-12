import { expect, test, vi } from "vitest";
import { createClientPreferences } from "../app/services/client-preferences.js";
// @ts-expect-error Internal browser transport.
import { createWorkspaceStateStorage } from "../app/services/workspace-state-storage.js";

test.each(["accepted", "rejected"] as const)("pin reads use acknowledged values during another preference notification and after a %s write", async (outcome) => {
  const key = "abot-web.pinnedSessions";
  const state = { version: 1, revision: 0, preferences: { [key]: '["saved"]' }, queue: "" };
  const fetchImpl = vi.fn(async () => Response.json({ state }));
  const storage = createWorkspaceStateStorage({ fetchImpl });
  await storage.refresh();
  const preferences = createClientPreferences(storage);
  const observed: string[][] = [];
  storage.subscribe(() => observed.push(preferences.loadPinnedSessions()));
  let finishEarlier!: (response: Response) => void;
  fetchImpl.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishEarlier = resolve; }));
  const earlier = storage.setItem("other", "saved");
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
  let finishPins!: (response: Response) => void;
  fetchImpl.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishPins = resolve; }));
  const pinning = preferences.savePinnedSessions(["new", "saved"]) as Promise<void>;
  const settled = pinning.then(() => null, (error: Error) => error);
  expect(preferences.loadPinnedSessions()).toEqual(["saved"]);
  finishEarlier(Response.json({ state: { ...state, revision: 1, preferences: { ...state.preferences, other: "saved" } } }));
  await earlier;
  expect(observed).toEqual([["saved"]]);
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
  expect(preferences.loadPinnedSessions()).toEqual(["saved"]);
  if (outcome === "rejected") {
    finishPins(Response.json({ message: "conflict" }, { status: 409 }));
    expect(await settled).toBeInstanceOf(Error);
    expect(preferences.loadPinnedSessions()).toEqual(["saved"]);
    // Dropping the rejected pending projection notifies all preference consumers.
    expect(observed).toEqual([["saved"], ["saved"]]);
    return;
  }
  finishPins(Response.json({ state: { ...state, revision: 2, preferences: { ...state.preferences, [key]: '["new","saved"]' } } }));
  expect(await settled).toBeNull();
  expect(preferences.loadPinnedSessions()).toEqual(["new", "saved"]);
  expect(observed).toEqual([["saved"], ["new", "saved"]]);
});
