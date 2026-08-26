import { describe, expect, test, vi } from "vitest";

import {
  buildSessionArtifactPathsMessage,
  SESSION_ARTIFACT_PATHS_MESSAGE_KIND,
  type SessionArtifactPathsCapsule,
} from "../context/session-artifact-paths.js";

describe("session artifact path context", () => {
  test("projects settled tool targets verbatim as a passive system reference", () => {
    const targets = Object.freeze([
      "news/news.txt",
      "/runtime/agent-work/project/notes/final.md",
    ]);

    const projection = buildSessionArtifactPathsMessage({
      targets,
      applicable: true,
      fits: () => true,
    });

    expect(projection).toBeDefined();
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection!.message)).toBe(true);
    expect(projection).toMatchObject({
      availableCount: 2,
      projectedCount: 2,
      omittedCount: 0,
      message: { role: "system" },
    });
    const capsule = JSON.parse(
      projection!.message.content,
    ) as SessionArtifactPathsCapsule;
    expect(capsule).toEqual({
      kind: SESSION_ARTIFACT_PATHS_MESSAGE_KIND,
      category: "request_reference",
      authority: "canonical_runtime_state",
      provenance: "settled_successful_tool_target_references",
      purpose: "passive_tool_target_continuity_reference",
      representation: "verbatim_settled_tool_target",
      applicability:
        "selected_capability_runtime_path_control_authoring_refinement_only",
      nonAuthority: {
        addsUserIntent: false,
        addsPendingWork: false,
        choosesOrRedirectsTarget: false,
        provesTargetExists: false,
        provesCompletion: false,
      },
      targets,
      omission: {
        availableTargetCount: 2,
        projectedTargetCount: 2,
        omittedTargetCount: 0,
      },
    });
    expect(Object.keys(capsule)).toEqual([
      "kind",
      "category",
      "authority",
      "provenance",
      "purpose",
      "representation",
      "applicability",
      "nonAuthority",
      "targets",
      "omission",
    ]);
  });

  test("returns the deterministic longest fitting prefix with path-free counts", () => {
    const attemptedPrefixLengths: number[] = [];
    const projection = buildSessionArtifactPathsMessage({
      targets: ["first.txt", "nested/second.txt", "third.txt"],
      applicable: true,
      fits: (message) => {
        const capsule = JSON.parse(
          message.content,
        ) as SessionArtifactPathsCapsule;
        attemptedPrefixLengths.push(capsule.omission.projectedTargetCount);
        return capsule.omission.projectedTargetCount <= 2;
      },
    });

    expect(attemptedPrefixLengths).toEqual([3, 2]);
    expect(projection).toMatchObject({
      availableCount: 3,
      projectedCount: 2,
      omittedCount: 1,
    });
    expect(
      (JSON.parse(projection!.message.content) as SessionArtifactPathsCapsule)
        .targets,
    ).toEqual(["first.txt", "nested/second.txt"]);
  });

  test("keeps source omission counts after callers bound and dedupe targets", () => {
    const projection = buildSessionArtifactPathsMessage({
      targets: ["newest.txt", "second.txt"],
      availableTargetCount: 5,
      applicable: true,
      fits: () => true,
    });

    expect(projection).toMatchObject({
      availableCount: 5,
      projectedCount: 2,
      omittedCount: 3,
    });
    expect(
      (JSON.parse(projection!.message.content) as SessionArtifactPathsCapsule)
        .omission,
    ).toEqual({
      availableTargetCount: 5,
      projectedTargetCount: 2,
      omittedTargetCount: 3,
    });
  });

  test("emits no message for empty, non-applicable, or wholly unfit input", () => {
    const fits = vi.fn(() => true);
    expect(
      buildSessionArtifactPathsMessage({
        targets: [],
        applicable: true,
        fits,
      }),
    ).toBeUndefined();
    expect(
      buildSessionArtifactPathsMessage({
        targets: ["news/news.txt"],
        applicable: false,
        fits,
      }),
    ).toBeUndefined();
    expect(fits).not.toHaveBeenCalled();

    const attemptedPrefixLengths: number[] = [];
    expect(
      buildSessionArtifactPathsMessage({
        targets: ["first.txt", "second.txt"],
        applicable: true,
        fits: (message) => {
          attemptedPrefixLengths.push(
            (JSON.parse(message.content) as SessionArtifactPathsCapsule)
              .omission.projectedTargetCount,
          );
          return false;
        },
      }),
    ).toBeUndefined();
    expect(attemptedPrefixLengths).toEqual([2, 1]);
  });
});
