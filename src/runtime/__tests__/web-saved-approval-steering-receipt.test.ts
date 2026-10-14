import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { SessionRecord } from "../../sessions/types.js";
import { buildConversationToolActions } from "../../web-ui/app/lib/tool-activity-model.js";
import { resetDebugLoggerConfig } from "../observability/debug-logger.js";
import * as preparation from "../request/prepared-execution.js";
import { createSchedulerTestGate } from "./support/scheduler-runtime-fixture.js";
import { createWebSavedApprovalSteeringFixture } from "./support/web-saved-approval-steering-fixture.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release();
  resetDebugLoggerConfig();
});

function hasRecordedApprovalDecisions(
  params: preparation.RequestPreparationInput,
): boolean {
  return Boolean(params.options.approvalExecution?.resume?.decisions.length);
}

function pauseResumedRequestPreparation() {
  const original = preparation.prepareRequestExecution;
  const entered = createSchedulerTestGate();
  const release = createSchedulerTestGate();
  const spy = vi
    .spyOn(preparation, "prepareRequestExecution")
    .mockImplementation(async (params) => {
      const result = await original(params);
      // Hydration preflight has no decisions; only the committed activation pauses.
      if (!hasRecordedApprovalDecisions(params)) return result;
      entered.open();
      await release.waiting;
      return result;
    });
  return {
    entered: entered.waiting,
    release: release.open,
    dispose() {
      release.open();
      spy.mockRestore();
    },
  };
}

async function readSavedSession(sessionsDir: string): Promise<SessionRecord> {
  return JSON.parse(await readFile(join(sessionsDir, "session.json"), "utf8"));
}

