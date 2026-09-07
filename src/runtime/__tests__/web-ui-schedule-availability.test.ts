import { afterEach, describe, expect, test, vi } from "vitest";
import { createRuntimeWebClient } from "../../web-ui/app/services/runtime-web-client.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { createSchedulesFeature } from "../../web-ui/app/schedules-feature.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { createWorkspaceShell } from "../../web-ui/app/components/workspace-shell.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { createConversationSchedule } from "../../web-ui/app/components/conversation-schedule.js";
import { createWorkspaceShellHarness } from "./support/workspace-shell-harness.js";
import { ContextElement } from "./support/composer-context-window-dom.js";

vi.mock("../../web-ui/app/components/schedules/workspace.js", () => ({
  createSchedulesWorkspace: () => ({
    render: vi.fn(),
    prepareLeave: () => true,
  }),
}));
afterEach(() => vi.useRealTimers());

function createAvailabilityFixture(backend: string | undefined) {
  vi.useFakeTimers();
  let config = backend ? { backend } : null;
  const fetchImpl = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          jobs: [],
          sessions: [],
          profiles: [],
          runs: [],
        }),
      ),
  );
  const client = createRuntimeWebClient({
    getConfig: () => config,
    getEnvironmentId: () => "dev",
    fetchImpl,
    origin: "http://localhost",
  });
  const harness = createWorkspaceShellHarness();
  let feature: ReturnType<typeof createSchedulesFeature>;
  const shell = createWorkspaceShell({
    ...harness,
    isWorkspaceAvailable: (destination: string) =>
      feature.isWorkspaceAvailable(destination),
    onWorkspaceChange: (workspace: string) =>
      feature.setActive(workspace === "schedules"),
  });
  feature = createSchedulesFeature({
    dom: { ...harness.dom, environmentSelect: { addEventListener: vi.fn() } },
    client,
    shell,
    selectedEnvironmentId: () => "dev",
    getCurrentSessionId: () => "session",
    getAgentModes: () => ["reasoning"],
    openSession: vi.fn(),
  });
  shell.bind();
  shell.load();
  return {
    client,
    feature,
    shell,
    fetchImpl,
    ...harness,
    setBackend(value: string) {
      config = { backend: value };
      feature.refreshAvailability();
    },
  };
}

describe("native schedule backend availability", () => {
  test.each(["bridge", undefined])(
    "%s hides and blocks schedule navigation without any schedule requests",
    async (backend) => {
      const fixture = createAvailabilityFixture(backend);
      const { dom, feature, shell, fetchImpl } = fixture;
      expect(dom.schedulesWorkspaceButton.hidden).toBe(true);
      expect(dom.schedulesWorkspaceButton.disabled).toBe(true);
      expect(shell.activateWorkspace("schedules")).toBe(false);
      expect(shell.prepareWorkspaceActivation("schedules")).toBeNull();
      dom.schedulesWorkspaceButton.dispatch("click");
      feature.openJob("historical-job");
      feature.setActive(true);
      await Promise.resolve();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(dom.schedulesWorkspacePanel.hidden).toBe(true);
      expect(shell.activateWorkspace("config")).toBe(true);
      expect(dom.configWorkspacePanel.hidden).toBe(false);
      expect(shell.activateWorkspace("chat")).toBe(true);
      expect(dom.chatPanel.hidden).toBe(false);
    },
  );

  test("native runtime enables the workspace after bootstrap and preserves its scoped requests", async () => {
    const { dom, shell, setBackend, fetchImpl } =
      createAvailabilityFixture(undefined);
    setBackend("runtime");
    expect(dom.schedulesWorkspaceButton.hidden).toBe(false);
    expect(dom.schedulesWorkspaceButton.disabled).toBe(false);
    expect(shell.activateWorkspace("schedules")).toBe(true);
    await vi.waitFor(() =>
      expect(fetchImpl).toHaveBeenCalledWith(
        "/web-api/schedules?environment=dev",
        expect.anything(),
      ),
    );
    expect(dom.schedulesWorkspacePanel.hidden).toBe(false);
    shell.activateWorkspace("chat");
  });

  test("a prepared navigation cannot activate schedules after backend availability changed", () => {
    const { shell, setBackend, dom } = createAvailabilityFixture("runtime");
    const commit = shell.prepareWorkspaceActivation("schedules");
    setBackend("bridge");
    expect(commit()).toBe(false);
    expect(dom.homeWorkspacePanel.hidden).toBe(false);
    expect(dom.chatPanel.hidden).toBe(true);
    expect(dom.schedulesWorkspacePanel.hidden).toBe(true);
  });

  test("every bridge schedule client operation fails locally while ordinary requests remain usable", async () => {
    const { client, fetchImpl } = createAvailabilityFixture("bridge");
    const operations = [
      () => client.listSchedules(),
      () => client.getSchedule("job"),
      () => client.listScheduleRuns("job"),
      () =>
        client.createSchedule({
          sessionId: "session",
          title: "Daily",
          prompt: "Daily task",
          modelProfileId: "model",
          agentMode: "reasoning",
          timeZone: "UTC",
          schedule: { kind: "daily", at: "09:00" },
        }),
      () => client.updateSchedule("job", {}),
      () => client.scheduleAction("job", "pause"),
    ];
    for (const operation of operations)
      await expect(operation()).rejects.toThrow(
        "Schedules require the local Runtime backend.",
      );
    expect(fetchImpl).not.toHaveBeenCalled();
    await client.listSessions();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  test("historical cards keep their prompt but disable unavailable Job links", () => {
    const open = vi.fn();
    const card = createConversationSchedule({
      documentRoot: { createElement: (tag: string) => new ContextElement(tag) },
      onOpenJob: open,
      canOpenJob: () => false,
    }).createNode({
      role: "user",
      text: "Original historical prompt",
      schedule: {
        jobId: "job",
        runId: "run",
        title: "Historical job",
      },
    });
    const button = card.querySelector("button");
    expect(button.disabled).toBe(true);
    button.dispatch("click");
    expect(open).not.toHaveBeenCalled();
    expect(card.querySelector("pre").textContent).toBe(
      "Original historical prompt",
    );
  });
});
