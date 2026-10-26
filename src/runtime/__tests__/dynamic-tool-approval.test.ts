import { describe, expect, test } from "vitest";
import {
  deferredBinding,
  dynamicApprovalFixture,
  type ExecutionBinding,
} from "./support/dynamic-tool-approval-fixture.js";

describe("tool-owned dynamic approval", () => {
  test.each(["ask", "full_access", "full_plus"] as const)(
    "requires an actual user decision in %s when the tool demands approval",
    async (mode) => {
      const f = dynamicApprovalFixture({ mode, demand: true });
      const prepared = await f.prepare();
      expect(prepared.approvalRequest).toBeDefined();
      expect(f.requestApproval).not.toHaveBeenCalled();
      expect(f.implementation).not.toHaveBeenCalled();
      await expect(prepared.execute()).resolves.toMatchObject({ status: "executed" });
      expect(f.requestApproval).toHaveBeenCalledOnce();
      expect(f.requestApproval.mock.calls[0]![0].approvalId)
        .toBe(prepared.approvalRequest!.approvalId);
      expect(f.implementation).toHaveBeenCalledOnce();
      expect(f.onEvent.mock.calls.map(([name]) => name)).toEqual([
        "tool.approval.required", "tool.approval.granted", "tool.started", "tool.completed",
      ]);
    },
  );

  test.each(["ask", "full_access", "full_plus"] as const)(
    "denial prevents all tool effects in %s",
    async (mode) => {
      const f = dynamicApprovalFixture({ mode, demand: true, approved: false });
      const prepared = await f.prepare();
      await expect(prepared.execute()).resolves.toMatchObject({
        status: "rejected", code: "tool_approval_rejected",
      });
      expect(f.requestApproval).toHaveBeenCalledOnce();
      expect(f.implementation).not.toHaveBeenCalled();
      expect(f.onEvent.mock.calls.map(([name]) => name)).toEqual([
        "tool.approval.required", "tool.approval.rejected",
      ]);
    },
  );

  test.each([
    ["ask", true], ["full_access", false], ["full_plus", false],
  ] as const)("an explicit false preserves existing %s policy", async (mode, required) => {
    const f = dynamicApprovalFixture({ mode, demand: false });
    const prepared = await f.prepare();
    expect(Boolean(prepared.approvalRequest)).toBe(required);
    await expect(prepared.execute()).resolves.toMatchObject({ status: "executed" });
    expect(f.requestApproval).toHaveBeenCalledTimes(required ? 1 : 0);
    expect(f.implementation).toHaveBeenCalledOnce();
  });

  test("an explicit false cannot weaken an operation's existing forced approval", async () => {
    const f = dynamicApprovalFixture({
      mode: "full_access", demand: false, staticApproval: "always", approved: false,
    });
    const prepared = await f.prepare();
    expect(prepared.approvalRequest).toBeDefined();
    await expect(prepared.execute()).resolves.toMatchObject({ status: "rejected" });
    expect(f.implementation).not.toHaveBeenCalled();
  });

  test.each(["ask", "full_access", "full_plus"] as const)(
    "tools without an execution binding retain their existing %s behavior",
    async (mode) => {
      const f = dynamicApprovalFixture({ mode, withoutBinding: true });
      const prepared = await f.prepare();
      expect(Boolean(prepared.approvalRequest)).toBe(mode === "ask");
      await expect(prepared.execute()).resolves.toMatchObject({ status: "executed" });
      expect(f.binding).not.toHaveBeenCalled();
      expect(f.requestApproval).toHaveBeenCalledTimes(mode === "ask" ? 1 : 0);
    },
  );

  test("legacy synchronous binding remains supported", async () => {
    const f = dynamicApprovalFixture({
      mode: "full_plus",
      binding: () => ({ identity: "legacy-destination" }),
    });
    const prepared = await f.prepare();
    expect(prepared.approvalRequest).toBeUndefined();
    await expect(prepared.execute()).resolves.toMatchObject({ status: "executed" });
    expect(f.requestApproval).not.toHaveBeenCalled();
    expect(f.implementation.mock.calls[0]![1]?.executionAuthority).toEqual({
      toolPermissionMode: "full_plus", executionIdentity: "legacy-destination",
    });
  });

  test("a demanded approval fails closed without an approval controller in FULL+", async () => {
    const f = dynamicApprovalFixture({
      mode: "full_plus", demand: true, withoutController: true,
    });
    const prepared = await f.prepare();
    await expect(prepared.execute()).resolves.toMatchObject({
      status: "rejected", code: "tool_approval_unavailable",
    });
    expect(f.implementation).not.toHaveBeenCalled();
    expect(f.onEvent.mock.calls.map(([name]) => name)).not.toContain("tool.started");
  });

  test("unconditional tool approval does not recommend bypassing it with FULL+", async () => {
    const f = dynamicApprovalFixture({
      mode: "full_access", demand: true, staticApproval: "always",
    });
    const prepared = await f.prepare();
    await prepared.execute();
    const required = f.onEvent.mock.calls.find(([name]) => name === "tool.approval.required");
    expect(required).toBeDefined();
    expect(required![1]).not.toHaveProperty("recommendedToolPermissionMode");
  });

  test("passes trusted request authority to binding and implementation, never model hints", async () => {
    const f = dynamicApprovalFixture({ mode: "full_access", demand: true });
    const forged = {
      query: "selected-target",
      toolPermissionMode: "full_plus",
      executionIdentity: "forged-target",
    };
    const prepared = await f.prepare(forged);
    expect(f.binding.mock.calls[0]![1]).toMatchObject({
      toolPermissionMode: "full_access", sessionId: "bound-session", abortSignal: f.abort.signal,
    });
    expect(f.implementation).not.toHaveBeenCalled();
    await prepared.execute();
    expect(f.implementation.mock.calls[0]![0]).toEqual(forged);
    expect(f.implementation.mock.calls[0]![1]?.executionAuthority).toEqual({
      toolPermissionMode: "full_access", executionIdentity: "target:revision-1",
    });
  });

  test("keeps binding disclosure in human approval metadata, outside model controls and results", async () => {
    const f = dynamicApprovalFixture({ mode: "full_plus", demand: true });
    const prepared = await f.prepare();
    expect(prepared.acceptedControls).toEqual({ query: "selected-target" });
    expect(prepared.approvalRequest!.call.params).toEqual({ query: "selected-target" });
    expect(prepared.approvalRequest!.meta).toMatchObject({
      destinationLabel: "Private target disclosure",
    });
    const result = await prepared.execute();
    expect(result.status).toBe("executed");
    if (result.status !== "executed") throw new Error("expected execution");
    expect(JSON.stringify(result.result)).not.toContain("Private target disclosure");
    expect(JSON.stringify(result.result)).not.toContain("target:revision-1");
  });

  test("waits for async binding before allocating approval or starting the tool", async () => {
    const pending = deferredBinding();
    const f = dynamicApprovalFixture({ binding: () => pending.promise });
    let settled = false;
    const preparing = f.executor.prepare(f.input).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(f.binding).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    expect(f.nextApprovalId).not.toHaveBeenCalled();
    expect(f.implementation).not.toHaveBeenCalled();
    pending.resolve({ identity: "resolved-target", requiresApproval: true });
    const prepared = await preparing;
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") throw new Error("expected preparation");
    expect(prepared.approvalRequest).toBeDefined();
    expect(f.implementation).not.toHaveBeenCalled();
  });

  test("preserves cancellation while an asynchronous binding is in flight", async () => {
    const pending = deferredBinding();
    const f = dynamicApprovalFixture({ binding: () => pending.promise });
    const preparing = f.executor.prepare(f.input);
    await Promise.resolve();
    const reason = new DOMException("Cancelled during binding", "AbortError");
    f.abort.abort(reason);
    await expect(preparing).rejects.toBe(reason);
    pending.resolve({ identity: "resolved-target", requiresApproval: true });
    expect(f.nextApprovalId).not.toHaveBeenCalled();
    expect(f.requestApproval).not.toHaveBeenCalled();
    expect(f.implementation).not.toHaveBeenCalled();
  });

  test("an async binding failure cannot fall through to automatic execution", async () => {
    const f = dynamicApprovalFixture({
      mode: "full_plus",
      binding: async () => { throw new Error("target cannot be loaded"); },
    });
    await expect(f.executor.execute(f.input)).resolves.toMatchObject({
      status: "rejected", code: "normal_invocation_execution_binding_unavailable",
    });
    expect(f.requestApproval).not.toHaveBeenCalled();
    expect(f.implementation).not.toHaveBeenCalled();
  });

  test.each(["true", 1, null])("rejects malformed approval demand %s", async (requiresApproval) => {
    const f = dynamicApprovalFixture({
      mode: "full_plus",
      binding: async () => ({
        identity: "target", requiresApproval,
      } as unknown as Awaited<ReturnType<ExecutionBinding>>),
    });
    await expect(f.executor.execute(f.input)).resolves.toMatchObject({
      status: "rejected", code: "normal_invocation_execution_binding_unavailable",
    });
    expect(f.implementation).not.toHaveBeenCalled();
  });
});
