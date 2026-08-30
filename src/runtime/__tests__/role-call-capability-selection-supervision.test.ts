import { describe, expect, test } from "vitest";

import {
  assessRoleCapabilitySelectionSupervisionReconsideration,
  createInitialRoleCapabilitySelectionSupervisionState,
  createRoleCapabilitySelectionSupervisionFingerprint,
  isRoleCapabilitySelectionSupervisionState,
  replayRoleCapabilitySelectionSupervisionRecords,
  resetRoleCapabilitySelectionSupervisionState,
  type RoleCapabilitySelectionSupervisionSelection,
  type RoleCapabilitySelectionSupervisionState,
} from "../orchestration/role-calls/capability-selection-supervision.js";

const RECEIPT_A = `sha256:${"a".repeat(64)}`;
const RECEIPT_B = `sha256:${"b".repeat(64)}`;

describe("pre-execution capability-selection supervision", () => {
  test("builds identity from execution fields while excluding presentation and scope", () => {
    const baseline = selection({
      intent: "first wording",
      controlsJson: '{"z":1,"nested":{"b":2,"a":1}}',
      workingDirectory: undefined,
      scope: ["memory"],
    });
    const semanticallySame = selection({
      intent: "different client wording",
      controlsJson: '{"nested":{"a":1,"b":2},"z":1}',
      workingDirectory: null,
      scope: ["unrelated", "groups"],
    });
    const explicitDot = selection({
      intent: "third wording",
      controlsJson: '{"nested":{"b":2,"a":1},"z":1}',
      workingDirectory: ".",
      scope: [],
    });

    const fingerprints = [baseline, semanticallySame, explicitDot].map(
      (candidate) =>
        createRoleCapabilitySelectionSupervisionFingerprint({
          steeringVersion: 3,
          selection: candidate,
        }),
    );
    expect(new Set(fingerprints).size).toBe(1);
    expect(
      createRoleCapabilitySelectionSupervisionFingerprint({
        steeringVersion: 3,
        selection: selection({ workingDirectory: "nested" }),
      }),
    ).not.toBe(fingerprints[0]);
    expect(
      createRoleCapabilitySelectionSupervisionFingerprint({
        steeringVersion: 4,
        selection: baseline,
      }),
    ).not.toBe(fingerprints[0]);
  });

  test("canonicalizes batch order as a multiset without discarding duplicates", () => {
    const first = batchSelection([
      invocation("memory.list", '{"page":1}'),
      invocation("memory.delete", "{}"),
      invocation("memory.list", '{"page":1}'),
    ]);
    const reordered = batchSelection([
      invocation("memory.list", '{"page":1}'),
      invocation("memory.list", '{"page":1}'),
      invocation("memory.delete", "{}"),
    ]);
    const deduplicated = batchSelection([
      invocation("memory.list", '{"page":1}'),
      invocation("memory.delete", "{}"),
    ]);

    const fingerprint = createRoleCapabilitySelectionSupervisionFingerprint({
      steeringVersion: 0,
      selection: first,
    });
    expect(
      createRoleCapabilitySelectionSupervisionFingerprint({
        steeringVersion: 0,
        selection: reordered,
      }),
    ).toBe(fingerprint);
    expect(
      createRoleCapabilitySelectionSupervisionFingerprint({
        steeringVersion: 0,
        selection: deduplicated,
      }),
    ).not.toBe(fingerprint);
    expect(
      createRoleCapabilitySelectionSupervisionFingerprint({
        steeringVersion: 0,
        selection: selection(),
      }),
    ).not.toBe(fingerprint);
  });

  test("tracks, warns, intervenes, then atomically rejects the fourth repeat", () => {
    let state = createInitialRoleCapabilitySelectionSupervisionState();
    const dispositions: string[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const assessment = assess({
        state,
        attempt,
        receiptFingerprint: attempt === 1 ? RECEIPT_A : RECEIPT_B,
        selection: selection({ intent: `wording-${attempt}` }),
      });
      if (assessment.disposition === "reject") {
        throw new Error("unexpected supervision rejection");
      }
      dispositions.push(assessment.disposition);
      expect(assessment.identityCount).toBe(attempt);
      state = assessment.state;
    }
    expect(dispositions).toEqual(["tracking", "warning", "intervened"]);
    expect(
      new Set(state.records.map((record) => record.receiptFingerprint)),
    ).toEqual(new Set([RECEIPT_A, RECEIPT_B]));
    expect(
      new Set(state.records.map((record) => record.supervisionFingerprint))
        .size,
    ).toBe(1);

    const before = state;
    const rejected = assess({ state, attempt: 4, selection: selection() });
    expect(rejected).toMatchObject({
      disposition: "reject",
      issueCode: "capability_selection_supervision_limit_exceeded",
      identityCount: 4,
      totalCount: 4,
      trigger: "repeat_identity",
    });
    expect(state).toBe(before);
    expect(state.records).toHaveLength(3);
  });

  test("retains identity counts across A-B-A", () => {
    let state = createInitialRoleCapabilitySelectionSupervisionState();
    const firstA = assess({ state, attempt: 1, selection: selection() });
    if (firstA.disposition === "reject") throw new Error("unexpected reject");
    state = firstA.state;
    const firstB = assess({
      state,
      attempt: 2,
      selection: selection({ capabilityId: "memory.delete" }),
    });
    if (firstB.disposition === "reject") throw new Error("unexpected reject");
    state = firstB.state;
    const secondA = assess({ state, attempt: 3, selection: selection() });

    expect(secondA).toMatchObject({
      disposition: "warning",
      identityCount: 2,
      totalCount: 3,
      trigger: "repeat_identity",
    });
  });

  test("contains unique-identity churn at the total budget", () => {
    let state = createInitialRoleCapabilitySelectionSupervisionState();
    const acceptedStages: string[] = [];
    for (let attempt = 1; attempt <= 7; attempt += 1) {
      const assessment = assess({
        state,
        attempt,
        selection: selection({ capabilityId: `memory.choice-${attempt}` }),
      });
      if (assessment.disposition === "reject") {
        throw new Error("unexpected supervision rejection");
      }
      acceptedStages.push(assessment.disposition);
      state = assessment.state;
    }
    expect(acceptedStages).toEqual([
      "tracking",
      "tracking",
      "tracking",
      "tracking",
      "tracking",
      "warning",
      "intervened",
    ]);
    expect(
      assess({
        state,
        attempt: 8,
        selection: selection({ capabilityId: "memory.choice-8" }),
      }),
    ).toMatchObject({
      disposition: "reject",
      identityCount: 1,
      totalCount: 8,
      trigger: "total_budget",
    });
    expect(state.records).toHaveLength(7);
  });

  test("uses the strongest applicable repeat or total stage", () => {
    let state = createInitialRoleCapabilitySelectionSupervisionState();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const candidate = assess({
        state,
        attempt,
        selection: selection({ capabilityId: `memory.unique-${attempt}` }),
      });
      if (candidate.disposition === "reject")
        throw new Error("unexpected reject");
      state = candidate.state;
    }
    const totalWarning = assess({
      state,
      attempt: 6,
      selection: selection({ capabilityId: "memory.unique-1" }),
    });
    expect(totalWarning).toMatchObject({
      disposition: "warning",
      identityCount: 2,
      totalCount: 6,
      trigger: "repeat_and_total",
    });
    if (totalWarning.disposition === "reject")
      throw new Error("unexpected reject");
    const repeatIntervention = assess({
      state: totalWarning.state,
      attempt: 7,
      selection: selection({ capabilityId: "memory.unique-1" }),
    });
    expect(repeatIntervention).toMatchObject({
      disposition: "intervened",
      identityCount: 3,
      totalCount: 7,
      trigger: "repeat_and_total",
    });
  });

  test("opens only a newer steering epoch and supports explicit progress reset", () => {
    const first = assess({
      state: createInitialRoleCapabilitySelectionSupervisionState(),
      attempt: 1,
      steeringVersion: 2,
      selection: selection(),
    });
    if (first.disposition === "reject") throw new Error("unexpected reject");
    const nextEpoch = assess({
      state: first.state,
      attempt: 2,
      steeringVersion: 3,
      selection: selection(),
    });
    expect(nextEpoch).toMatchObject({
      disposition: "tracking",
      identityCount: 1,
      totalCount: 1,
    });
    if (nextEpoch.disposition === "reject")
      throw new Error("unexpected reject");
    expect(nextEpoch.state.epoch).toEqual({
      callId: "call-1",
      steeringVersion: 3,
    });
    expect(nextEpoch.state.records).toHaveLength(1);
    expect(() =>
      assess({
        state: nextEpoch.state,
        attempt: 3,
        steeringVersion: 2,
        selection: selection(),
      }),
    ).toThrow("role_capability_selection_supervision_steering_stale");
    expect(() =>
      assess({
        state: nextEpoch.state,
        callId: "call-2",
        attempt: 3,
        steeringVersion: 3,
        selection: selection(),
      }),
    ).toThrow("role_capability_selection_supervision_epoch_call_invalid");
    expect(resetRoleCapabilitySelectionSupervisionState()).toEqual({
      epoch: null,
      records: [],
    });
  });

  test("replays valid bounded state and rejects forged evidence", () => {
    let state = createInitialRoleCapabilitySelectionSupervisionState();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const assessment = assess({ state, attempt, selection: selection() });
      if (assessment.disposition === "reject")
        throw new Error("unexpected reject");
      state = assessment.state;
    }
    expect(isRoleCapabilitySelectionSupervisionState(state)).toBe(true);
    expect(
      replayRoleCapabilitySelectionSupervisionRecords({
        epoch: state.epoch,
        records: state.records,
      }),
    ).toEqual(state);

    const forgedStage = forgeState(state, {
      records: state.records.map((record, index) =>
        index === 1 ? { ...record, stage: "tracking" as const } : record,
      ),
    });
    expect(isRoleCapabilitySelectionSupervisionState(forgedStage)).toBe(false);

    const forgedOrder = forgeState(state, {
      records: [state.records[1]!, state.records[0]!, state.records[2]!],
    });
    expect(isRoleCapabilitySelectionSupervisionState(forgedOrder)).toBe(false);

    const forgedFingerprint = forgeState(state, {
      records: [
        { ...state.records[0]!, supervisionFingerprint: "sha256:forged" },
        ...state.records.slice(1),
      ],
    });
    expect(isRoleCapabilitySelectionSupervisionState(forgedFingerprint)).toBe(
      false,
    );

    const forgedEighthRecord = forgeState(churnState(7), {
      records: [
        ...churnState(7).records,
        {
          invocationAttempt: 8,
          receiptFingerprint: RECEIPT_A,
          supervisionFingerprint: `sha256:${"f".repeat(64)}`,
          identityCount: 1,
          totalCount: 8,
          stage: "intervened",
          trigger: "total_budget",
        },
      ],
    });
    expect(isRoleCapabilitySelectionSupervisionState(forgedEighthRecord)).toBe(
      false,
    );
  });
});

