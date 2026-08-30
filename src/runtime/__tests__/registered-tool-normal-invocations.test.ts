import { describe, expect, test, vi } from "vitest";

import { createRegisteredToolNormalInvocationExecutor } from "../adapters/registered-tool-normal-invocations.js";
import type {
  RegisteredToolNormalInvocation,
  ToolCallAdapter,
  ToolNormalInvocationEffect,
  ToolNormalInvocationOperation,
} from "../../capabilities/tool-types.js";
import type { ToolApprovalController, ToolRegistry } from "../ports.js";

describe("registered ordinary tool invocation executor", () => {
  test("prepares an exact normalized action identity without starting the tool", async () => {
    const execute = vi.fn(async () => ({
      ok: true,
      tool: "inspect_target",
      output: "selected lines",
      producedNewInformation: true,
    }));
    const onEvent = vi.fn();
    const inspectOperation: ToolNormalInvocationOperation = {
      operationId: "inspect_target",
      summary: "Read one exact file range.",
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", minLength: 1, maxLength: 4_096 },
          start_line: { type: "integer", minimum: 1, maximum: 1_000_000 },
          end_line: { type: "integer", minimum: 1, maximum: 1_000_000 },
        },
        required: ["path", "start_line", "end_line"],
      },
      effect: "read_only",
      approval: "request_policy",
    };
    const executor = createExecutor({
      registrations: [
        {
          toolName: "inspect_target",
          definition: {
            name: "inspect_target",
            routingCapability: "semantic_lookup",
            executionEffect: "read_only",
            params: {
              path: "string",
              start_line: "number",
              end_line: "number",
            },
          },
          contract: { version: 1, operations: [inspectOperation] },
        },
      ],
      execute,
      onEvent,
    });
    const handle = executor.operations[0]!.handle;

    const first = executor.prepare({
      handle,
      controls: { path: "notes.txt", start_line: 1, end_line: 20 },
      intent: "Read the first range.",
    });
    const sameActionDifferentIntent = executor.prepare({
      handle,
      controls: { end_line: 20, path: "notes.txt", start_line: 1 },
      intent: "Use different presentation text.",
    });
    const differentRange = executor.prepare({
      handle,
      controls: { path: "notes.txt", start_line: 21, end_line: 40 },
    });

    expect(first.status).toBe("prepared");
    expect(sameActionDifferentIntent.status).toBe("prepared");
    expect(differentRange.status).toBe("prepared");
    if (
      first.status !== "prepared" ||
      sameActionDifferentIntent.status !== "prepared" ||
      differentRange.status !== "prepared"
    ) {
      throw new Error("expected prepared normal invocations");
    }
    expect(first.actionFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.acceptedControls).toEqual({
      path: "notes.txt",
      start_line: 1,
      end_line: 20,
    });
    expect(Object.isFrozen(first.acceptedControls)).toBe(true);
    expect(sameActionDifferentIntent.actionFingerprint).toBe(
      first.actionFingerprint,
    );
    expect(sameActionDifferentIntent.acceptedControls).toEqual(
      first.acceptedControls,
    );
    expect(differentRange.acceptedControls).toEqual({
      path: "notes.txt",
      start_line: 21,
      end_line: 40,
    });
    expect(differentRange.actionFingerprint).not.toBe(first.actionFingerprint);
    expect(execute).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();

    await expect(first.execute()).resolves.toMatchObject({
      status: "executed",
      effect: "read_only",
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(onEvent.mock.calls.map(([name]) => name)).toEqual([
      "tool.started",
      "tool.completed",
    ]);
  });

  test("keeps distinct web-query values as distinct normalized actions", () => {
    const execute = vi.fn(async () => ({
      ok: true,
      tool: "web_search",
      output: "current sources",
      producedNewInformation: true,
    }));
    const executor = createExecutor({
      registrations: [registration("web_search", operation())],
      execute,
    });
    const handle = executor.operations[0]!.handle;
    const first = executor.prepare({
      handle,
      controls: { query: "runtime supervision" },
      intent: "Search for the first topic.",
    });
    const sameQuery = executor.prepare({
      handle,
      controls: { query: "runtime supervision" },
      intent: "Use different presentation text.",
    });
    const differentQuery = executor.prepare({
      handle,
      controls: { query: "batch execution contracts" },
      intent: "Search for the second topic.",
    });

    expect(first.status).toBe("prepared");
    expect(sameQuery.status).toBe("prepared");
    expect(differentQuery.status).toBe("prepared");
    if (
      first.status !== "prepared" ||
      sameQuery.status !== "prepared" ||
      differentQuery.status !== "prepared"
    ) {
      throw new Error("expected prepared web-search invocations");
    }
    expect(sameQuery.actionFingerprint).toBe(first.actionFingerprint);
    expect(differentQuery.actionFingerprint).not.toBe(first.actionFingerprint);
    expect(execute).not.toHaveBeenCalled();
  });

  test("executes one opaque captured operation and forwards neutral result and events", async () => {
    const executionResult = {
      ok: true,
      tool: "lookup",
      output: "current sources",
      progress: true,
      producedNewInformation: true,
      actions: [{ type: "unknown" as const }],
      data: { eventMeta: { sourceCount: 2 } },
    };
    const execute = vi.fn(async () => executionResult);
    const onEvent = vi.fn();
    const executor = createExecutor({
      registrations: [registration("lookup", operation())],
      execute,
      onEvent,
    });

    const result = await executor.execute({
      handle: executor.operations[0]!.handle,
      controls: { query: "runtime contracts" },
      intent: "Collect current authoritative sources.",
    });

    expect(execute).toHaveBeenCalledWith(
      { tool: "lookup", params: { query: "runtime contracts" } },
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
    );
    expect(result).toMatchObject({
      status: "executed",
      effect: "read_only",
      result: { ok: true, output: "current sources" },
    });
    expect(result.status === "executed" ? result.result : undefined).toBe(
      executionResult,
    );
    expect(
      result.status === "executed" ? result.completionActions : undefined,
    ).toEqual([{ type: "unknown" }]);
    expect(
      result.status === "executed"
        ? Object.isFrozen(result.completionActions)
        : false,
    ).toBe(true);
    expect(Object.keys(result)).toEqual([
      "status",
      "effect",
      "result",
      "completionActions",
    ]);
    expect(onEvent.mock.calls.map(([name]) => name)).toEqual([
      "tool.started",
      "tool.completed",
    ]);
    expect(onEvent.mock.calls[0]?.[1]).toEqual({
      tool: "lookup",
      intent: "Collect current authoritative sources.",
      intentSource: "model",
      meta: {
        params: { query: "string(len=17)" },
        intent: "Collect current authoritative sources.",
      },
    });
    expect(onEvent.mock.calls[1]?.[1]).toMatchObject({
      tool: "lookup",
      ok: true,
      actions: [{ type: "unknown" }],
      meta: { sourceCount: 2, actionTypes: ["unknown"] },
    });
  });

  test("projects completed actions without implementation targets or details", async () => {
    const sensitiveTarget =
      "/private/runtime/agent-work/request-1/artifact.txt";
    const sensitiveDetails = "private implementation detail";
    const onEvent = vi.fn();
    const executor = createExecutor({
      registrations: [registration("lookup", operation())],
      execute: vi.fn(async () => ({
        ok: true,
        tool: "lookup",
        output: "done",
        progress: true,
        producedNewInformation: true,
        actions: [
          {
            type: "establish_target" as const,
            target: sensitiveTarget,
            details: sensitiveDetails,
          },
        ],
      })),
      onEvent,
    });

    const result = await executor.execute({
      handle: executor.operations[0]!.handle,
      controls: { query: "runtime contracts" },
    });

    expect(
      result.status === "executed" ? result.completionActions : undefined,
    ).toEqual([{ type: "establish_target" }]);
    expect(
      result.status === "executed"
        ? Object.isFrozen(result.completionActions[0])
        : false,
    ).toBe(true);
    expect(onEvent.mock.calls[1]?.[1]).toMatchObject({
      tool: "lookup",
      ok: true,
      actions: [{ type: "establish_target" }],
      meta: { actionTypes: ["establish_target"] },
    });
    expect(JSON.stringify(onEvent.mock.calls)).not.toContain(sensitiveTarget);
    expect(JSON.stringify(onEvent.mock.calls)).not.toContain(sensitiveDetails);
  });

  test("emits a failed execution through the existing started/completed lifecycle", async () => {
    const execute = vi.fn(async () => ({
      ok: false,
      tool: "lookup",
      output: "Lookup failed.",
      progress: false,
      error: "Lookup failed.",
      errorCode: "lookup_failed",
    }));
    const onEvent = vi.fn();
    const executor = createExecutor({
      registrations: [registration("lookup", operation())],
      execute,
      onEvent,
    });

    await expect(
      executor.execute({
        handle: executor.operations[0]!.handle,
        controls: { query: "runtime contracts" },
        intent: "Collect current authoritative sources.",
      }),
    ).resolves.toMatchObject({
      status: "executed",
      result: { ok: false, errorCode: "lookup_failed" },
    });

    expect(onEvent.mock.calls.map(([name]) => name)).toEqual([
      "tool.started",
      "tool.completed",
    ]);
    expect(onEvent.mock.calls[1]?.[1]).toEqual({
      tool: "lookup",
      ok: false,
      actions: [],
      meta: {
        params: { query: "string(len=17)" },
        errorCode: "lookup_failed",
      },
    });
  });

  test("accepts only the exact opaque handle issued by one executor", async () => {
    const execute = vi.fn();
    const first = createExecutor({
      registrations: [registration("lookup", operation())],
      execute,
    });
    const second = createExecutor({
      registrations: [registration("lookup", operation())],
      execute,
    });
    const forged = {
      ...first.operations[0]!.handle,
    } as (typeof first.operations)[number]["handle"];

    expect(Object.isFrozen(first.operations)).toBe(true);
    expect(Object.isFrozen(first.operations[0]?.handle)).toBe(true);
    for (const handle of [forged, second.operations[0]!.handle]) {
      await expect(
        first.execute({ handle, controls: { query: "x" } }),
      ).resolves.toEqual({
        status: "rejected",
        code: "normal_invocation_handle_invalid",
        message:
          "The selected ordinary capability is not registered for this request.",
      });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  test("validates the complete source call, normalizes once, then validates the exact target", async () => {
    const order: string[] = [];
    const sourceValidate = vi.fn((call) => {
      order.push("source.validate");
      expect(call).toEqual({
        tool: "source",
        params: {
          query: "Roadmap",
          command: "create",
          body: "Complete body",
        },
      });
      return null;
    });
    const normalizeCall = vi.fn(({ params }) => {
      order.push("source.normalize");
      return { tool: "target", params };
    });
    const targetValidate = vi.fn(() => {
      order.push("target.validate");
      return null;
    });
    const execute = vi.fn(async (call) => {
      order.push("execute");
      return {
        ok: true,
        tool: call.tool,
        output: "created",
        producedNewInformation: true,
      };
    });
    const completeOperation = operation({
      effect: "mutating",
      fixedParams: { command: "create" },
      payload: {
        kind: "raw_text",
        param: "body",
        instructions: "Provide the complete body.",
        maxBytes: 1_024,
      },
    });
    const executor = createExecutor({
      registrations: [
        registration("source", completeOperation, {
          validateCall: sourceValidate,
          normalizeCall,
        }),
        registration("target", completeOperation, {
          validateCall: targetValidate,
        }),
      ],
      execute,
    });

    await expect(
      executor.execute({
        handle: executor.operations[0]!.handle,
        controls: { query: "Roadmap" },
        payload: "Complete body",
      }),
    ).resolves.toMatchObject({ status: "executed", effect: "mutating" });
    expect(normalizeCall).toHaveBeenCalledOnce();
    expect(order).toEqual([
      "source.validate",
      "source.normalize",
      "target.validate",
      "execute",
    ]);
  });

  test("rejects normalization to a tool outside the same filtered snapshot", async () => {
    const execute = vi.fn();
    const executor = createExecutor({
      registrations: [
        registration("source", operation(), {
          normalizeCall: ({ params }) => ({ tool: "excluded", params }),
        }),
      ],
      execute,
    });

    await expect(
      executor.execute({
        handle: executor.operations[0]!.handle,
        controls: { query: "x" },
      }),
    ).resolves.toEqual({
      status: "rejected",
      code: "normal_invocation_target_unavailable",
      message:
        "The normalized tool is not enabled in the selected request profile.",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  test("re-resolves and validates the normalized target operation", async () => {
    const sourceValidate = vi.fn(() => null);
    const targetValidate = vi.fn(() => ({
      error: "target rejected the normalized value",
    }));
    const execute = vi.fn();
    const executor = createExecutor({
      registrations: [
        registration("source", operation(), {
          validateCall: sourceValidate,
          normalizeCall: ({ params }) => ({ tool: "target", params }),
        }),
        registration("target", operation(), { validateCall: targetValidate }),
      ],
      execute,
    });

    const result = await executor.execute({
      handle: executor.operations[0]!.handle,
      controls: { query: "x" },
    });

    expect(sourceValidate).toHaveBeenCalledOnce();
    expect(targetValidate).toHaveBeenCalledWith({
      tool: "target",
      params: { query: "x" },
    });
    expect(result).toMatchObject({
      status: "rejected",
      code: "normal_invocation_target_call_invalid",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  test("rejects a normalized call that matches no exact target operation before its adapter", async () => {
    const normalizeCall = vi.fn(() => ({ tool: "target", params: {} }));
    const targetValidate = vi.fn(() => null);
    const execute = vi.fn();
    const executor = createExecutor({
      registrations: [
        registration("source", operation(), { normalizeCall }),
        registration("target", operation(), { validateCall: targetValidate }),
      ],
      execute,
    });

    await expect(
      executor.execute({
        handle: executor.operations[0]!.handle,
        controls: { query: "x" },
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "normal_invocation_target_ambiguous",
      message:
        "The normalized call does not match a registered ordinary operation.",
    });
    expect(normalizeCall).toHaveBeenCalledOnce();
    expect(targetValidate).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  test("fails closed when a source or target adapter validator throws", async () => {
    const execute = vi.fn();
    const source = createExecutor({
      registrations: [
        registration("source", operation(), {
          validateCall: () => {
            throw new Error("private source failure");
          },
        }),
      ],
      execute,
    });
    await expect(
      source.execute({
        handle: source.operations[0]!.handle,
        controls: { query: "x" },
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "normal_invocation_call_validation_failed",
    });

    const target = createExecutor({
      registrations: [
        registration("source", operation(), {
          normalizeCall: ({ params }) => ({ tool: "target", params }),
        }),
        registration("target", operation(), {
          validateCall: () => {
            throw new Error("private target failure");
          },
        }),
      ],
      execute,
    });
    await expect(
      target.execute({
        handle: target.operations[0]!.handle,
        controls: { query: "x" },
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "normal_invocation_target_call_validation_failed",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  test("fails closed on a malformed adapter validation result", async () => {
    const execute = vi.fn();
    const executor = createExecutor({
      registrations: [
        registration("source", operation(), {
          validateCall: (() => ({
            accepted: true,
          })) as unknown as ToolCallAdapter["validateCall"],
        }),
      ],
      execute,
    });

    await expect(
      executor.execute({
        handle: executor.operations[0]!.handle,
        controls: { query: "x" },
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "normal_invocation_call_validation_failed",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  test("approval receives the final normalized call including raw payload", async () => {
    let approvedCall: unknown;
    const requestToolApproval = vi.fn<
      ToolApprovalController["requestToolApproval"]
    >(async () => ({ approved: true }));
    const execute = vi.fn(async (call) => ({
      ok: true,
      tool: call.tool,
      output: "created",
      producedNewInformation: true,
    }));
    const executor = createExecutor({
      registrations: [
        registration(
          "document",
          operation({
            effect: "mutating",
            approval: "always",
            payload: {
              kind: "raw_text",
              param: "body",
              instructions: "Write the complete body.",
              maxBytes: 1_024,
            },
          }),
        ),
      ],
      execute,
      toolPermissionMode: "full_access",
      toolApprovalController: { requestToolApproval },
    });

    await executor.execute({
      handle: executor.operations[0]!.handle,
      controls: { query: "Roadmap" },
      payload: "Complete document body",
    });

    expect(requestToolApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "request-1",
        call: {
          tool: "document",
          params: {
            query: "Roadmap",
            body: "Complete document body",
          },
        },
      }),
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
    );
    approvedCall = requestToolApproval.mock.calls[0]?.[0].call;
    expect(Object.isFrozen(approvedCall)).toBe(true);
    expect(Object.isFrozen((approvedCall as { params: object }).params)).toBe(
      true,
    );
    expect(execute.mock.calls[0]?.[0]).toBe(approvedCall);
    expect(execute).toHaveBeenCalledOnce();
  });

  test("preserves the established normalized approval/start and source completion identities", async () => {
    const intent = "Collect current authoritative sources.";
    const requestToolApproval = vi.fn<
      ToolApprovalController["requestToolApproval"]
    >(async () => ({ approved: true }));
    const execute = vi.fn(async (call) => ({
      ok: true,
      tool: call.tool,
      output: "current sources",
      progress: true,
      producedNewInformation: true,
    }));
    const onEvent = vi.fn();
    const executor = createExecutor({
      registrations: [
        registration("source", operation(), {
          normalizeCall: ({ params }) => ({ tool: "target", params }),
        }),
        registration("target", operation()),
      ],
      execute,
      onEvent,
      toolPermissionMode: "ask",
      toolApprovalController: { requestToolApproval },
    });

    await expect(
      executor.execute({
        handle: executor.operations[0]!.handle,
        controls: { query: "runtime contracts" },
        intent,
      }),
    ).resolves.toMatchObject({ status: "executed" });

    expect(onEvent.mock.calls).toEqual([
      [
        "tool.approval.required",
        {
          approvalId: "approval-1",
          tool: "target",
          meta: { params: { query: "string(len=17)" }, intent },
        },
      ],
      ["tool.approval.granted", { approvalId: "approval-1", tool: "target" }],
      [
        "tool.started",
        {
          tool: "target",
          intent,
          intentSource: "model",
          meta: { params: { query: "string(len=17)" }, intent },
        },
      ],
      [
        "tool.completed",
        {
          tool: "source",
          ok: true,
          actions: [],
          meta: { params: { query: "string(len=17)" } },
        },
      ],
    ]);
    const lifecycleMeta = onEvent.mock.calls[0]?.[1].meta;
    expect(requestToolApproval.mock.calls[0]?.[0].meta).toBe(lifecycleMeta);
    expect(onEvent.mock.calls[2]?.[1].meta).toBe(lifecycleMeta);
  });

  test("emits approval rejection metadata without starting the selected tool", async () => {
    const intent = "Collect current authoritative sources.";
    const requestToolApproval = vi.fn<
      ToolApprovalController["requestToolApproval"]
    >(async () => ({ approved: false, reason: "User declined." }));
    const execute = vi.fn();
    const onEvent = vi.fn();
    const executor = createExecutor({
      registrations: [registration("lookup", operation())],
      execute,
      onEvent,
      toolPermissionMode: "ask",
      toolApprovalController: { requestToolApproval },
    });

    await expect(
      executor.execute({
        handle: executor.operations[0]!.handle,
        controls: { query: "runtime contracts" },
        intent,
      }),
    ).resolves.toEqual({
      status: "rejected",
      code: "tool_approval_rejected",
      message: "User declined.",
    });

    expect(onEvent.mock.calls).toEqual([
      [
        "tool.approval.required",
        {
          approvalId: "approval-1",
          tool: "lookup",
          meta: { params: { query: "string(len=17)" }, intent },
        },
      ],
      [
        "tool.approval.rejected",
        {
          approvalId: "approval-1",
          tool: "lookup",
          reason: "User declined.",
        },
      ],
    ]);
    expect(execute).not.toHaveBeenCalled();
  });

  test("owns payload lifecycle identity without exposing it through the opaque projection", () => {
    const intent = "Author the requested document.";
    const onEvent = vi.fn();
    const executor = createExecutor({
      registrations: [
        registration(
          "document",
          operation({
            effect: "mutating",
            payload: {
              kind: "raw_text",
              param: "body",
              instructions: "Write the complete body.",
              maxBytes: 1_024,
            },
          }),
        ),
      ],
      execute: vi.fn(),
      onEvent,
    });
    const projection = executor.operations[0]!;

    expect(projection).not.toHaveProperty("toolName");
    expect(projection).not.toHaveProperty("eventIdentity");
    expect(JSON.stringify(projection)).not.toContain("document");
    const preparedStarted = executor.preparePayloadLifecycle({
      handle: projection.handle,
      controls: { query: "Roadmap" },
      intent,
      phase: "started",
    });
    expect(preparedStarted).toMatchObject({ status: "prepared" });
    expect(onEvent).not.toHaveBeenCalled();
    if (preparedStarted.status !== "prepared") {
      throw new Error("payload lifecycle preparation missing");
    }
    expect(preparedStarted.emit()).toEqual({ status: "emitted" });
    expect(
      executor.emitPayloadLifecycle({
        handle: projection.handle,
        controls: { query: "Roadmap" },
        intent,
        phase: "completed",
      }),
    ).toEqual({ status: "emitted" });
    expect(
      executor.emitPayloadLifecycle({
        handle: projection.handle,
        controls: { query: "Roadmap" },
        intent,
        phase: "failed",
        errorCode: "payload_invalid",
      }),
    ).toEqual({ status: "emitted" });

    expect(onEvent.mock.calls).toEqual([
      [
        "tool.payload.started",
        {
          tool: "document",
          outputParam: "body",
          payloadStage: 1,
          payloadStageCount: 1,
          meta: { params: { query: "string(len=7)" }, intent },
        },
      ],
      [
        "tool.payload.completed",
        {
          tool: "document",
          outputParam: "body",
          payloadStage: 1,
          payloadStageCount: 1,
          meta: { params: { query: "string(len=7)" }, intent },
          ok: true,
        },
      ],
      [
        "tool.payload.failed",
        {
          tool: "document",
          outputParam: "body",
          payloadStage: 1,
          payloadStageCount: 1,
          meta: { params: { query: "string(len=7)" }, intent },
          error: "payload_invalid",
        },
      ],
    ]);
    for (const [, payloadEvent] of onEvent.mock.calls) {
      expect(payloadEvent.meta.params).not.toHaveProperty("body");
    }
    expect(
      executor.emitPayloadLifecycle({
        handle: { ...projection.handle },
        controls: { query: "Roadmap" },
        intent,
        phase: "started",
      }),
    ).toMatchObject({
      status: "rejected",
      code: "normal_invocation_handle_invalid",
    });
  });

  test("a normalized target approval=always overrides full-access request policy", async () => {
    const requestToolApproval = vi.fn<
      ToolApprovalController["requestToolApproval"]
    >(async () => ({ approved: true }));
    const execute = vi.fn(async (call) => ({
      ok: true,
      tool: call.tool,
      output: "ok",
      producedNewInformation: true,
    }));
    const executor = createExecutor({
      registrations: [
        registration("source", operation(), {
          normalizeCall: ({ params }) => ({ tool: "target", params }),
        }),
        registration("target", operation({ approval: "always" })),
      ],
      execute,
      toolPermissionMode: "full_access",
      toolApprovalController: { requestToolApproval },
    });

    await executor.execute({
      handle: executor.operations[0]!.handle,
      controls: { query: "x" },
    });

    expect(requestToolApproval).toHaveBeenCalledOnce();
    expect(requestToolApproval.mock.calls[0]?.[0].call.tool).toBe("target");
    expect(execute).toHaveBeenCalledOnce();
  });

  test("rejects cross-effect normalization before approval or execution", async () => {
    const requestToolApproval =
      vi.fn<ToolApprovalController["requestToolApproval"]>();
    const execute = vi.fn();
    const targetValidate = vi.fn(() => null);
    const executor = createExecutor({
      registrations: [
        registration("source", operation(), {
          normalizeCall: ({ params }) => ({ tool: "target", params }),
        }),
        registration("target", operation({ effect: "mutating" }), {
          validateCall: targetValidate,
        }),
      ],
      execute,
      toolPermissionMode: "ask",
      toolApprovalController: { requestToolApproval },
    });

    const result = await executor.execute({
      handle: executor.operations[0]!.handle,
      controls: { query: "x" },
    });

    expect(targetValidate).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: "rejected",
      code: "normal_invocation_effect_changed",
    });
    expect(requestToolApproval).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});

function createExecutor(params: {
  registrations: readonly RegisteredToolNormalInvocation[];
  execute: ReturnType<typeof vi.fn>;
  onEvent?: (name: string, payload: Record<string, unknown>) => void;
  toolPermissionMode?: "full_access" | "ask";
  toolApprovalController?: ToolApprovalController;
}) {
  const abortController = new AbortController();
  return createRegisteredToolNormalInvocationExecutor({
    registrations: params.registrations,
    toolRegistry: { execute: params.execute as ToolRegistry["execute"] },
    requestId: "request-1",
    abortSignal: abortController.signal,
    toolPermissionMode: params.toolPermissionMode ?? "full_access",
    ...(params.toolApprovalController
      ? { toolApprovalController: params.toolApprovalController }
      : {}),
    nextApprovalId: () => "approval-1",
    ...(params.onEvent ? { onEvent: params.onEvent } : {}),
  });
}

function registration(
  toolName: string,
  invocationOperation: ToolNormalInvocationOperation,
  adapter?: ToolCallAdapter,
): RegisteredToolNormalInvocation {
  const fixedParams = Object.fromEntries(
    Object.entries(invocationOperation.fixedParams ?? {}).map(
      ([name, value]) => [
        name,
        typeof value === "number" ? "number" : typeof value,
      ],
    ),
  );
  return {
    toolName,
    definition: {
      name: toolName,
      routingCapability: "semantic_lookup",
      executionEffect: invocationOperation.effect,
      params: {
        query: "string",
        ...fixedParams,
        ...(invocationOperation.payload
          ? { [invocationOperation.payload.param]: "string" }
          : {}),
      },
    },
    contract: { version: 1, operations: [invocationOperation] },
    ...(adapter ? { adapter } : {}),
  };
}

function operation(
  params: {
    effect?: ToolNormalInvocationEffect;
    approval?: "request_policy" | "always";
    payload?: ToolNormalInvocationOperation["payload"];
    fixedParams?: ToolNormalInvocationOperation["fixedParams"];
  } = {},
): ToolNormalInvocationOperation {
  return {
    operationId: "lookup",
    summary: "Look up one current fact.",
    input: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1, maxLength: 4_096 },
      },
      required: ["query"],
    },
    ...(params.fixedParams ? { fixedParams: params.fixedParams } : {}),
    ...(params.payload ? { payload: params.payload } : {}),
    effect: params.effect ?? "read_only",
    approval: params.approval ?? "request_policy",
  };
}
