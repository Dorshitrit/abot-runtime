import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module has no declaration surface.
import { scheduleListJobs } from "../../web-ui/app/lib/schedule-presentation.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { renderScheduleDetails } from "../../web-ui/app/components/schedules/details.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { renderScheduleWorkspaceState } from "../../web-ui/app/components/schedules/workspace-state.js";

class ScheduleRegion {
  private markup = "";
  writes = 0;
  firstChild: object | null = null;
  button = Object.assign(new EventTarget(), { dataset: { jobAction: "edit" } });
  ownerDocument = { activeElement: null };
  classList = { add: vi.fn(), remove: vi.fn() };
  dataset = {};
  hidden = false;
  scrollTop = 0;
  scrollLeft = 0;
  setAttribute = vi.fn();
  contains = () => false;

  get innerHTML() {
    return this.markup;
  }
  set innerHTML(value: string) {
    this.markup = value;
    this.writes += 1;
    this.firstChild = {};
    this.button = Object.assign(new EventTarget(), {
      dataset: { jobAction: "edit" },
    });
  }
  querySelectorAll(selector: string) {
    return selector === "[data-job-action]" ? [this.button] : [];
  }
  querySelector() {
    return this.button;
  }
}

const job = {
  id: "job",
  title: "Morning task",
  state: "active",
  sessionId: "session",
  modelProfileId: "model",
  agentMode: "reasoning",
  timeZone: "UTC",
  revision: 1,
  schedule: { kind: "daily", at: "09:00" },
  prompt: "Prepare notes",
};
const snapshot = {
  jobs: [job],
  selectedId: job.id,
  sessions: [],
  runs: [],
  loadingRuns: false,
  runsPreviousCursors: [],
  runsCursor: null,
  detailError: "",
  mutation: "",
};
function actions() {
  return {
    beginEdit: vi.fn(),
    action: vi.fn(),
    openConversation: vi.fn(),
    latestRuns: vi.fn(),
    newerRuns: vi.fn(),
    olderRuns: vi.fn(),
  };
}

const listJobs = Object.freeze([
  { ...job, id: "paused-first", state: "paused" },
  { ...job, id: "active-first", state: "active" },
  { ...job, id: "completed", state: "completed" },
  { ...job, id: "active-second", state: "active", sessionId: "other" },
  { ...job, id: "paused-second", state: "paused", sessionId: "other" },
  { ...job, id: "cancelled", state: "cancelled" },
]);

describe("schedule render stability", () => {
  test("keeps active jobs first while preserving both groups and the source order", () => {
    const original = [...listJobs];
    const visible = scheduleListJobs(listJobs, "", "all");

    expect(visible.map((item: typeof job) => item.id)).toEqual([
      "active-first",
      "active-second",
      "paused-first",
      "completed",
      "paused-second",
      "cancelled",
    ]);
    expect(listJobs).toEqual(original);
    for (const item of visible) expect(listJobs).toContain(item);
    expect(scheduleListJobs([], "", "all")).toEqual([]);
  });

  test("orders only matching jobs without broadening status or conversation search", () => {
    const sessions = [{ id: "other", title: "Weekly notes" }];
    const visibleIds = (query: string, filter: string) =>
      scheduleListJobs(listJobs, query, filter, sessions).map(
        (item: typeof job) => item.id,
      );

    expect(visibleIds("", "current")).toEqual([
      "active-first",
      "active-second",
      "paused-first",
      "paused-second",
    ]);
    expect(visibleIds("", "paused")).toEqual(["paused-first", "paused-second"]);
    expect(visibleIds("", "completed")).toEqual(["completed"]);
    expect(visibleIds("weekly", "all")).toEqual([
      "active-second",
      "paused-second",
    ]);
    expect(visibleIds("weekly", "active")).toEqual(["active-second"]);
    expect(visibleIds("absent", "all")).toEqual([]);
  });

  test("unchanged details retain their nodes and do not accumulate action listeners", () => {
    const root = new ScheduleRegion();
    const callbacks = actions();
    renderScheduleDetails({ root, snapshot, actions: callbacks });
    const initialChild = root.firstChild;
    const edit = root.button;
    for (let i = 0; i < 3; i++) {
      renderScheduleDetails({
        root,
        snapshot: { ...snapshot, jobs: [{ ...job }] },
        actions: callbacks,
      });
    }
    expect(root.writes).toBe(1);
    expect(root.firstChild).toBe(initialChild);
    edit.dispatchEvent(new Event("click"));
    expect(callbacks.beginEdit).toHaveBeenCalledExactlyOnceWith("job");
    renderScheduleDetails({
      root,
      snapshot: { ...snapshot, jobs: [{ ...job, title: "Updated task" }] },
      actions: callbacks,
    });
    expect(root.writes).toBe(2);
    expect(root.firstChild).not.toBe(initialChild);
    expect(root.innerHTML).toContain("Updated task");
  });

  test("restores read-only details when a cancelled editor replaced the same region", () => {
    const root = new ScheduleRegion();
    const callbacks = actions();
    renderScheduleDetails({ root, snapshot, actions: callbacks });
    root.innerHTML = '<form class="schedule-editor">Unsaved editor</form>';
    renderScheduleDetails({ root, snapshot, actions: callbacks });
    expect(root.writes).toBe(3);
    expect(root.innerHTML).toContain("Morning task");
    expect(root.innerHTML).not.toContain("schedule-editor");
  });

  test("unchanged empty states retain the action node and bind one click handler", () => {
    const root = new ScheduleRegion();
    const callbacks = { refresh: vi.fn() };
    const state = {
      kind: "error",
      title: "Unavailable",
      description: "Try again",
      action: "refresh",
      actionLabel: "Refresh",
    };
    renderScheduleWorkspaceState({ root, state, actions: callbacks });
    const retry = root.button;
    renderScheduleWorkspaceState({
      root,
      state: { ...state },
      actions: callbacks,
    });
    renderScheduleWorkspaceState({ root, state: null, actions: callbacks });
    renderScheduleWorkspaceState({
      root,
      state: { ...state },
      actions: callbacks,
    });
    expect(root.writes).toBe(1);
    expect(root.button).toBe(retry);
    retry.dispatchEvent(new Event("click"));
    expect(callbacks.refresh).toHaveBeenCalledOnce();
  });
});
