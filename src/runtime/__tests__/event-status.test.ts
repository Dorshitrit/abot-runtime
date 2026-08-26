import { describe, expect, test } from "vitest";

import { enrichEventPayload } from "../events/event-status.js";

describe("enrichEventPayload", () => {
  test("adds readable status for context compaction lifecycle events", () => {
    expect(
      enrichEventPayload({
        type: "event",
        name: "context.compaction.started",
        phase: "started",
      }),
    ).toMatchObject({
      status: "Compacting context...",
    });
    expect(
      enrichEventPayload({
        type: "event",
        name: "context.compaction.completed",
        phase: "completed",
      }),
    ).toMatchObject({
      status: "Context compacted",
    });
    expect(
      enrichEventPayload({
        type: "event",
        name: "context.compaction.failed",
        phase: "failed",
      }),
    ).toMatchObject({
      status: "Context compaction failed",
    });
  });

  test("keeps thinking event identity and tokens without duplicate display status", () => {
    const thinking = enrichEventPayload({
      type: "event",
      requestId: "r1",
      name: "thinking.delta",
      delta: "work",
      text: "working",
    });

    expect(thinking.name).toBe("thinking.delta");
    expect(thinking.delta).toBe("work");
    expect(thinking.text).toBe("working");
    expect(thinking).not.toHaveProperty("status");
    expect(thinking).not.toHaveProperty("message");

    const completed = enrichEventPayload({
      type: "event",
      requestId: "r1",
      name: "thinking.completed",
    });

    expect(completed.name).toBe("thinking.completed");
    expect(completed).not.toHaveProperty("status");
    expect(completed).not.toHaveProperty("message");
  });

  test("adds generic manifest-derived tool status text", () => {
    const started = enrichEventPayload({
      type: "event",
      requestId: "r1",
      name: "tool.started",
      tool: "web_search",
    });
    expect(started.status).toBe("Web Search: started");
    expect(started.message).toBe("Web Search...");

    const completed = enrichEventPayload({
      type: "event",
      requestId: "r1",
      name: "tool.completed",
      tool: "web_search",
      ok: true,
    });
    expect(completed.status).toBe("Web Search: complete");
  });

  test("preserves explicit tool-start status text", () => {
    const started = enrichEventPayload({
      type: "event",
      requestId: "r1",
      name: "tool.started",
      tool: "read_file",
      status: "Read File: queued",
      message: "Read File queued",
    });

    expect(started.status).toBe("Read File: queued");
    expect(started.message).toBe("Read File queued");
  });

  test("adds readable status for payload generation events", () => {
    const started = enrichEventPayload({
      type: "event",
      requestId: "r1",
      name: "tool.payload.started",
      tool: "write_file",
    });
    expect(started.status).toBe("Write File: generating payload");
    expect(started.message).toBe("Write File: Generating payload...");

    const completed = enrichEventPayload({
      type: "event",
      requestId: "r1",
      name: "tool.payload.completed",
      tool: "write_file",
    });
    expect(completed.status).toBe("Write File: payload ready");

    const failed = enrichEventPayload({
      type: "event",
      requestId: "r1",
      name: "tool.payload.failed",
      tool: "write_file",
    });
    expect(failed.status).toBe("Write File: payload failed");
  });

  test("uses the visible event title for planner plan progress", () => {
    const created = enrichEventPayload({
      type: "event",
      requestId: "r1",
      name: "planner.plan.created",
      plan: {
        summary: "Complete the requested deliverables.",
        total: 2,
        completed: 1,
        pending: 1,
        items: [
          { id: "plan-source", title: "Create source module", status: "done" },
          { id: "plan-verify", title: "Run verification", status: "pending" },
        ],
      },
    });

    expect(created.name).toBe("Planner plan: 1/2 complete");
    expect(created).not.toHaveProperty("status");
    expect(created).not.toHaveProperty("message");
    expect(created.plan).toEqual({
      summary: "Complete the requested deliverables.",
      total: 2,
      completed: 1,
      pending: 1,
      items: [
        { id: "plan-source", title: "Create source module", status: "done" },
        { id: "plan-verify", title: "Run verification", status: "pending" },
      ],
    });
  });

  test("uses a separate visible event title for development progress", () => {
    const updated = enrichEventPayload({
      type: "event",
      requestId: "r1",
      name: "development.progress.updated",
      plan: {
        summary: "Complete the requested deliverables.",
        total: 2,
        completed: 1,
        pending: 1,
        items: [
          { id: "plan-source", title: "Create source module", status: "done" },
          { id: "plan-verify", title: "Run verification", status: "pending" },
        ],
      },
    });

    expect(updated.name).toBe("Development progress: 1/2 complete");
    expect(updated).not.toHaveProperty("status");
    expect(updated).not.toHaveProperty("message");
  });

  test("uses visible titles for planner plan item events", () => {
    const planned = enrichEventPayload({
      type: "event",
      requestId: "r1",
      name: "planner.plan.item.planned",
      item: {
        id: "plan-source",
        title: "Create source module",
        status: "pending",
        order: 1,
        total: 2,
      },
    });
    expect(planned.name).toBe("Planner planned: Create source module");
    expect(planned).not.toHaveProperty("status");

    const completed = enrichEventPayload({
      type: "event",
      requestId: "r1",
      name: "planner.plan.item.completed",
      item: {
        id: "plan-source",
        title: "Create source module",
        status: "done",
      },
      planItemOrder: 1,
      planItemTotal: 2,
    });
    expect(completed.name).toBe("Planner completed: Create source module");

    const blocked = enrichEventPayload({
      type: "event",
      requestId: "r1",
      name: "planner.plan.item.blocked",
      item: {
        id: "plan-source",
        title: "Create source module",
        status: "blocked",
      },
      planItemOrder: 1,
      planItemTotal: 2,
    });
    expect(blocked.name).toBe("Planner blocked: Create source module");
  });

  test("renders exec action lines in tool completion message", () => {
    const completed = enrichEventPayload({
      type: "event",
      requestId: "r1",
      name: "tool.completed",
      tool: "exec",
      ok: true,
      actions: [
        { type: "mkdir", target: "my_test_project" },
        { type: "write_file", target: "index.html" },
      ],
    });

    expect(completed.status).toBe("Exec: complete");
    expect(completed.message).toBe(
      "Exec complete\ncreated folder: my_test_project\nwrite file: index.html",
    );
  });

  test("renders runtime capability action paths through the existing tool status contract", () => {
    const completed = enrichEventPayload({
      type: "event",
      requestId: "r1",
      name: "tool.completed",
      tool: "edit_file",
      ok: true,
      actions: [
        { type: "refine_target", target: "neutral-project/src/app.ts" },
      ],
      meta: {
        path: "neutral-project/src/app.ts",
        operation: "replace_file",
      },
    });

    expect(completed.status).toBe("Edit File: complete");
    expect(completed.message).toBe(
      "Edit File complete\nupdated target: neutral-project/src/app.ts",
    );
    expect(completed.meta).toEqual({
      path: "neutral-project/src/app.ts",
      operation: "replace_file",
    });
  });

  test("renders a generic tool-supplied completion summary", () => {
    const completed = enrichEventPayload({
      type: "event",
      requestId: "r1",
      name: "tool.completed",
      tool: "example_action",
      ok: true,
      meta: {
        displaySummary: "Example action completed with owned metadata.",
        record: {
          id: "example-1",
        },
      },
    });

    expect(completed.status).toBe("Example Action: complete");
    expect(completed.message).toBe(
      "Example Action complete\nExample action completed with owned metadata.",
    );
    expect(completed.meta).toEqual({
      displaySummary: "Example action completed with owned metadata.",
      record: {
        id: "example-1",
      },
    });
  });

  test("adds readable status for task-progress runtime state", () => {
    const summarizing = enrichEventPayload({
      type: "event",
      requestId: "r1",
      name: "runtime.state",
      stage: "task_progress",
      phase: "summarizing",
    });
    expect(summarizing.name).toBe("Checking task progress...");
    expect(summarizing).not.toHaveProperty("status");
    expect(summarizing).not.toHaveProperty("message");
    expect(String(summarizing.name)).not.toContain("\n");

    const completed = enrichEventPayload({
      type: "event",
      requestId: "r1",
      name: "runtime.state",
      stage: "task_progress",
      phase: "completed",
    });
    expect(completed.name).toBe("Task progress updated");
    expect(completed).not.toHaveProperty("status");
  });

  test("adds readable status for completion-review runtime state", () => {
    const cases = [
      ["started", "Reviewing completed work..."],
      ["passed", "Completion review passed"],
      ["gaps_found", "Completion review found gaps"],
      ["limit_reached", "Completion review limit reached"],
    ] as const;

    for (const [phase, title] of cases) {
      const event = enrichEventPayload({
        type: "event",
        requestId: "r-review",
        name: "runtime.state",
        stage: "planned_work_review",
        phase,
        round: 1,
        maxRounds: 3,
      });

      expect(event.name).toBe(title);
      expect(event).not.toHaveProperty("status");
      expect(event).not.toHaveProperty("message");
    }
  });

  test("adds readable status for tool-loop runtime state", () => {
    const postTool = enrichEventPayload({
      type: "event",
      requestId: "r1",
      name: "runtime.state",
      stage: "tool_loop",
      phase: "post_tool",
    });

    expect(postTool.name).toBe("Checking the latest tool result...");
    expect(postTool).not.toHaveProperty("status");

    const preTool = enrichEventPayload({
      type: "event",
      requestId: "r1",
      name: "runtime.state",
      stage: "tool_loop",
      phase: "pre_tool",
      toolIteration: 0,
      decisionAttemptCount: 1,
    });

    expect(preTool.name).toBe("Choosing the next action...");
  });

  test("adds readable status for non-tool runtime stages", () => {
    const contextBuild = enrichEventPayload({
      type: "event",
      requestId: "r1",
      name: "runtime.state",
      stage: "context_build",
    });

    expect(contextBuild.name).toBe("Preparing context...");
    expect(contextBuild).not.toHaveProperty("status");
  });

  test("adds readable status for recovery runtime stages", () => {
    const strictRetry = enrichEventPayload({
      type: "event",
      requestId: "r1",
      name: "runtime.state",
      stage: "decision_recovery",
      phase: "strict_retry",
      reason: "post_tool",
      toolIteration: 2,
      decisionAttemptCount: 3,
    });
    expect(strictRetry.name).toBe("Retrying with stricter instructions...");
    expect(strictRetry).not.toHaveProperty("status");
    expect(String(strictRetry.name)).not.toContain("\n");

    const loopRecovery = enrichEventPayload({
      type: "event",
      requestId: "r1",
      name: "runtime.state",
      stage: "loop_recovery",
      phase: "recap",
    });
    expect(loopRecovery.name).toBe("Recovering task context...");
    expect(loopRecovery).not.toHaveProperty("status");
  });

  test("adds readable status for runtime degraded state", () => {
    const degraded = enrichEventPayload({
      type: "event",
      requestId: "r1",
      name: "runtime.state",
      stage: "runtime_degraded",
      reason: "no_progress",
    });

    expect(degraded.name).toBe("Work paused");
    expect(degraded).not.toHaveProperty("status");
    expect(degraded).not.toHaveProperty("message");
    expect(String(degraded.name)).not.toContain("\n");
  });

  test("keeps non-event payload unchanged", () => {
    const input = { type: "completed", requestId: "r1", output: "hello" };
    expect(enrichEventPayload(input)).toEqual(input);
  });
});
