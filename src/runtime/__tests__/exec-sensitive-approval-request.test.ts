import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ToolApprovalController, ToolApprovalDecision } from "../ports.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";
import {
  createExecApprovalFixture,
  EXEC_APPROVAL_COMMANDS,
} from "./support/exec-sensitive-approval-fixture.js";
import { EXEC_APPROVAL_FINAL } from "./support/exec-sensitive-approval-script.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  await disposeCompositionFixtures();
  resetDebugLoggerConfig();
});
const policies = ["execution-agent-v1", "supervisor-worker-v1"] as const;
const approvingCases = policies.flatMap((policy) =>
  (["ask", "full_access"] as const).map((mode) => ({ policy, mode })),
);

test("every EXEC operation declares sensitivity at its owning manifest", async () => {
  const fixture = await createExecApprovalFixture();
  const registrations = fixture.registry.listNormalInvocations!();
  for (const tool of ["exec", "exec_wait", "exec_cancel"]) {
    const registration = registrations.find(
      ({ toolName }) => toolName === tool,
    );
    expect(registration, tool).toBeDefined();
    expect(registration!.contract.operations).toHaveLength(1);
    expect(registration!.contract.operations[0]!.approval).toBe("always");
  }
});

test.each(approvingCases)(
  "$policy $mode approves each exact action before effects",
  async ({ policy, mode }) => {
    const fixture = await createExecApprovalFixture();
    const decisions: Array<(decision: ToolApprovalDecision) => void> = [];
    const requestToolApproval = vi.fn<
      ToolApprovalController["requestToolApproval"]
    >(() => new Promise((resolve) => decisions.push(resolve)));
    const run = fixture.start({
      policy,
      mode,
      approval: { requestToolApproval },
      commandCount: 2,
    });
    try {
      await vi.waitFor(() => expect(decisions).toHaveLength(1), {
        timeout: 1000,
      });
      expect(fixture.execute).not.toHaveBeenCalled();
      await expect(
        access(join(fixture.config.paths.agentWorkDir, "first.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(requestToolApproval.mock.calls[0]![0].call).toEqual({
        tool: "exec",
        params: { command: EXEC_APPROVAL_COMMANDS[0], cwd: "." },
      });
      decisions[0]!({ approved: true });
      await vi.waitFor(() => expect(decisions).toHaveLength(2), {
        timeout: 1000,
      });
      expect(fixture.execute).toHaveBeenCalledOnce();
      await expect(
        readFile(join(fixture.config.paths.agentWorkDir, "first.txt"), "utf8"),
      ).resolves.toBe("first");
      await expect(
        access(join(fixture.config.paths.agentWorkDir, "second.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(requestToolApproval.mock.calls[1]![0].call).toEqual({
        tool: "exec",
        params: { command: EXEC_APPROVAL_COMMANDS[1], cwd: "." },
      });
      for (const [
        index,
        [request],
      ] of requestToolApproval.mock.calls.entries()) {
        expect(request.meta).toMatchObject({
          command: EXEC_APPROVAL_COMMANDS[index],
          cwd: ".",
        });
      }
      decisions[1]!({ approved: true });
      await expect(run.pending).resolves.toMatchObject({
        output: EXEC_APPROVAL_FINAL,
      });
      expect(fixture.execute).toHaveBeenCalledTimes(2);
      for (const [, context] of fixture.execute.mock.calls) {
        expect(context?.sharedState?.requestContext?.toolPermissionMode).toBe(
          mode,
        );
      }
      await expect(
        readFile(join(fixture.config.paths.agentWorkDir, "second.txt"), "utf8"),
      ).resolves.toBe("second");
      const required = fixture.onEvent.mock.calls.filter(
        ([name]) => name === "tool.approval.required",
      );
      expect(required).toHaveLength(2);
      for (const [, event] of required) {
        expect(event.recommendedToolPermissionMode).toBe(
          mode === "full_access" ? "full_plus" : undefined,
        );
      }
      expect(fixture.onAnswerToken).toHaveBeenCalledExactlyOnceWith(
        EXEC_APPROVAL_FINAL,
      );
      const settlements = fixture.onEvent.mock.calls
        .filter(([name]) => name === "tool.completed")
        .map(([, event]) => event);
      expect(settlements).toHaveLength(2);
      for (const settlement of settlements) {
        expect(settlement).toMatchObject({ tool: "exec", ok: true });
      }
      expect(run.model.invokeRaw).not.toHaveBeenCalled();
    } finally {
      fixture.controller.abort();
      for (const decide of decisions) decide({ approved: false });
      await run.pending.catch(() => undefined);
    }
  },
);

test.each(policies)(
  "%s FULL+ dispatches without a second ABot approval",
  async (policy) => {
    const fixture = await createExecApprovalFixture();
    const requestToolApproval =
      vi.fn<ToolApprovalController["requestToolApproval"]>();
    const run = fixture.start({
      policy,
      mode: "full_plus",
      approval: { requestToolApproval },
    });
    await expect(run.pending).resolves.toMatchObject({
      output: EXEC_APPROVAL_FINAL,
    });
    expect(requestToolApproval).not.toHaveBeenCalled();
    expect(fixture.execute).toHaveBeenCalledOnce();
    await expect(
      readFile(join(fixture.config.paths.agentWorkDir, "first.txt"), "utf8"),
    ).resolves.toBe("first");
    expect(
      fixture.onEvent.mock.calls.some(([name]) =>
        name.startsWith("tool.approval."),
      ),
    ).toBe(false);
  },
);

test.each(approvingCases)(
  "$policy $mode rejects denied or unavailable approval without effects",
  async ({ policy, mode }) => {
    for (const rejected of [true, false]) {
      const fixture = await createExecApprovalFixture();
      const requestToolApproval = vi.fn(async () => ({
        approved: false,
        reason: "owner rejected",
      }));
      const run = fixture.start({
        policy,
        mode,
        ...(rejected ? { approval: { requestToolApproval } } : {}),
      });
      await expect(run.pending).resolves.toMatchObject({
        output: EXEC_APPROVAL_FINAL,
      });
      expect(fixture.execute).not.toHaveBeenCalled();
      await expect(
        access(join(fixture.config.paths.agentWorkDir, "first.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const expected = rejected
        ? "tool_approval_rejected"
        : "tool_approval_unavailable";
      expect(JSON.stringify(run.model.invoke.mock.calls)).toContain(expected);
      expect(
        fixture.onEvent.mock.calls.some(([name]) => name === "tool.started"),
      ).toBe(false);
    }
  },
);

test.each(approvingCases)(
  "$policy $mode cancellation wins over a late approval",
  async ({ policy, mode }) => {
    const fixture = await createExecApprovalFixture();
    const requestToolApproval = vi.fn<
      ToolApprovalController["requestToolApproval"]
    >(async (_input, options) => {
      const signal = options?.abortSignal;
      if (!signal)
        throw new Error("Approval fixture requires a cancellation signal");
      expect(signal).toBe(fixture.controller.signal);
      expect(signal.aborted).toBe(false);
      fixture.controller.abort(new Error("owner cancelled"));
      return { approved: true };
    });
    const run = fixture.start({
      policy,
      mode,
      approval: { requestToolApproval },
    });
    await run.pending.catch(() => undefined);
    expect(requestToolApproval).toHaveBeenCalledOnce();
    expect(fixture.controller.signal.aborted).toBe(true);
    expect(fixture.execute).not.toHaveBeenCalled();
    await expect(
      access(join(fixture.config.paths.agentWorkDir, "first.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      fixture.onEvent.mock.calls.some(([name]) => name === "tool.started"),
    ).toBe(false);
  },
);

test.each(policies)(
  "%s FULL still executes an ordinary operation without approval",
  async (policy) => {
    const fixture = await createExecApprovalFixture();
    const requestToolApproval =
      vi.fn<ToolApprovalController["requestToolApproval"]>();
    const run = fixture.start({
      policy,
      mode: "full_access",
      ordinary: true,
      approval: { requestToolApproval },
    });
    await expect(run.pending).resolves.toMatchObject({
      output: EXEC_APPROVAL_FINAL,
    });
    expect(requestToolApproval).not.toHaveBeenCalled();
    expect(fixture.ordinaryRead).toHaveBeenCalledOnce();
    expect(fixture.execute).not.toHaveBeenCalled();
  },
);

test.each(
  policies.flatMap((policy) =>
    (["ask", "full_access", "full_plus"] as const).map((mode) => ({
      policy,
      mode,
    })),
  ),
)(
  "$policy $mode never restores a disabled EXEC plugin",
  async ({ policy, mode }) => {
    const fixture = await createExecApprovalFixture(true);
    const run = fixture.start({
      policy,
      mode,
      ordinary: true,
      approval: { requestToolApproval: async () => ({ approved: true }) },
    });
    await expect(run.pending).resolves.toMatchObject({
      output: EXEC_APPROVAL_FINAL,
    });
    const modelInputs = JSON.stringify(
      run.model.invoke.mock.calls.map(([input]) => ({
        messages: input.messages,
        format: input.format,
      })),
    );
    for (const tool of ["exec", "exec_wait", "exec_cancel"])
      expect(fixture.registry.getDefinition(tool)).toBeUndefined();
    for (const operation of [
      "execute_command",
      "wait_for_process",
      "cancel_process",
    ])
      expect(modelInputs).not.toContain(operation);
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.ordinaryRead).toHaveBeenCalledOnce();
  },
);
