import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module has no declaration surface.
import { createSchedulesController } from "../../web-ui/app/controllers/schedules-controller.js";
import {
  scheduleFormInput,
  scheduleUpdateInput,
} from "../../web-ui/app/components/schedules/form.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { createScheduleRequests } from "../../web-ui/app/services/runtime-web-client/schedules.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

function scheduleClient() {
  return {
    listSchedules: vi.fn(
      async (
        _environmentId: string,
      ): Promise<{ jobs: { id: string; title?: string }[] }> => ({
        jobs: [{ id: "job-1", title: "Task" }],
      }),
    ),
    listSessions: vi.fn(async () => ({ sessions: [{ id: "session-1" }] })),
    listModels: vi.fn(async () => ({ profiles: [{ id: "model-1" }] })),
    listScheduleRuns: vi.fn(async () => ({ runs: [{ id: "run-1" }] })),
    createSchedule: vi.fn(async () => ({ job: { id: "job-created" } })),
    updateSchedule: vi.fn(async () => ({ job: { id: "job-1" } })),
    scheduleAction: vi.fn(async () => ({})),
  };
}

describe("schedules management", () => {
  test("metadata-only edits preserve the exact stored recurrence and anchor", () => {
    const initial = {
      sessionId: "session-1",
      title: "Old",
      prompt: "Original",
      modelProfileId: "model-1",
      timeZone: "Asia/Jerusalem",
      schedule: {
        kind: "interval",
        everyMs: 7200000,
        anchorAt: "2026-09-08T06:10:32Z",
      },
    };
    expect(
      scheduleUpdateInput(
        { ...initial, title: "New", modelProfileId: "model-2" },
        initial,
      ),
    ).toEqual({ title: "New", modelProfileId: "model-2" });
  });

  test("loads all environment conversations and uses the same management client for save and actions", async () => {
    const client = scheduleClient();
    const controller = createSchedulesController({
      client,
      getEnvironmentId: () => "dev",
      render: vi.fn(),
      openConversation: vi.fn(),
    });
    await controller.load();
    expect(controller.snapshot().jobs).toHaveLength(1);
    controller.beginEdit();
    await controller.save({
      sessionId: "session-1",
      modelProfileId: "model-1",
      title: "Task",
    });
    expect(client.createSchedule).toHaveBeenCalledWith(
      { sessionId: "session-1", modelProfileId: "model-1", title: "Task" },
      "dev",
    );
    expect(controller.snapshot().editor).toBeNull();
    await controller.action("job-1", "pause");
    expect(client.scheduleAction).toHaveBeenCalledWith("job-1", "pause", "dev");
  });

  test("late reads cannot expose jobs from the previous environment", async () => {
    let resolveOld!: (value: { jobs: { id: string }[] }) => void;
    let environmentId = "old";
    const client = scheduleClient();
    client.listSchedules = vi.fn((id: string) =>
      id === "old"
        ? new Promise((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve({ jobs: [{ id: "new-job" }] }),
    ) as typeof client.listSchedules;
    const controller = createSchedulesController({
      client,
      getEnvironmentId: () => environmentId,
      render: vi.fn(),
      openConversation: vi.fn(),
    });
    const oldRead = controller.load();
    environmentId = "new";
    await controller.load();
    resolveOld({ jobs: [{ id: "old-job" }] });
    await oldRead;
    expect(controller.snapshot().jobs).toEqual([{ id: "new-job" }]);
  });

  test("save failure retains the editor and action failure is visible", async () => {
    const client = scheduleClient();
    client.createSchedule.mockRejectedValue(new Error("Exact time required"));
    client.scheduleAction.mockRejectedValue(new Error("Job was cancelled"));
    const controller = createSchedulesController({
      client,
      getEnvironmentId: () => "dev",
      render: vi.fn(),
      openConversation: vi.fn(),
    });
    await controller.load();
    controller.beginEdit();
    await expect(controller.save({})).rejects.toThrow("Exact time required");
    expect(controller.snapshot().editor).not.toBeNull();
    await controller.action("job-1", "run-now");
    expect(controller.snapshot().error).toBe("Job was cancelled");
  });

  test("weekday form preserves multiple days and requires an exact hour", () => {
    const data = new FormData();
    data.set("kind", "weekly");
    data.set("time", "09:00");
    data.append("weekdays", "3");
    data.append("weekdays", "6");
    data.set("timeZone", "Asia/Jerusalem");
    data.set("modelProfileId", "selected-model");
    expect(scheduleFormInput(data)).toMatchObject({
      modelProfileId: "selected-model",
      timeZone: "Asia/Jerusalem",
      schedule: { kind: "weekly", at: "09:00", weekdays: [3, 6] },
    });
    data.set("time", "");
    expect(() => scheduleFormInput(data)).toThrow("exact time");
    data.set("kind", "once");
    expect(() => scheduleFormInput(data)).toThrow("exact date and time");
  });

  test("transport scopes each operation by environment and encodes job identity", async () => {
    const requestApi = vi.fn(async () => ({}));
    const client = createScheduleRequests({
      requestApi,
      getEnvironmentId: () => "dev / one",
      getConfig: () => ({ backend: "runtime" }),
    });
    await client.updateSchedule("job/a", { title: "New title" });
    expect(requestApi).toHaveBeenCalledWith(
      "/schedules/job%2Fa?environment=dev%20%2F%20one",
      { method: "PATCH", body: '{"title":"New title"}' },
    );
    await client.scheduleAction("job/a", "cancel", "other");
    expect(requestApi).toHaveBeenLastCalledWith(
      "/schedules/job%2Fa/cancel?environment=other",
      { method: "POST", body: "{}" },
    );
  });
});

describe("scheduled conversation lifecycle", () => {
  const trigger = {
    type: "event",
    name: "schedule.triggered",
    environment: "dev",
    sessionId: "session-1",
    requestId: "scheduled-request",
    messageId: "message-trigger",
    text: "Historical invocation",
    schedule: {
      jobId: "job-1",
      runId: "run-1",
      title: "Morning task",
      scheduledAt: "2026-09-07T06:00:00Z",
      triggerType: "schedule",
    },
  };

  test("accepts an autonomous trigger exactly once, then streams and finishes its normal assistant answer", () => {
    const { state, realtime } = createPlanLifecycleHarness();
    state.activeRequestId = "";
    state.messages = [];
    state.requestMessages.clear();
    realtime.handle(trigger);
    realtime.handle(trigger);
    expect(state.activeRequestId).toBe("scheduled-request");
    expect(
      state.messages.filter((message) => message.role === "user"),
    ).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      id: "message-trigger",
      text: "Historical invocation",
      schedule: { runId: "run-1" },
    });
    realtime.handle({
      type: "token",
      sessionId: "session-1",
      requestId: "scheduled-request",
      text: "Answer",
    });
    realtime.handle({
      type: "completed",
      sessionId: "session-1",
      requestId: "scheduled-request",
      output: "Answer",
    });
    expect(state.messages[1]).toMatchObject({
      role: "assistant",
      text: "Answer",
      streaming: false,
    });
    expect(state.activeRequestId).toBe("");
    realtime.handle(trigger);
    expect(state.activeRequestId).toBe("");
    expect(state.messages).toHaveLength(2);
  });

  test.each([
    { sessionId: "deleted-session" },
    { environment: "other" },
    { schedule: {} },
  ])("rejects unrelated or malformed autonomous triggers: %j", (changes) => {
    const { state, realtime } = createPlanLifecycleHarness();
    state.activeRequestId = "";
    const messagesBefore = structuredClone(state.messages);
    realtime.handle({ ...trigger, ...changes });
    expect(state.messages).toEqual(messagesBefore);
    expect(state.activeRequestId).toBe("");
  });
});
