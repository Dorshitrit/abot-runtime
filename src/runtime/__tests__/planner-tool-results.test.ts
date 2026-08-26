import { describe, expect, test } from "vitest";

import type {
  RequestToolResult,
  RequestToolResultsView,
} from "../context/request-tool-results.js";
import { projectPlannerToolResults } from "../steps/planner-decision/tool-results.js";

function result(
  executionId: string,
  outcome: "succeeded" | "failed",
  ...targets: string[]
): RequestToolResult {
  return Object.freeze({
    executionId,
    callId: `call-${executionId}`,
    invocationAttempt: 1,
    capabilityId: "test.capability",
    declaredEffect: "mutation",
    outcome,
    observedEffect: outcome === "succeeded" ? "mutation" : "none",
    summary: `${executionId}:${outcome}`,
    ...(targets.length > 0
      ? {
          references: Object.freeze(
            targets.map((target) =>
              Object.freeze({ kind: "tool_target" as const, target }),
            ),
          ),
        }
      : {}),
  });
}

function view(...results: RequestToolResult[]): RequestToolResultsView {
  return Object.freeze({
    sourceRevision: 12,
    results: Object.freeze(results),
  });
}

describe("Planner tool-result projection", () => {
  test("retains only the successful retry for the same target", () => {
    const projection = projectPlannerToolResults(
      view(
        result("failed-first", "failed", "project/events.json"),
        result("successful-retry", "succeeded", "project/events.json"),
      ),
    );

    expect(
      projection.view.results.map(({ executionId }) => executionId),
    ).toEqual(["successful-retry"]);
    expect(projection).toMatchObject({
      sourceResultCount: 2,
      supersededResultCount: 1,
      retainedFailedResultCount: 0,
      retainedUntargetedResultCount: 0,
    });
  });

  test("retains a later failure as the current target state", () => {
    const projection = projectPlannerToolResults(
      view(
        result("successful-first", "succeeded", "project/events.json"),
        result("failed-last", "failed", "project/events.json"),
      ),
    );

    expect(projection.view.results).toEqual([
      expect.objectContaining({
        executionId: "failed-last",
        outcome: "failed",
      }),
    ]);
    expect(projection.retainedFailedResultCount).toBe(1);
  });

  test("keeps different targets and untargeted results in canonical order", () => {
    const projection = projectPlannerToolResults(
      view(
        result("failed-css", "failed", "project/style.css"),
        result("untargeted-observation", "succeeded"),
        result("successful-html", "succeeded", "project/index.html"),
      ),
    );

    expect(
      projection.view.results.map(({ executionId }) => executionId),
    ).toEqual(["failed-css", "untargeted-observation", "successful-html"]);
    expect(projection).toMatchObject({
      supersededResultCount: 0,
      retainedFailedResultCount: 1,
      retainedUntargetedResultCount: 1,
    });
  });

  test("retains a multi-target result while it is current for any target", () => {
    const projection = projectPlannerToolResults(
      view(
        result(
          "multi-target",
          "succeeded",
          "project/index.html",
          "project/style.css",
        ),
        result("newer-css", "succeeded", "project/style.css"),
      ),
    );

    expect(
      projection.view.results.map(({ executionId }) => executionId),
    ).toEqual(["multi-target", "newer-css"]);
  });
});
