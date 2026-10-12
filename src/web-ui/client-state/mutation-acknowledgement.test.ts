import { expect, test, vi } from "vitest";
// @ts-expect-error Browser transport module.
import { createWorkspaceStateStorage } from "../app/services/workspace-state-storage.js";

const state = { version: 1, revision: 0, preferences: {}, queue: "" };
test.each(["rejected", "server failure", "disconnected", "invalid acknowledgement"])("classifies a %s mutation before attachment cleanup", async (outcome) => {
  const fetchImpl = vi.fn(async () => Response.json({ state }));
  const storage = createWorkspaceStateStorage({ fetchImpl });
  await storage.refresh();
  fetchImpl.mockImplementationOnce(async () => {
    if (outcome === "disconnected") throw new Error("response lost");
    if (outcome === "rejected") return Response.json({ message: "conflict" }, { status: 409 });
    if (outcome === "server failure") return Response.json({ message: "lock cleanup failed" }, { status: 500 });
    return Response.json({ result: true });
  });
  const error = await storage.execute({ kind: "queue", scope: { environmentId: "prod", sessionId: "chat" }, action: "enqueue" }).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect(error.workspaceMutationMayHaveCommitted === true).toBe(outcome !== "rejected");
});

test("does not classify a failed rendering subscriber as an unsaved mutation", async () => {
  const fetchImpl = vi.fn(async () => Response.json({ state }));
  const storage = createWorkspaceStateStorage({ fetchImpl });
  await storage.refresh();
  storage.subscribe(() => { throw new Error("render failed"); });
  fetchImpl.mockResolvedValueOnce(Response.json({ state: { ...state, revision: 1, preferences: { selection: "saved" } } }));
  const error = await storage.execute({ kind: "queue", scope: { environmentId: "prod", sessionId: "chat" }, action: "enqueue" }).catch((error: unknown) => error);
  expect(error.workspaceMutationMayHaveCommitted).toBe(true);
  expect(storage.snapshot().revision).toBe(1);
});
