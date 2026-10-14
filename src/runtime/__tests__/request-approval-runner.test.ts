import { describe, expect, test } from "vitest";
import { runRequestRunner } from "../request/runner.js";
import {
  actionFingerprint,
  createApprovalRunnerFixture,
} from "./support/request-approval-runner-fixture.js";

describe("request runner approval boundary", () => {
  test.each([true, false])(
    "returns a data-only wait and resumes the same admitted action after decision=%s",
    async (approved) => {
      const f = createApprovalRunnerFixture();
      const waiting = await runRequestRunner(f.makeRequest(), {
        durableApproval: true,
      });
      if (waiting.kind !== "awaiting_approval")
        throw new Error("expected wait");
      expect(f.prepare).toHaveBeenCalledOnce();
      expect(f.performed).not.toHaveBeenCalled();
      expect(f.onAnswerToken).not.toHaveBeenCalled();
      expect(f.decide).toHaveBeenCalledOnce();
      const persisted = JSON.parse(JSON.stringify(waiting.continuation));
      const resumed = await runRequestRunner(f.makeRequest(), {
        durableApproval: true,
        continuation: persisted,
        decisions: [
          {
            approvalId: "approval-exact",
            actionFingerprint,
            decision: { approved },
          },
        ],
      });
      expect(resumed).toEqual({
        kind: "completed",
        result: {
          output: `Finished: ${approved ? "succeeded" : "failed"}.`,
          outputTextMode: "exact",
          disposition: "blocked",
        },
      });
      expect(f.prepare).toHaveBeenCalledOnce();
      expect(f.restore).toHaveBeenCalledOnce();
      expect(f.performed).toHaveBeenCalledTimes(approved ? 1 : 0);
      if (approved)
        expect(f.performed).toHaveBeenCalledWith(
          "capability-execution-1",
          "original",
        );
      expect(f.onAcknowledgement).toHaveBeenCalledOnce();
      expect(f.onAnswerToken).toHaveBeenCalledOnce();
      expect(f.decide).toHaveBeenCalledTimes(2);
    },
  );
});
