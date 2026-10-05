import { describe, expect, test, vi } from "vitest";
import { createRuntimeOnboardingController } from "../../web-ui/app/controllers/runtime-onboarding-controller.js";
import { createProjectsController } from "../../web-ui/app/controllers/projects-controller.js";
// @ts-expect-error Browser-only controller has no declaration surface.
import { createPassiveLearningController } from "../../web-ui/app/controllers/passive-learning-controller.js";
import { projectClient, project, deferredProjectResult } from "./support/projects-controller-fixture.js";

function onboardingDependents() {
  const state = { runtimeAvailability: { status: "loading" } };
  let applySetup: () => void | Promise<void> = () => {};
  const status = { state: "off", preferences: { enabled: false } };
  const client = {
    ...projectClient(),
    loadPassiveLearning: vi.fn(async () => ({ status })),
    getSystemHostConnection: vi.fn(async () => ({ paired: false, connected: false })),
  };
  const onboarding = createRuntimeOnboardingController({
    state,
    guide: {
      bind: (actions) => { applySetup = actions!.onApplied!; },
      render: vi.fn(),
      focusAction: vi.fn(),
    },
    reloadModels: async () => {
      onboarding.beginCatalogLoad();
      await Promise.resolve();
      onboarding.applyCatalog({
        profiles: [{ id: "default" }], availability: { status: "ready" },
      });
    },
    setMessageStatus: vi.fn(),
    onStateChange: () => {
      void projects.runtimeAvailabilityChanged();
      learning.runtimeAvailabilityChanged();
    },
  });
  const projects = createProjectsController({
    client,
    getEnvironmentId: () => "prod",
    isRuntimeReady: onboarding.isReady,
    getConversationRevision: () => "empty:0",
    prepareConversation: () => true,
    openSession: vi.fn(async () => {}),
    loadSessions: vi.fn(async () => {}),
    onChange: vi.fn(),
    notify: vi.fn(),
  });
  const learning = createPassiveLearningController({
    client,
    getEnvironmentId: () => "prod",
    isRuntimeReady: onboarding.isReady,
    isVisible: () => true,
    render: vi.fn(),
  });
  onboarding.bind();
  return { client, onboarding, projects, learning, applySetup: () => applySetup() };
}

describe("Onboarding readiness reaches independent Web UI feature state", () => {
  test("empty startup makes no premature requests and successful Apply refreshes Projects and SPARK without Embedding", async () => {
    const { client, onboarding, projects, learning, applySetup } = onboardingDependents();
    learning.setWorkspace("home");
    await projects.load();
    onboarding.applyCatalog({ profiles: [], availability: { status: "setup_required" } });
    await learning.refresh();
    expect(client.listProjects).not.toHaveBeenCalled();
    expect(client.loadPassiveLearning).not.toHaveBeenCalled();

    await applySetup();
    await vi.waitFor(() => {
      expect(client.listProjects).toHaveBeenCalledExactlyOnceWith("prod");
      expect(client.loadPassiveLearning).toHaveBeenCalledExactlyOnceWith("prod");
      expect(projects.snapshot()).toMatchObject({ loading: false, error: "", projects: [] });
      expect(learning.snapshot()).toMatchObject({
        loadingStatus: false, statusError: "", status: { state: "off" },
      });
    });
    expect(onboarding.isReady()).toBe(true);
    expect(client.getSystemHostConnection).toHaveBeenCalledOnce();
  });

  test("late failures from a previous ready phase cannot overwrite either refreshed feature", async () => {
    const { client, onboarding, projects, learning, applySetup } = onboardingDependents();
    const previousProjects = deferredProjectResult<{ projects: ReturnType<typeof project>[] }>();
    const previousLearning = deferredProjectResult<{
      status: { state: string; preferences: { enabled: boolean } };
    }>();
    client.listProjects.mockImplementationOnce(() => previousProjects.promise);
    client.loadPassiveLearning.mockImplementationOnce(() => previousLearning.promise);
    learning.setWorkspace("home");
    await applySetup();
    await vi.waitFor(() => {
      expect(client.listProjects).toHaveBeenCalledOnce();
      expect(client.loadPassiveLearning).toHaveBeenCalledOnce();
    });

    onboarding.beginCatalogLoad();
    client.listProjects.mockResolvedValue({ projects: [project("current-project")] });
    onboarding.applyCatalog({ profiles: [{ id: "default" }], availability: { status: "ready" } });
    await vi.waitFor(() => {
      expect(projects.snapshot().projects[0]?.id).toBe("current-project");
      expect(learning.snapshot().status?.state).toBe("off");
    });
    previousProjects.reject(new Error("requestRunner.configRef is required"));
    previousLearning.reject(new Error("passive_learning_unavailable"));
    await Promise.allSettled([previousProjects.promise, previousLearning.promise]);
    await Promise.resolve();
    expect(projects.snapshot().error).toBe("");
    expect(learning.snapshot().statusError).toBe("");
    expect(projects.snapshot().projects[0]?.id).toBe("current-project");
  });
});
