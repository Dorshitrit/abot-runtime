import { describe, expect, test } from "vitest";
import { dynamicApprovalFixture } from "./support/dynamic-tool-approval-fixture.js";

function saved(prepared: { snapshot: unknown }): Record<string, unknown> {
  return JSON.parse(JSON.stringify(prepared.snapshot));
}

describe("dynamic tool approval continuation", () => {
  test("restores and executes an explicitly granted FULL+ approval without asking twice", async () => {
    const f = dynamicApprovalFixture({ mode: "full_plus", demand: true });
    const prepared = await f.prepare();
    const snapshot = saved(prepared);
    expect(snapshot.requiresApproval).toBe(true);
    expect(f.nextApprovalId).toHaveBeenCalledOnce();
    const restored = await f.createExecutor().restore(snapshot);
    if (restored.status !== "prepared") throw new Error("expected restore");
    expect(restored.approvalRequest).toEqual(prepared.approvalRequest);
    expect(restored.actionFingerprint).toBe(prepared.actionFingerprint);
    expect(f.nextApprovalId).toHaveBeenCalledOnce();
    expect(f.implementation).not.toHaveBeenCalled();
    restored.applyApprovalDecision({
      approvalId: restored.approvalRequest!.approvalId,
      actionFingerprint: restored.actionFingerprint,
      decision: { approved: true },
      recorded: true,
    });
    await expect(restored.execute()).resolves.toMatchObject({ status: "executed" });
    expect(f.requestApproval).not.toHaveBeenCalled();
    expect(f.implementation).toHaveBeenCalledOnce();
    expect(f.implementation.mock.calls[0]![1]?.executionAuthority).toEqual({
      toolPermissionMode: "full_plus", executionIdentity: "target:revision-1",
    });
    expect(f.onEvent.mock.calls.map(([name]) => name)).toEqual([
      "tool.started", "tool.completed",
    ]);
  });

  test("restored user rejection prevents the implementation", async () => {
    const f = dynamicApprovalFixture({ mode: "full_plus", demand: true });
    const prepared = await f.prepare();
    const restored = await f.createExecutor().restore(saved(prepared));
    if (restored.status !== "prepared") throw new Error("expected restore");
    restored.applyApprovalDecision({
      approvalId: restored.approvalRequest!.approvalId,
      actionFingerprint: restored.actionFingerprint,
      decision: { approved: false, reason: "User declined" },
      recorded: true,
    });
    await expect(restored.execute()).resolves.toMatchObject({
      status: "rejected", code: "tool_approval_rejected", message: "User declined",
    });
    expect(f.requestApproval).not.toHaveBeenCalled();
    expect(f.implementation).not.toHaveBeenCalled();
  });

  test.each([[false, true], [true, false]] as const)(
    "rejects changed approval policy from %s to %s at restore",
    async (before, after) => {
      const f = dynamicApprovalFixture({ mode: "full_plus", demand: before });
      const prepared = await f.prepare();
      f.state.demand = after;
      await expect(f.createExecutor().restore(saved(prepared)))
        .rejects.toThrow("registered_tool_snapshot_incompatible");
      expect(f.requestApproval).not.toHaveBeenCalled();
      expect(f.implementation).not.toHaveBeenCalled();
    },
  );

  test("rejects changed target identity instead of applying an old approval to it", async () => {
    const f = dynamicApprovalFixture({ mode: "full_access", demand: true });
    const prepared = await f.prepare();
    f.state.identity = "target:revision-2";
    await expect(f.createExecutor().restore(saved(prepared)))
      .rejects.toThrow("registered_tool_snapshot_incompatible");
    expect(f.implementation).not.toHaveBeenCalled();
  });

  test("rejects a saved demanded action whose pending approval is missing", async () => {
    const f = dynamicApprovalFixture({ mode: "full_plus", demand: true });
    const prepared = await f.prepare();
    const snapshot = saved(prepared);
    delete snapshot.approvalRequest;
    await expect(f.createExecutor().restore(snapshot))
      .rejects.toThrow("registered_tool_snapshot_incompatible");
    expect(f.implementation).not.toHaveBeenCalled();
  });

  test("cannot remove a saved dynamic requirement while keeping the old fingerprint", async () => {
    const f = dynamicApprovalFixture({ mode: "full_plus", demand: true });
    const prepared = await f.prepare();
    const snapshot = saved(prepared);
    delete snapshot.requiresApproval;
    await expect(f.createExecutor().restore(snapshot))
      .rejects.toThrow("registered_tool_snapshot_incompatible");
    expect(f.implementation).not.toHaveBeenCalled();
  });

  test("omitted and false requirements preserve legacy fingerprints and saved shapes", async () => {
    const f = dynamicApprovalFixture({ mode: "full_access" });
    const legacy = await f.prepare();
    expect(saved(legacy)).not.toHaveProperty("requiresApproval");
    f.state.demand = false;
    const explicitFalse = await f.prepare();
    expect(explicitFalse.actionFingerprint).toBe(legacy.actionFingerprint);
    expect(saved(explicitFalse)).not.toHaveProperty("requiresApproval");
    const restored = await f.createExecutor().restore(saved(legacy));
    if (restored.status !== "prepared") throw new Error("expected restore");
    expect(restored.approvalRequest).toBeUndefined();
    await expect(restored.execute()).resolves.toMatchObject({ status: "executed" });
    expect(f.requestApproval).not.toHaveBeenCalled();
  });

  test("the same identity and tool parameters produce a different fingerprint when approval is demanded", async () => {
    const f = dynamicApprovalFixture({ mode: "full_plus", demand: false });
    const automatic = await f.prepare();
    f.state.demand = true;
    const guarded = await f.prepare();
    expect(guarded.acceptedControls).toEqual(automatic.acceptedControls);
    expect(guarded.actionFingerprint).not.toBe(automatic.actionFingerprint);
    expect(guarded.approvalRequest).toBeDefined();
  });
});