test.each([true, false])(
  "Web STEER during saved approval resume preserves the durable decision (approved=%s)",
  async (approved) => {
    const f = await createWebSavedApprovalSteeringFixture(
      "execution-agent-v1",
      cleanup,
    );
    f.effect.open();
    const responses: Record<string, unknown>[] = [];
    const response = {
      writeHead: vi.fn(),
      end: (raw: string) => responses.push(JSON.parse(raw)),
    } as unknown as ServerResponse;
    await f.requests.start(
      response,
      {
        sessionId: "session",
        text: "Perform the fixture action.",
        toolPermissionMode: "ask",
        agentMode: "reasoning",
        modelPreference: { profileId: "scheduled-model", scope: "all" },
      },
      f.base.config.runtimeId,
      f.client,
    );
    const requestId = String(responses[0]!.requestId);
    await vi.waitFor(
      () =>
        expect(f.events).toContainEqual(
          expect.objectContaining({
            name: "request.lifecycle.changed",
            lifecycle: expect.objectContaining({ status: "awaiting_approval" }),
          }),
        ),
      { timeout: 5000 },
    );
    await vi.waitFor(() => expect(f.requests.healthDetails()).toEqual([]));
    const [pending] = await f.approvals.list(f.base.config.runtimeId);
    expect(pending).toMatchObject({ requestId, sessionId: "session" });
    const before = await readSavedSession(f.base.config.paths.sessionsDir);
    const originalApproval = before.messages.find(
      (entry) => entry.requestId === requestId && entry.approvalRequest,
    )!.approvalRequest!;
    expect(originalApproval.approvals[0]!.actionFingerprint).toMatch(/^.+$/);
    const command = {
      ...pending!,
      commandId: "decision-before-steer",
      approved,
      reason: "Explicit user decision before the steering update.",
    };
    const steering = {
      requestId,
      environment: f.base.config.runtimeId,
      steerId: "steer-during-resume",
      text: "The task is already handled. Acknowledge this update briefly.",
    };
    const callsBeforeResume = f.model.invoke.mock.calls.length;
    const pause = pauseResumedRequestPreparation();
    try {
      expect(await f.approvals.decide(command)).toBe(true);
      await pause.entered;
      const claimed = await readSavedSession(f.base.config.paths.sessionsDir);
      const claimedRequest = claimed.requests!.find(
        (entry) => entry.requestId === requestId,
      )!;
      expect(claimedRequest.status).toBe("streaming");
      const committedReceipts = claimedRequest.lifecycle!.decisionReceipts;
      expect(committedReceipts).toHaveLength(1);
      expect(committedReceipts[0]).toMatchObject({
        commandId: command.commandId,
        requestId,
        generation: command.generation,
        waitId: command.waitId,
        approvalId: command.approvalId,
        approved,
        reason: command.reason,
        activation: {
          activationId: expect.any(String),
          ownerEpoch: expect.any(String),
        },
      });
      const acknowledgement = {
        type: "steer_ack",
        requestId,
        steerId: steering.steerId,
        accepted: true,
        acceptedSequence: 1,
      };
      expect(await f.requests.handleSteer(steering, f.resolve)).toEqual(
        acknowledgement,
      );
      expect(await f.requests.handleSteer(steering, f.resolve)).toEqual(
        acknowledgement,
      );
      expect(f.execute).not.toHaveBeenCalled();
      pause.release();
      await f.owner.whenIdle?.();
      await vi.waitFor(() =>
        expect(f.events).toContainEqual(
          expect.objectContaining({ type: "completed", requestId }),
        ),
      );
      const saved = await readSavedSession(f.base.config.paths.sessionsDir);
      const request = saved.requests!.find(
        (entry) => entry.requestId === requestId,
      )!;
      expect(request.status).toBe("completed");
      expect(request.lifecycle!.terminalCause).toBeUndefined();
      expect(request.lifecycle!.decisionReceipts).toEqual(committedReceipts);
      const presentation = saved.messages.find(
        (entry) => entry.requestId === requestId && entry.approvalRequest,
      )!.approvalRequest!;
      expect(presentation).toEqual({
        ...originalApproval,
        state: "consumed",
        decisions: committedReceipts,
      });
      expect(
        saved.messages.filter((entry) => entry.content === steering.text),
      ).toEqual([expect.objectContaining({ role: "user", requestId })]);
      expect(
        request.events.filter(
          (event) => event.payload.name === "tool.approval.required",
        ),
      ).toHaveLength(1);
      const failedTools = request.events.filter(
        (event) => event.payload.name === "tool.failed",
      );
      expect(failedTools).toHaveLength(1);
      expect(failedTools[0]!.payload).toMatchObject({
        tool: "approval_fixture_effect",
        executionId: originalApproval.approvals[0]!.presentation!.executionId,
        roleCallId: originalApproval.approvals[0]!.presentation!.roleCallId,
        stage: "before_external_execution",
        error: "steering_superseded_before_external_execution",
      });
      expect(
        buildConversationToolActions({ requestId, events: f.events }),
      ).toEqual([
        expect.objectContaining({ status: "failed", executed: false }),
      ]);
      const resumedDecisions = f.model.invoke.mock.calls
        .slice(callsBeforeResume)
        .filter(([input]) => input.modelStep === "execution.decision");
      expect(resumedDecisions).toHaveLength(1);
      expect(
        JSON.stringify(resumedDecisions[0]![0].messages).split(steering.text),
      ).toHaveLength(2);
      expect(await f.client.approvals.decide(command)).toEqual({
        accepted: true,
        duplicate: true,
      });
      const replayed = await readSavedSession(f.base.config.paths.sessionsDir);
      expect(
        replayed.requests!.find((entry) => entry.requestId === requestId)!
          .lifecycle!.decisionReceipts,
      ).toEqual(committedReceipts);
      expect(f.execute).not.toHaveBeenCalled();
      expect(await f.approvals.list(f.base.config.runtimeId)).toEqual([]);
      expect(f.model.invokeRaw).not.toHaveBeenCalled();
    } finally {
      pause.dispose();
    }
  },
  20_000,
);
