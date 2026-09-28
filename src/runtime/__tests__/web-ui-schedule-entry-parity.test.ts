import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module has no declaration surface.
import { createSchedulesController } from "../../web-ui/app/controllers/schedules-controller.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { matchesScheduleFilter } from "../../web-ui/app/lib/schedule-presentation.js";

function fixture(states: string[]) {
  let environmentId = "dev";
  const jobs = states.map((state, index) => ({
    id: `job-${index}`,
    state,
    title: state,
    sessionId: "session-1",
    schedule: { kind: "daily", at: "09:00" },
  }));
  const controller = createSchedulesController({
    getEnvironmentId: () => environmentId,
    client: {
      listSchedules: vi.fn(async () => ({ jobs })),
      listSessions: vi.fn(async () => ({ sessions: [{ id: "session-1" }] })),
      listModels: vi.fn(async () => ({ profiles: [] })),
      listScheduleRuns: vi.fn(async () => ({ runs: [] })),
    },
    render: vi.fn(),
    openConversation: vi.fn(),
    setTimer: vi.fn(),
    clearTimer: vi.fn(),
  });
  return {
    jobs, controller,
    setEnvironment: (value: string) => { environmentId = value; },
    visibleIds() {
      const snapshot = controller.snapshot();
      return snapshot.jobs.filter((job: typeof jobs[number]) =>
        matchesScheduleFilter(job, snapshot.query, snapshot.filter, snapshot.sessions),
      ).map((job: typeof jobs[number]) => job.id);
    },
    async enter() {
      controller.setActive(true);
      await vi.waitFor(() => expect(controller.snapshot().loading).toBe(false));
    },
  };
}

describe("schedule workspace entry parity", () => {
  test.each([
    { states: ["completed"] },
    { states: ["cancelled"] },
    { states: ["completed", "cancelled"] },
    { states: ["active", "paused", "completed", "cancelled"] },
  ])("rail entry and address restoration display the same saved jobs: $states", async ({ states }) => {
    const rail = fixture(states);
    await rail.enter();
    const restored = fixture(states);
    restored.controller.setActive(true);
    await restored.controller.openJob("");
    const expectedIds = rail.jobs.filter((job) => job.state === "active").map((job) => job.id);
    expect(rail.visibleIds()).toEqual(expectedIds);
    expect(restored.visibleIds()).toEqual(expectedIds);
    rail.controller.setActive(false);
    restored.controller.setActive(false);
  });

  test("retains an explicitly chosen Current filter on re-entry and resets a new environment to Active", async () => {
    const f = fixture(["completed", "active", "paused", "cancelled"]);
    await f.enter();
    f.controller.cancelEdit();
    await f.controller.filter("", "current");
    expect(f.visibleIds()).toEqual(["job-1", "job-2"]);
    f.controller.setActive(false);
    await f.enter();
    expect(f.visibleIds()).toEqual(["job-1", "job-2"]);
    f.setEnvironment("prod");
    await f.controller.load();
    expect(f.visibleIds()).toEqual(["job-1"]);
    expect(f.controller.snapshot()).toMatchObject({ environmentId: "prod", filter: "active" });
    f.controller.setActive(false);
  });
});
