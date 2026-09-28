import { describe, expect, test } from "vitest";
import {
  accepted,
  activationExpected,
  fixture,
  waitExpected,
} from "./support.js";

describe("lifecycle fencing and event ordering", () => {
  test("uses the same monotonic sequence in live output and replay", async () => {
    const f = await fixture();
    const event = accepted(
      await f.service.requestLifecycle.appendActivationEvent("conversation", {
        expected: activationExpected(f.started.current),
        payload: {
          type: "event",
          name: "fixture.progress",
          eventSequence: 900,
        },
      }),
    );
    const wait = accepted(
      await f.service.requestLifecycle.commitWait("conversation", {
        ...f.command,
        expected: activationExpected(event.current),
      }),
    );
    const live = [...event.events, ...wait.events];
    expect(live.map((value) => value.eventSequence)).toEqual([1, 2, 3]);
    expect(live.map((value) => value.seqNo)).toEqual([1, 2, 3]);
    expect((await f.service.getRequestReplayById("request"))!.events).toEqual(
      live,
    );
    expect(wait.events.at(-1)).toMatchObject({
      name: "request.lifecycle.changed",
      lifecycle: wait.current,
    });
    expect(
      await f.service.requestLifecycle.appendActivationEvent("conversation", {
        expected: activationExpected(event.current),
        payload: { type: "token", text: "late" },
      }),
    ).toMatchObject({ accepted: false, reason: "revision_mismatch" });
    await expect(
      f.service.appendRequestEvent("conversation", "request", {
        type: "completed",
        output: "legacy",
      }),
    ).rejects.toThrow("request_lifecycle_command_required");
    await expect(
      f.service.startRequestStream("conversation", "request"),
    ).rejects.toThrow("request_lifecycle_command_required");
    expect(
      (await f.service.requestLifecycle.get("conversation", "request"))?.status,
    ).toBe("awaiting_approval");
  });

  test("preserves live partial decisions and does not announce the same approval twice", async () => {
    const f = await fixture(2);
    let state = f.started.current;
    for (const approval of f.approvals) {
      state = accepted(
        await f.service.requestLifecycle.appendActivationEvent("conversation", {
          expected: activationExpected(state),
          payload: {
            type: "event",
            name: "tool.approval.required",
            approvalId: approval.approvalId,
          },
        }),
      ).current;
    }
    const waited = accepted(
      await f.service.requestLifecycle.commitWait("conversation", {
        ...f.command,
        expected: activationExpected(state),
        initialDecisions: [
          {
            approvalId: "approval-1",
            approved: true,
            commandId: "live-decision",
          },
        ],
      }),
    );
    expect(waited.events.map((event) => event.name)).toEqual([
      "tool.approval.granted",
      "request.lifecycle.changed",
    ]);
    expect(waited.current.decisionReceipts).toMatchObject([
      { approvalId: "approval-1", commandId: "live-decision", approved: true },
    ]);
    const session = await f.service.getSessionById("conversation");
    expect(
      session!.requests![0]!.events.filter(
        (event) => event.payload.name === "tool.approval.required",
      ),
    ).toHaveLength(2);
    expect(session!.messages[1]!.approvalRequest!.decisions).toEqual(
      waited.current.decisionReceipts,
    );
    const resumed = accepted(
      await f.service.requestLifecycle.commitDecision("conversation", {
        expected: waitExpected(waited.current),
        approvalId: "approval-2",
        commandId: "last",
        approved: false,
        resumeActivation: {
          activationId: "activation-2",
          ownerEpoch: "owner-1",
        },
      }),
    );
    expect(resumed.current.status).toBe("streaming");
  });

  test("cannot park a group whose approvals are already all decided", async () => {
    const f = await fixture();
    expect(
      await f.service.requestLifecycle.commitWait("conversation", {
        ...f.command,
        initialDecisions: [
          { approvalId: "approval-1", approved: true, commandId: "already" },
        ],
      }),
    ).toMatchObject({ accepted: false, reason: "invalid_command" });
    expect(
      (await f.service.getSessionById("conversation"))!.messages,
    ).toHaveLength(1);
  });

  test.each(["clear", "delete", "message"] as const)(
    "%s invalidates the old generation without resurrecting requests",
    async (operation) => {
      const f = await fixture();
      const state = accepted(
        await f.service.requestLifecycle.commitWait("conversation", f.command),
      ).current;
      if (operation === "clear")
        await f.service.clearSessionMessages("conversation");
      if (operation === "delete") await f.service.deleteSession("conversation");
      if (operation === "message")
        await f.service.deleteMessage("conversation", "msg-1");
      const result = await f.service.requestLifecycle.commitDecision(
        "conversation",
        {
          expected: waitExpected(state),
          commandId: "late",
          approvalId: "approval-1",
          approved: true,
          resumeActivation: { activationId: "late", ownerEpoch: "late-owner" },
        },
      );
      expect(result.accepted).toBe(false);
      expect(await f.service.requestLifecycle.listWaiting()).toEqual([]);
      await f.service.getOrCreateSession("conversation");
      const recreated = accepted(
        await f.service.requestLifecycle.startActivation("conversation", {
          requestId: "request",
          activationId: "fresh",
          ownerEpoch: "owner-2",
        }),
      );
      expect(recreated.current.generation).not.toBe(state.generation);
      expect(
        await f.service.requestLifecycle.cancelWait("conversation", {
          expected: waitExpected(state),
          commandId: "stale",
          message: { content: "stale cancellation" },
        }),
      ).toMatchObject({ accepted: false, reason: "generation_mismatch" });
    },
  );

  test("terminal transition saves metadata and response exactly once", async () => {
    const f = await fixture();
    const command = {
      expected: activationExpected(f.started.current),
      commandId: "finish",
      status: "completed" as const,
      message: {
        content: "Completed action.",
        grounding: "tool_observation" as const,
        observationContent: "Exact result",
        observationMeta: {
          kind: "task_result" as const,
          carryPolicy: "always" as const,
        },
        lastAgentMode: "reasoning" as const,
      },
    };
    const terminal = accepted(
      await f.service.requestLifecycle.commitTerminal("conversation", command),
    );
    expect(terminal.events.at(-1)).toMatchObject({
      type: "completed",
      output: "Completed action.",
    });
    expect(
      accepted(
        await f.service.requestLifecycle.commitTerminal(
          "conversation",
          command,
        ),
      ).duplicate,
    ).toBe(true);
    const session = await f.service.getSessionById("conversation");
    expect(session!.messages).toHaveLength(2);
    expect(session!.messages[1]).toMatchObject({
      kind: "terminal",
      grounding: "tool_observation",
      observationContent: "Exact result",
      observationMeta: command.message.observationMeta,
    });
    expect(
      (await f.service.getRequestReplayById("request"))?.finalState?.status,
    ).toBe("completed");
  });
});