function assess(input: {
  state: RoleCapabilitySelectionSupervisionState;
  attempt: number;
  selection: RoleCapabilitySelectionSupervisionSelection;
  callId?: string;
  steeringVersion?: number;
  receiptFingerprint?: string;
}) {
  return assessRoleCapabilitySelectionSupervisionReconsideration({
    state: input.state,
    callId: input.callId ?? "call-1",
    invocationAttempt: input.attempt,
    steeringVersion: input.steeringVersion ?? 0,
    receiptFingerprint: input.receiptFingerprint ?? RECEIPT_A,
    selection: input.selection,
  });
}

function selection(
  input: {
    capabilityId?: string;
    intent?: string;
    controlsJson?: string;
    workingDirectory?: string | null;
    scope?: readonly string[];
  } = {},
): RoleCapabilitySelectionSupervisionSelection {
  return {
    action: "invoke_capability",
    invocations: [
      {
        capabilityId: input.capabilityId ?? "memory.list",
        intent: input.intent ?? "list entries",
        selectionControlsJson: input.controlsJson ?? "{}",
      },
    ],
    ...(Object.hasOwn(input, "workingDirectory")
      ? { workingDirectory: input.workingDirectory }
      : {}),
    activeCapabilityCatalogGroupIds: input.scope ?? [],
  };
}

function batchSelection(
  invocations: RoleCapabilitySelectionSupervisionSelection["invocations"],
): RoleCapabilitySelectionSupervisionSelection {
  return {
    action: "invoke_capabilities",
    invocations,
    workingDirectory: ".",
    activeCapabilityCatalogGroupIds: [],
  };
}

function invocation(capabilityId: string, selectionControlsJson: string) {
  return { capabilityId, intent: "presentation only", selectionControlsJson };
}

function forgeState(
  state: RoleCapabilitySelectionSupervisionState,
  replacement: Partial<RoleCapabilitySelectionSupervisionState>,
): RoleCapabilitySelectionSupervisionState {
  return { ...state, ...replacement };
}

function churnState(count: number): RoleCapabilitySelectionSupervisionState {
  let state = createInitialRoleCapabilitySelectionSupervisionState();
  for (let attempt = 1; attempt <= count; attempt += 1) {
    const assessment = assess({
      state,
      attempt,
      selection: selection({ capabilityId: `memory.churn-${attempt}` }),
    });
    if (assessment.disposition === "reject")
      throw new Error("unexpected reject");
    state = assessment.state;
  }
  return state;
}
