import { rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { SessionService } from "../../session-service.js";
import { snapshotSessionMemorySource } from "../../memory/source.js";
import { buildContextBuckets } from "../../context-window.js";
import {
  accepted,
  activationExpected,
  fixture,
  waitExpected,
} from "./support.js";

describe("canonical approval lifecycle", () => {
  test("reloads one saved approval message and pending state without exposing continuation", async () => {
    const f = await fixture();
    const waiting = accepted(
      await f.service.requestLifecycle.commitWait("conversation", f.command),
    );
    expect(waiting.current.status).toBe("awaiting_approval");
    const restarted = new SessionService({ sessionsDir: f.directory });
    expect(
      await restarted.requestLifecycle.get("conversation", "request"),
    ).toEqual(waiting.current);
    const listed = await restarted.requestLifecycle.listWaiting();
    expect(listed).toEqual([waiting.current]);
    expect(JSON.stringify(listed)).not.toContain(f.continuation.blob.sha256);
    const snapshot = await restarted.getSessionSnapshot("conversation");
    expect(snapshot?.messages.map((message) => message.kind)).toEqual([
      undefined,
      "tool_approval_request",
    ]);
    expect(snapshot?.requests[0]?.lifecycle).toEqual(waiting.current);
    expect(snapshot?.requests[0]?.status).toBe("awaiting_approval");
    expect(JSON.stringify(snapshot)).not.toContain("previousResult");
    expect(JSON.stringify(snapshot)).not.toContain(f.continuation.blob.sha256);
    expect(
      await restarted.requestLifecycle.readContinuation(
        "conversation",
        f.continuation,
      ),
    ).toEqual({ exactAction: "fixture", previousResult: "already done" });
  });

  test("partial decisions and cancellation do not need readable continuation bytes", async () => {
    const f = await fixture(2);
    let state = accepted(
      await f.service.requestLifecycle.commitWait("conversation", f.command),
    ).current;
    await rm(join(f.directory, ".request-continuations"), { recursive: true });
    const partial = accepted(
      await f.service.requestLifecycle.commitDecision("conversation", {
        expected: waitExpected(state),
        commandId: "decision-1",
        approvalId: "approval-1",
        approved: true,
      }),
    );
    state = partial.current;
    expect(state.status).toBe("awaiting_approval");
    expect(state.decisionReceipts).toHaveLength(1);
    expect(await f.service.requestLifecycle.listWaiting()).toEqual([state]);
    const cancelled = accepted(
      await f.service.requestLifecycle.cancelWait("conversation", {
        expected: waitExpected(state),
        commandId: "stop-1",
        message: { content: "I stopped the task at your request." },
      }),
    );
    expect(cancelled.current.terminalCause).toBe("request_cancelled");
    const session = await f.service.getSessionById("conversation");
    expect(session!.messages.map((message) => message.kind)).toEqual([
      undefined,
      "tool_approval_request",
      "terminal",
    ]);
    expect(session!.messages[1]?.approvalRequest?.state).toBe("cancelled");
    expect(session!.messages[1]?.id).not.toBe(session!.messages[2]?.id);
    expect(
      session!.requests![0]!.events.filter(
        (event) => event.payload.name === "tool.approval.rejected",
      ),
    ).toEqual([]);
    expect(
      snapshotSessionMemorySource(session!).historyMessages.map(
        (message) => message.content,
      ),
    ).toEqual([
      "Perform the requested action.",
      "I stopped the task at your request.",
    ]);
  });

  test("last explicit decision atomically consumes wait, stores receipt and starts a new identity", async () => {
    const f = await fixture(2);
    let state = accepted(
      await f.service.requestLifecycle.commitWait("conversation", f.command),
    ).current;
    state = accepted(
      await f.service.requestLifecycle.commitDecision("conversation", {
        expected: waitExpected(state),
        commandId: "first",
        approvalId: "approval-1",
        approved: false,
        reason: "Declined",
      }),
    ).current;
    const expected = waitExpected(state);
    const command = {
      expected,
      commandId: "last",
      approvalId: "approval-2",
      approved: true,
      resumeActivation: { activationId: "activation-2", ownerEpoch: "owner-2" },
    };
    const result = accepted(
      await f.service.requestLifecycle.commitDecision("conversation", command),
    );
    expect(result.current.status).toBe("streaming");
    expect(result.current.wait).toBeUndefined();
    expect(result.current.activation).toEqual(command.resumeActivation);
    expect(result.receipt?.activation).toEqual(command.resumeActivation);
    const restart = new SessionService({ sessionsDir: f.directory });
    expect(
      await restart.requestLifecycle.getContinuation("conversation", expected),
    ).toBeNull();
    const repeated = accepted(
      await restart.requestLifecycle.commitDecision("conversation", command),
    );
    expect(repeated.duplicate).toBe(true);
    expect(repeated.receipt).toEqual(result.receipt);
    expect(repeated.events).toEqual([]);
    expect(
      await restart.requestLifecycle.get("conversation", "request"),
    ).toEqual(result.current);
    expect(
      await restart.requestLifecycle.commitDecision("conversation", {
        ...command,
        approved: false,
      }),
    ).toMatchObject({ accepted: false, reason: "decision_command_conflict" });
    expect(
      await restart.requestLifecycle.commitDecision("conversation", {
        ...command,
        commandId: "different",
        approved: false,
      }),
    ).toMatchObject({ accepted: false, reason: "approval_already_decided" });
  });

  test("two competing clients cannot claim two activations", async () => {
    const f = await fixture();
    const state = accepted(
      await f.service.requestLifecycle.commitWait("conversation", f.command),
    ).current;
    const expected = waitExpected(state);
    const results = await Promise.all([
      f.service.requestLifecycle.commitDecision("conversation", {
        expected,
        commandId: "one",
        approvalId: "approval-1",
        approved: true,
        resumeActivation: { activationId: "next-one", ownerEpoch: "owner" },
      }),
      f.service.requestLifecycle.commitDecision("conversation", {
        expected,
        commandId: "two",
        approvalId: "approval-1",
        approved: false,
        resumeActivation: { activationId: "next-two", ownerEpoch: "owner" },
      }),
    ]);
    expect(results.filter((result) => result.accepted)).toHaveLength(1);
    expect(
      (await f.service.requestLifecycle.get("conversation", "request"))
        ?.decisionReceipts,
    ).toHaveLength(1);
  });

  test("approval presentation does not close history or change unrelated model context", async () => {
    const f = await fixture();
    const before = await f.service.getSessionById("conversation");
    accepted(
      await f.service.requestLifecycle.commitWait("conversation", f.command),
    );
    const after = await f.service.getSessionById("conversation");
    expect(snapshotSessionMemorySource(after!)).toEqual(
      snapshotSessionMemorySource(before!),
    );
    expect(buildContextBuckets(after!)).toEqual(buildContextBuckets(before!));
  });

  test("a consumed approval is never restored when its claimed activation is interrupted", async () => {
    const f = await fixture();
    const wait = accepted(
      await f.service.requestLifecycle.commitWait("conversation", f.command),
    ).current;
    const decision = accepted(
      await f.service.requestLifecycle.commitDecision("conversation", {
        expected: waitExpected(wait),
        commandId: "yes",
        approvalId: "approval-1",
        approved: true,
        resumeActivation: { activationId: "next", ownerEpoch: "old-owner" },
      }),
    );
    const interrupted = accepted(
      await f.service.requestLifecycle.interruptActivation("conversation", {
        expected: activationExpected(decision.current),
        commandId: "interrupted",
        message: { content: "Execution was interrupted by a restart." },
      }),
    );
    expect(interrupted.current.status).toBe("failed");
    expect(interrupted.current.terminalCause).toBe("request_interrupted");
    expect(await f.service.requestLifecycle.listWaiting()).toEqual([]);
    expect(
      await f.service.requestLifecycle.getDecisionReceipt(
        "conversation",
        "request",
        wait.generation,
        "yes",
      ),
    ).toEqual(decision.receipt);
  });
});
