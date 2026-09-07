import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Browser-only module has no declaration surface.
import { createDashboardFeature } from "../../web-ui/app/dashboard-feature.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { createSchedulesFeature } from "../../web-ui/app/schedules-feature.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { createSchedulesController } from "../../web-ui/app/controllers/schedules-controller.js";
import { scheduleFormInput } from "../../web-ui/app/components/schedules/form.js";

type Editor = {
  job: unknown;
  environmentId: string;
  initialValues: Record<string, unknown>;
};
const views = vi.hoisted(() => ({
  dashboardActions: undefined as
    | { createJob(templateId?: string): void }
    | undefined,
  scheduleActions: undefined as
    | { snapshot(): { editor: Editor | null } }
    | undefined,
}));
vi.mock("../../web-ui/app/components/dashboard/workspace.js", () => ({
  createDashboardWorkspace: ({
    actions,
  }: {
    actions: typeof views.dashboardActions;
  }) => {
    views.dashboardActions = actions;
    return { render: vi.fn(), composerHost: {} };
  },
}));
vi.mock("../../web-ui/app/components/schedules/workspace.js", () => ({
  createSchedulesWorkspace: ({
    actions,
  }: {
    actions: typeof views.scheduleActions;
  }) => {
    views.scheduleActions = actions;
    return { render: vi.fn(), prepareLeave: () => true };
  },
}));
afterEach(() => vi.unstubAllGlobals());

function clientFixture() {
  return {
    supportsSchedules: () => true,
    listSchedules: vi.fn(
      async (): Promise<{ jobs: { id: string }[] }> => ({ jobs: [] }),
    ),
    listSessions: vi.fn(async () => ({ sessions: [] })),
    listModels: vi.fn(async () => ({
      profiles: [{ id: "selected-model" }, { id: "default-model" }],
      defaultProfileId: "default-model",
    })),
    listScheduleRuns: vi.fn(async () => ({ runs: [] })),
    createSchedule: vi.fn(),
    updateSchedule: vi.fn(),
    scheduleAction: vi.fn(),
  };
}

function featureFixture(modelProfileId = "selected-model") {
  vi.stubGlobal("document", { addEventListener: vi.fn() });
  const client = clientFixture();
  const dom = {
    homeDashboardRoot: {},
    schedulesRoot: {},
    modelSelect: { value: modelProfileId },
    environmentSelect: { addEventListener: vi.fn() },
    schedulesWorkspaceButton: { hidden: false, disabled: false },
  };
  const shell = { activateWorkspace: vi.fn(() => true) };
  const schedules = createSchedulesFeature({
    dom,
    client,
    shell,
    selectedEnvironmentId: () => "dev",
    getCurrentSessionId: () => "",
    getAgentModes: () => ["fast", "reasoning", "deep"],
    openSession: vi.fn(),
  });
  createDashboardFeature({
    dom,
    state: { sessions: [] },
    client,
    shell,
    schedules,
    selectedEnvironmentId: () => "dev",
    loadSessions: vi.fn(),
    openSession: vi.fn(),
    isComposerAvailable: () => true,
  });
  return { client, shell };
}

describe("Dashboard Job drafts", () => {
  it("opens a template as a dedicated-conversation draft without creating a Job or conversation", async () => {
    const f = featureFixture();
    views.dashboardActions!.createJob("briefing");
    await vi.waitFor(() =>
      expect(views.scheduleActions!.snapshot().editor).not.toBeNull(),
    );
    expect(f.shell.activateWorkspace).toHaveBeenCalledWith("schedules");
    expect(views.scheduleActions!.snapshot().editor).toMatchObject({
      job: null,
      environmentId: "dev",
      initialValues: {
        newConversation: true,
        modelProfileId: "selected-model",
        agentMode: "reasoning",
        schedule: { kind: "daily", at: "08:00" },
      },
    });
    expect(f.client.createSchedule).not.toHaveBeenCalled();
    expect(f.client.updateSchedule).not.toHaveBeenCalled();
    expect(f.client.scheduleAction).not.toHaveBeenCalled();
  });

  it("uses the loaded environment model default for a blank Job when the composer has no selection", async () => {
    const f = featureFixture("");
    views.dashboardActions!.createJob();
    await vi.waitFor(() =>
      expect(views.scheduleActions!.snapshot().editor).not.toBeNull(),
    );
    expect(
      views.scheduleActions!.snapshot().editor!.initialValues,
    ).toMatchObject({
      newConversation: true,
      modelProfileId: "default-model",
    });
    expect(f.client.createSchedule).not.toHaveBeenCalled();
  });

  it("cannot open a stale template draft after an environment switch", async () => {
    const client = clientFixture();
    let finish!: (value: { jobs: { id: string }[] }) => void;
    client.listSchedules.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    let environmentId = "dev";
    const controller = createSchedulesController({
      client,
      getEnvironmentId: () => environmentId,
      render: vi.fn(),
      openConversation: vi.fn(),
      setTimer: vi.fn(),
      clearTimer: vi.fn(),
    });
    const pending = controller.openCreate({
      newConversation: true,
      title: "Old environment",
    });
    environmentId = "other";
    await controller.load();
    finish({ jobs: [] });
    await pending;
    expect(controller.snapshot().editor).toBeNull();
    expect(controller.snapshot().environmentId).toBe("other");
    expect(client.createSchedule).not.toHaveBeenCalled();
  });

  it("serializes the dedicated target only on Save and preserves existing conversation input", () => {
    const data = new FormData();
    data.set("sessionId", "__new_conversation__");
    data.set("title", "Daily news");
    data.set("prompt", "Read the news.");
    data.set("modelProfileId", "default-model");
    data.set("agentMode", "reasoning");
    data.set("timeZone", "UTC");
    data.set("kind", "daily");
    data.set("time", "08:00");
    const input = scheduleFormInput(data);
    expect(input).toMatchObject({
      newConversation: true,
      schedule: { kind: "daily", at: "08:00" },
    });
    expect(input).not.toHaveProperty("sessionId");
    data.set("sessionId", "existing");
    expect(scheduleFormInput(data)).toMatchObject({ sessionId: "existing" });
    expect(scheduleFormInput(data)).not.toHaveProperty("newConversation");
  });
});
