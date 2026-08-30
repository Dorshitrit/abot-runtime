import { describe, expect, test } from "vitest";

import {
  isReconsiderationCauseBoundToInvocationCount,
  normalizeRoleCapabilitySelectionReconsiderationCause,
  ROLE_CAPABILITY_RECONSIDERATION_REASON_MAX_LENGTH,
} from "../orchestration/role-calls/index.js";

describe("role capability reconsideration cause", () => {
  test("normalizes and freezes one bounded explicit decline", () => {
    const cause = normalizeRoleCapabilitySelectionReconsiderationCause({
      kind: "refinement_declined",
      entries: [{ invocationIndex: 0, reason: "  Guidance mismatch.  " }],
    });

    expect(cause).toEqual({
      kind: "refinement_declined",
      entries: [{ invocationIndex: 0, reason: "Guidance mismatch." }],
    });
    expect(Object.isFrozen(cause)).toBe(true);
    expect(
      Object.isFrozen(cause?.kind === "refinement_declined" && cause.entries),
    ).toBe(true);
  });

  test("binds decline indexes mechanically to one immutable selection", () => {
    expect(
      isReconsiderationCauseBoundToInvocationCount(
        {
          kind: "refinement_declined",
          entries: [
            { invocationIndex: 0, reason: "First mismatch." },
            { invocationIndex: 1, reason: "Second mismatch." },
          ],
        },
        2,
      ),
    ).toBe(true);
    expect(
      isReconsiderationCauseBoundToInvocationCount(
        {
          kind: "refinement_declined",
          entries: [
            { invocationIndex: 0, reason: "First mismatch." },
            { invocationIndex: 0, reason: "Duplicate mismatch." },
          ],
        },
        2,
      ),
    ).toBe(false);
    expect(
      isReconsiderationCauseBoundToInvocationCount(
        {
          kind: "refinement_declined",
          entries: [{ invocationIndex: 2, reason: "Outside selection." }],
        },
        2,
      ),
    ).toBe(false);
  });

  test("rejects unbounded or surplus diagnostic content", () => {
    expect(
      normalizeRoleCapabilitySelectionReconsiderationCause({
        kind: "refinement_declined",
        entries: [
          {
            invocationIndex: 0,
            reason: "x".repeat(
              ROLE_CAPABILITY_RECONSIDERATION_REASON_MAX_LENGTH + 1,
            ),
          },
        ],
      }),
    ).toBeUndefined();
    expect(
      normalizeRoleCapabilitySelectionReconsiderationCause({
        kind: "refinement_invalid_output",
        validationStage: "domain_parser",
        issues: [],
        repairAttempts: 2,
        repeatedInvalidOutput: true,
        rawOutput: "must-not-enter-ledger",
      }),
    ).toBeUndefined();
  });
});
