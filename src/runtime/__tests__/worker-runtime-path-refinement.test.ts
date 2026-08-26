import { describe, expect, test } from "vitest";

import type { RequestToolResultsView } from "../context/request-tool-results.js";
import {
  projectEffectiveWorkerSelectionControlIds,
  projectEligibleWorkerSessionArtifactPaths,
} from "../steps/worker-decision/runtime-path-refinement.js";

describe("Worker runtime path refinement", () => {
  test("bounds newest paths before exact current-result dedupe without backfill", () => {
    const sessionArtifactPaths = Object.freeze([
      "current.txt",
      "newest-1.txt",
      "newest-2.txt",
      "newest-3.txt",
      "newest-4.txt",
      "newest-5.txt",
      "newest-6.txt",
      "newest-7.txt",
      "older-8.txt",
      "older-9.txt",
    ]);
    const requestToolResults: RequestToolResultsView = Object.freeze({
      sourceRevision: 4,
      results: Object.freeze([
        Object.freeze({
          executionId: "capability-execution-current",
          callId: "call-2",
          invocationAttempt: 1,
          capabilityId: "example.current",
          declaredEffect: "observation" as const,
          outcome: "succeeded" as const,
          observedEffect: "observation" as const,
          summary: "The current result already carries one exact target.",
          references: Object.freeze([
            Object.freeze({
              kind: "tool_target" as const,
              target: "current.txt",
            }),
          ]),
        }),
      ]),
    });

    const eligible = projectEligibleWorkerSessionArtifactPaths(
      sessionArtifactPaths,
      requestToolResults,
    );

    expect(eligible).toEqual([
      "newest-1.txt",
      "newest-2.txt",
      "newest-3.txt",
      "newest-4.txt",
      "newest-5.txt",
      "newest-6.txt",
      "newest-7.txt",
    ]);
    expect(eligible).not.toContain("older-8.txt");
    expect(Object.isFrozen(eligible)).toBe(true);
  });

  test("removes only runtime paths and preserves the no-registry selection array", () => {
    const selectionControlIds = Object.freeze(["path", "mode"]);
    const descriptor = {
      selectionControlIds,
      runtimePathControlIds: Object.freeze(["path"]),
    };

    const baseline = projectEffectiveWorkerSelectionControlIds(
      descriptor,
      false,
    );
    const deferred = projectEffectiveWorkerSelectionControlIds(
      descriptor,
      true,
    );

    expect(baseline).toBe(selectionControlIds);
    expect(deferred).toEqual(["mode"]);
    expect(Object.isFrozen(deferred)).toBe(true);
  });
});
