import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only controller has no declaration surface.
import { createPassiveLearningController } from "../../web-ui/app/controllers/passive-learning-controller.js";

function controllerHarness() {
  let environment = "dev";
  const client = {
    loadPassiveLearning: vi.fn(async () => ({ status: {
      preferences: { enabled: false, proactiveEnabled: true },
      proactive: { state: "waiting" }, recentMemories: [],
    } })),
    listPassiveLearningCandidates: vi.fn(async (_environment: string) => ({ items: [{ id: "candidate" }] })),
    listPassiveLearningBatches: vi.fn(async () => ({ items: [] })),
    listModels: vi.fn(async () => ({ profiles: [] })),
  };
  const controller = createPassiveLearningController({
    client, getEnvironmentId: () => environment, render: vi.fn(), isVisible: () => true,
  });
  return { client, controller, setEnvironment: (value: string) => {
    environment = value;
    controller.environmentChanged();
  } };
}

describe("Co-worker candidate loading", () => {
  test("loads only for the visible workspace and ignores previous-environment results", async () => {
    const h = controllerHarness();
    h.controller.setWorkspace("home");
    await vi.waitFor(() => expect(h.controller.snapshot().status).not.toBeNull());
    expect(h.client.listPassiveLearningCandidates).not.toHaveBeenCalled();
    let resolve!: (value: { items: { id: string }[] }) => void;
    const old = new Promise<{ items: { id: string }[] }>((done) => { resolve = done; });
    h.client.listPassiveLearningCandidates.mockImplementationOnce(() => old);
    h.controller.setWorkspace("learning");
    expect(h.controller.snapshot().loadingCandidates).toBe(true);
    h.setEnvironment("prod");
    await vi.waitFor(() => expect(h.controller.snapshot().candidates).toEqual([{ id: "candidate" }]));
    resolve({ items: [{ id: "private-dev-candidate" }] });
    await Promise.resolve();
    expect(h.controller.snapshot()).toMatchObject({
      environmentId: "prod", candidates: [{ id: "candidate" }], loadingCandidates: false,
    });
    expect(h.client.listPassiveLearningCandidates).toHaveBeenLastCalledWith("prod");
  });

  test("reports a read failure without losing saved candidates", async () => {
    const h = controllerHarness();
    h.controller.setWorkspace("learning");
    await vi.waitFor(() => expect(h.controller.snapshot().candidates).toHaveLength(1));
    h.client.listPassiveLearningCandidates.mockRejectedValueOnce(new Error("Candidate read failed"));
    await h.controller.refresh();
    expect(h.controller.snapshot()).toMatchObject({
      candidates: [{ id: "candidate" }], loadingCandidates: false, candidateError: "Candidate read failed",
    });
  });
});
