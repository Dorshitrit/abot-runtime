import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module has no declaration surface.
import * as workspaceStates from "../../web-ui/app/components/schedules/workspace-state.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { scheduleErrorMessage } from "../../web-ui/app/lib/schedule-errors.js";

const { scheduleWorkspaceState, renderScheduleWorkspaceState } =
  workspaceStates;

const emptySnapshot = {
  jobs: [],
  sessions: [],
  editor: null,
  selectedId: "",
  error: "",
  loading: false,
};

describe("schedules page states", () => {
  test("failed initial read uses one error state with refresh instead of an empty list", () => {
    const state = scheduleWorkspaceState({
      ...emptySnapshot,
      error: "scheduler_store_in_use",
    });
    expect(state).toMatchObject({ kind: "error", action: "refresh" });
    expect(state.description).not.toContain("scheduler_store_in_use");
    expect(state.description).toBe(
      scheduleErrorMessage(new Error("scheduler_store_in_use")),
    );
  });

  test("empty workspace offers creation only when an existing conversation is available", () => {
    expect(scheduleWorkspaceState(emptySnapshot)).toMatchObject({
      kind: "empty",
      action: "chat",
    });
    expect(
      scheduleWorkspaceState({ ...emptySnapshot, sessions: [{ id: "one" }] }),
    ).toMatchObject({ kind: "empty", action: "create" });
  });

  test("loading and removed-job states do not claim the user has no schedules", () => {
    expect(
      scheduleWorkspaceState({ ...emptySnapshot, loading: true }),
    ).toMatchObject({ kind: "loading" });
    expect(
      scheduleWorkspaceState({ ...emptySnapshot, selectedId: "removed" }),
    ).toMatchObject({ kind: "missing", action: "refresh" });
  });

  test("a refresh failure keeps loaded jobs and unsaved editors on screen", () => {
    expect(
      scheduleWorkspaceState({
        ...emptySnapshot,
        jobs: [{ id: "one" }],
        error: "failed",
      }),
    ).toBeNull();
    expect(
      scheduleWorkspaceState({
        ...emptySnapshot,
        editor: { job: null },
        error: "failed",
      }),
    ).toBeNull();
  });

  test("renders escaped error evidence and binds only the presented state action", () => {
    let click: () => void = () => {};
    const root = {
      hidden: true,
      dataset: {},
      innerHTML: "",
      setAttribute: vi.fn(),
      querySelector: () => ({
        addEventListener: (_name: string, callback: () => void) => {
          click = callback;
        },
      }),
    };
    const actions = { refresh: vi.fn(), create: vi.fn() };
    renderScheduleWorkspaceState({
      root,
      state: {
        kind: "error",
        title: "Unavailable",
        description: "<script>ignored</script>",
        action: "refresh",
        actionLabel: "Refresh",
      },
      actions,
    });
    expect(root.hidden).toBe(false);
    expect(root.setAttribute).toHaveBeenCalledWith("role", "alert");
    expect(root.innerHTML).not.toContain("<script>");
    expect(root.innerHTML.match(/data-state-action/g)).toHaveLength(1);
    click();
    expect(actions.refresh).toHaveBeenCalledOnce();
    expect(actions.create).not.toHaveBeenCalled();
    renderScheduleWorkspaceState({ root, state: null, actions });
    expect(root.hidden).toBe(true);
  });
});

test("schedule error presentation retains actionable validation details and does not expose unknown machine identifiers", () => {
  expect(
    scheduleErrorMessage(
      new Error("scheduler_invalid_time: Choose an exact time."),
    ),
  ).toBe("Choose an exact time.");
  expect(
    scheduleErrorMessage(new Error("unexpected_internal_failure")),
  ).not.toContain("unexpected_internal_failure");
  expect(scheduleErrorMessage(new Error("The environment changed."))).toBe(
    "The environment changed.",
  );
  expect(scheduleErrorMessage("scheduler_model_unavailable")).not.toBe(
    scheduleErrorMessage("scheduler_job_cancelled"),
  );
});
