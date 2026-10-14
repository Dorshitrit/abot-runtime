import { describe, expect, test } from "vitest";
import { runRequestRunner } from "../request/runner.js";
import {
  actionFingerprint,
  createApprovalRunnerFixture,
} from "./support/request-approval-runner-fixture.js";

const update = {
  steerId: "update-1",
  text: "The request is already satisfied.",
};
const decisionsFor = (approved: boolean) => [
  {
    approvalId: "approval-exact",
    actionFingerprint,
    decision: { approved },
  },
];

async function park(f: ReturnType<typeof createApprovalRunnerFixture>) {
  const waiting = await runRequestRunner(f.makeRequest(), {
    durableApproval: true,
  });
  if (waiting.kind !== "awaiting_approval") throw new Error("expected wait");
  return JSON.parse(
    JSON.stringify(waiting.continuation),
  ) as typeof waiting.continuation;
}

describe("steering during saved approval resume", () => {
  test.each([
    [true, "before restore"],
    [false, "before restore"],
    [true, "during restore"],
    [false, "during restore"],
  ] as const)(
    "continues without dispatching the old action (approved=%s, %s)",
    async (approved, timing) => {
      const acceptUpdate = async () => {
        expect(f.requestSteering.append(update).ok).toBe(true);
      };
      const f = createApprovalRunnerFixture({
        ...(timing === "during restore" ? { beforeRestore: acceptUpdate } : {}),
      });
      const continuation = await park(f);
      const saved = structuredClone(continuation);
      const decisions = decisionsFor(approved);
      if (timing === "before restore") await acceptUpdate();
      const resumed = await runRequestRunner(f.makeRequest(), {
        durableApproval: true,
        continuation,
        decisions,
      });
      expect(resumed.kind).toBe("completed");
      expect(f.performed).not.toHaveBeenCalled();
      expect(f.executed).not.toHaveBeenCalled();
      expect(f.appliedDecisions).toHaveBeenCalledExactlyOnceWith(decisions[0]);
      expect(f.decide).toHaveBeenCalledTimes(2);
      const [request, options] = f.decide.mock.calls[1]!;
      expect(request.requestSteering?.snapshot().updates).toEqual([
        { ...update, sequence: 1 },
      ]);
      const settled = options.head.state.capabilityExecutions[0]!;
      expect(settled).toMatchObject({
        status: "settled",
        outcome: "failed",
        observedEffect: "none",
        actionFingerprint,
      });
      expect(settled.outcomeFingerprint).toBeNull();
      expect(settled.exactResult).toMatchObject({
        code: "steering_superseded_before_external_execution",
      });
      expect(continuation).toEqual(saved);
      expect(decisions).toEqual(decisionsFor(approved));
    },
  );

  test.each([
    ["before restore", false],
    ["before restore", true],
    ["during restore", false],
    ["during restore", true],
  ] as const)(
    "closed inbox stays terminal (%s, newer update=%s)",
    async (timing, newerUpdate) => {
      const close = async () => {
        if (newerUpdate) expect(f.requestSteering.append(update).ok).toBe(true);
        await f.requestSteering.close();
      };
      const f = createApprovalRunnerFixture({
        ...(timing === "during restore" ? { beforeRestore: close } : {}),
      });
      const continuation = await park(f);
      if (timing === "before restore") await close();
      await expect(
        runRequestRunner(f.makeRequest(), {
          durableApproval: true,
          continuation,
          decisions: decisionsFor(true),
        }),
      ).rejects.toThrow("request_approval_steering_superseded");
      expect(f.executed).not.toHaveBeenCalled();
      expect(f.appliedDecisions).not.toHaveBeenCalled();
      expect(f.decide).toHaveBeenCalledOnce();
    },
  );

  test.each(["before restore", "during restore"] as const)(
    "abort stays terminal (%s)",
    async (timing) => {
      const abort = async () => {
        expect(f.requestSteering.append(update).ok).toBe(true);
        f.abortController.abort();
      };
      const f = createApprovalRunnerFixture({
        ...(timing === "during restore" ? { beforeRestore: abort } : {}),
      });
      const continuation = await park(f);
      if (timing === "before restore") await abort();
      await expect(
        runRequestRunner(f.makeRequest(), {
          durableApproval: true,
          continuation,
          decisions: decisionsFor(true),
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(f.executed).not.toHaveBeenCalled();
      expect(f.appliedDecisions).not.toHaveBeenCalled();
      expect(f.decide).toHaveBeenCalledOnce();
    },
  );

  test("a changed persisted steering prefix is not accepted as supersession", async () => {
    const f = createApprovalRunnerFixture();
    expect(f.requestSteering.append(update).ok).toBe(true);
    const continuation = await park(f);
    const corrupted = {
      ...continuation,
      preparedGroup: {
        ...continuation.preparedGroup,
        executionFreshnessToken: {
          ...continuation.preparedGroup.executionFreshnessToken!,
          updates: [{ sequence: 1, text: "Changed persisted prefix" }],
        },
      },
    };
    await expect(
      runRequestRunner(f.makeRequest(), {
        durableApproval: true,
        continuation: corrupted,
        decisions: decisionsFor(true),
      }),
    ).rejects.toThrow("request_approval_steering_mismatch");
    expect(f.restore).not.toHaveBeenCalled();
    expect(f.executed).not.toHaveBeenCalled();
  });
});
