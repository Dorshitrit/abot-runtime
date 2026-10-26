import { afterEach, describe, expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { ModelGatewayClient } from "../ports.js";
import { resetDebugLoggerConfig } from "../observability/debug-logger.js";
import {
  createApprovalRejectionMessageFixture,
  type ApprovalRejectionScenario,
} from "./support/approval-rejection-message-fixture.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release();
  resetDebugLoggerConfig();
});

const scenarios: readonly ApprovalRejectionScenario[] = [
  { policy: "execution-agent-v1", mode: "ask", approval: "request_policy" },
  { policy: "execution-agent-v1", mode: "full_access", approval: "always" },
  { policy: "supervisor-worker-v1", mode: "ask", approval: "request_policy" },
  { policy: "supervisor-worker-v1", mode: "full_access", approval: "always" },
];
const explanation =
  'אין צורך לשנות את הקובץ.\nUse the existing report "as is".';
const reason = `Action declined by the user.\n${explanation}`;

describe.each(scenarios)(
  "approval rejection evidence: $policy / $mode",
  (scenario) => {
    test("restores and forwards the exact rejection reason without dispatch or user steering", async () => {
      const f = await createApprovalRejectionMessageFixture(scenario, cleanup);
      expect(f.execute).not.toHaveBeenCalled();
      await f.restart();
      const callsBeforeDecision = f.model.invoke.mock.calls.length;
      const decision = { approved: false, reason };
      expect(await f.decide(decision)).toEqual({ accepted: true });
      const saved = await f.settledSession();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.model.invokeRaw).not.toHaveBeenCalled();

      const continuationStep =
        scenario.policy === "execution-agent-v1"
          ? "execution.decision"
          : "worker.evidence";
      const resumedDecision = f.model.invoke.mock.calls
        .slice(callsBeforeDecision)
        .map(([input]) => input)
        .find((input) => input.modelStep === continuationStep);
      expect(resumedDecision).toBeDefined();
      const evidence = capabilityEvidence(resumedDecision!);
      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toMatchObject({
        capabilityId: "record_approval_effect",
        outcome: "failed",
        observedEffect: "none",
        adapterResult: {
          kind: "runtime_capability_rejection_v1",
          status: "rejected",
          code: "tool_approval_rejected",
          message: reason,
        },
      });
      const request = saved.requests!.find(
        (entry) => entry.requestId === f.command.requestId,
      )!;
      expect(request.status).toBe("completed");
      expect(request.lifecycle!.decisionReceipts).toEqual([
        expect.objectContaining({
          commandId: f.command.commandId,
          approvalId: f.command.approvalId,
          approved: false,
          reason,
        }),
      ]);
      expect(
        request.events.filter(
          (event) => event.payload.name === "tool.approval.rejected",
        ),
      ).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ reason }),
        }),
      ]);
      expect(
        saved.messages.filter(
          (message) =>
            message.role === "user" &&
            message.requestId === f.command.requestId,
        ),
      ).toEqual([
        expect.objectContaining({ content: "Perform the fixture action." }),
      ]);
      expect(
        (resumedDecision!.messages as readonly ChatMessage[])
          .filter((message) => message.role === "user")
          .some((message) => message.content.includes(explanation)),
      ).toBe(false);

      const resumedCallCount = f.model.invoke.mock.calls.length;
      await f.restart();
      expect(await f.decide(decision)).toEqual({
        accepted: true,
        duplicate: true,
      });
      expect(
        await f.decide({ ...decision, reason: "Different explanation" }),
      ).toEqual({ accepted: false, reason: "approval_conflict" });
      const replayed = await f.settledSession();
      expect(
        replayed.requests!.find(
          (entry) => entry.requestId === f.command.requestId,
        )!.lifecycle!.decisionReceipts,
      ).toEqual(request.lifecycle!.decisionReceipts);
      expect(f.model.invoke).toHaveBeenCalledTimes(resumedCallCount);
      expect(f.execute).not.toHaveBeenCalled();
    }, 20000);

    test.each([true, false])(
      "preserves an ordinary decision without a reason (approved=%s)",
      async (approved) => {
        const f = await createApprovalRejectionMessageFixture(
          scenario,
          cleanup,
        );
        expect(await f.decide({ approved })).toEqual({ accepted: true });
        const saved = await f.settledSession();
        const request = saved.requests!.find(
          (entry) => entry.requestId === f.command.requestId,
        )!;
        expect(request.status).toBe("completed");
        expect(request.lifecycle!.decisionReceipts).toHaveLength(1);
        expect(request.lifecycle!.decisionReceipts[0]).toMatchObject({
          approved,
        });
        expect(request.lifecycle!.decisionReceipts[0]).not.toHaveProperty(
          "reason",
        );
        expect(f.execute).toHaveBeenCalledTimes(approved ? 1 : 0);
        expect(f.model.invokeRaw).not.toHaveBeenCalled();
      },
      20000,
    );
  },
);

function capabilityEvidence(
  input: Parameters<ModelGatewayClient["invoke"]>[0],
) {
  return (input.messages as readonly ChatMessage[]).flatMap((message) => {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(message.content) as Record<string, unknown>;
    } catch {
      return [];
    }
    if (payload.kind === "runtime_execution_capability_result_v1")
      return [payload.result];
    if (
      payload.kind === "runtime_request_tool_results_v1" &&
      Array.isArray(payload.results)
    )
      return payload.results;
    return [];
  });
}
