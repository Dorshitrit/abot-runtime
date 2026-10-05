import { describe, expect, it, vi } from "vitest";
import type { RegisteredToolNormalInvocation, ToolCall, ToolExecutionResult } from "../../capabilities/tool-types.js";
import type { ToolRegistry, ToolExecutionOptions } from "../ports.js";
import { executeAutomationToolStep } from "../automations/tool-step-executor.js";
import type { AutomationGrantRecord } from "../automations/storage-records.js";

const operation = { toolName: "sample_tool", operationId: "read", contractVersion: 1 } as const;
const node = {
  kind: "tool", id: "step1", title: "Read", onFailure: "stop", operation,
  controls: {},
} as const;

function fixture(effect: "read_only" | "mutating" = "read_only") {
  const registration: RegisteredToolNormalInvocation = {
    toolName: "sample_tool",
    definition: {
      name: "sample_tool", routingCapability: "semantic_lookup",
      executionEffect: effect, params: { key: "string" },
    },
    contract: {
      version: 1,
      operations: [{
        operationId: "read", summary: "Read a value", effect,
        approval: "request_policy",
        input: {
          type: "object", additionalProperties: false,
          properties: { key: { type: "string", minLength: 1, maxLength: 100 } },
          required: ["key"],
        },
      }],
    },
  };
  const execute = vi.fn(async (_call: ToolCall, _options?: ToolExecutionOptions): Promise<ToolExecutionResult> => ({
    ok: true, tool: "sample_tool", output: "value", producedNewInformation: true,
  }));
  const registry: ToolRegistry = {
    listDefinitions: () => [registration.definition],
    listNormalInvocations: () => [registration],
    getDefinition: (name) => name === registration.toolName ? registration.definition : undefined,
    hasToolsAvailable: () => true,
    getImplementations: () => ({}),
    execute,
  };
  const grant: AutomationGrantRecord = {
    id: "grant1", automationId: "automation1", environmentId: "dev",
    grantRevision: 1, mode: "full_access", operations: [operation],
    evidence: { kind: "authenticated_user_action", actionId: "action1", at: new Date(0).toISOString() },
  };
  return { registry, grant, execute };
}

describe("automation direct tool execution", () => {
  it("persists an attempt before a normal invocation and its exact receipt afterward", async () => {
    const { registry, grant, execute } = fixture();
    const order: string[] = [];
    execute.mockImplementation(async () => {
      order.push("execute");
      return { ok: true, tool: "sample_tool", output: "value", producedNewInformation: true };
    });
    const result = await executeAutomationToolStep({
      node, controls: { key: "name" }, registry, environmentId: "dev",
      automationId: "automation1", capturedGrant: grant,
      currentGrant: async () => grant,
      requestId: "request1", abortSignal: new AbortController().signal,
      beforeEffect: async ({ fingerprint }) => {
        expect(fingerprint).toMatch(/^sha256:/u);
        order.push("attempt");
      },
      afterEffect: async (_attempt, outcome, notDispatched) => {
        expect(outcome.kind).toBe("settled");
        expect(notDispatched).toBe(false);
        order.push("receipt");
      },
    });
    expect(result.kind).toBe("settled");
    expect(order).toEqual(["attempt", "execute", "receipt"]);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("blocks a revoked grant after preparation and before effect dispatch", async () => {
    const { registry, grant, execute } = fixture();
    let reads = 0;
    const afterEffect = vi.fn(async () => undefined);
    const result = await executeAutomationToolStep({
      node, controls: { key: "name" }, registry, environmentId: "dev",
      automationId: "automation1", capturedGrant: grant,
      currentGrant: async () => ++reads === 1 ? grant : null,
      requestId: "request1", abortSignal: new AbortController().signal,
      beforeEffect: async () => undefined, afterEffect,
    });
    expect(result).toMatchObject({ kind: "rejected", code: "automation_operation_unavailable" });
    expect(execute).not.toHaveBeenCalled();
    expect(afterEffect).toHaveBeenCalledOnce();
    expect(afterEffect).toHaveBeenCalledWith(expect.any(Object), result, true);
  });

  it("records a definite abort when stop wins during the final grant read", async () => {
    const { registry, grant, execute } = fixture();
    const abort = new AbortController();
    let reads = 0;
    const afterEffect = vi.fn(async () => undefined);
    const result = await executeAutomationToolStep({
      node, controls: { key: "name" }, registry, environmentId: "dev",
      automationId: "automation1", capturedGrant: grant,
      currentGrant: async () => {
        if (++reads === 2) abort.abort(new Error("automation_run_stopped"));
        return grant;
      },
      requestId: "request1", abortSignal: abort.signal,
      beforeEffect: async () => undefined, afterEffect,
    });
    expect(result).toMatchObject({ kind: "rejected", code: "request_aborted" });
    expect(execute).not.toHaveBeenCalled();
    expect(afterEffect).toHaveBeenCalledWith(expect.any(Object), result, true);
  });

  it.each(["read_only", "mutating"] as const)(
    "settles a definite %s abort during prepared execution before Tool dispatch",
    async (effect) => {
      const { registry, grant, execute } = fixture(effect);
      const abort = new AbortController();
      let reads = 0;
      const afterEffect = vi.fn(async () => undefined);
      const result = await executeAutomationToolStep({
        node, controls: { key: "name" }, registry, environmentId: "dev",
        automationId: "automation1", capturedGrant: grant,
        currentGrant: async () => {
          // Let the final grant guard pass, then stop in prepared execution's
          // approval await before its abort check or raw registry dispatch.
          if (++reads === 2) queueMicrotask(() => queueMicrotask(() =>
            abort.abort(new Error("automation_run_stopped"))));
          return grant;
        },
        requestId: "request1", abortSignal: abort.signal,
        beforeEffect: async () => undefined, afterEffect,
      });
      expect(result).toMatchObject({ kind: "rejected", code: "request_aborted" });
      expect(execute).not.toHaveBeenCalled();
      expect(afterEffect).toHaveBeenCalledWith(expect.any(Object), result, true);
    },
  );

  it.each(["read_only", "mutating"] as const)(
    "keeps the effect distinction when %s dispatch itself rejects on abort",
    async (effect) => {
      const { registry, grant, execute } = fixture(effect);
      const abort = new AbortController();
      const afterEffect = vi.fn(async () => undefined);
      execute.mockImplementationOnce(async () => {
        abort.abort(new Error("automation_run_stopped"));
        throw abort.signal.reason;
      });
      const result = await executeAutomationToolStep({
        node, controls: { key: "name" }, registry, environmentId: "dev",
        automationId: "automation1", capturedGrant: grant, currentGrant: async () => grant,
        requestId: "request1", abortSignal: abort.signal,
        beforeEffect: async () => undefined, afterEffect,
      });
      const expected = effect === "mutating"
        ? { kind: "uncertain", code: "automation_effect_uncertain" }
        : { kind: "rejected", code: "request_aborted" };
      expect(result).toMatchObject(expected);
      expect(execute).toHaveBeenCalledOnce();
      expect(afterEffect).toHaveBeenCalledWith(expect.any(Object), result, false);
    },
  );

  it("does not reinterpret a distinct Tool failure as the run's cancellation", async () => {
    const { registry, grant, execute } = fixture();
    const abort = new AbortController();
    execute.mockImplementationOnce(async () => {
      abort.abort(new Error("automation_run_stopped"));
      throw new Error("independent_tool_failure");
    });
    const result = await executeAutomationToolStep({
      node, controls: { key: "name" }, registry, environmentId: "dev",
      automationId: "automation1", capturedGrant: grant, currentGrant: async () => grant,
      requestId: "request1", abortSignal: abort.signal,
      beforeEffect: async () => undefined, afterEffect: async () => undefined,
    });
    expect(result).toMatchObject({ kind: "rejected", code: "automation_tool_failed",
      message: "Error: independent_tool_failure" });
  });

  it("passes only a trusted source handle to the selected normal invocation", async () => {
    const { registry, grant, execute } = fixture();
    const sourceAttachments = [{
      id: "/runtime/attachments/snapshot.txt", kind: "file" as const,
      mimeType: "text/plain", absolutePath: "/runtime/attachments/snapshot.txt",
      name: "snapshot.txt", size: 8,
    }];
    const result = await executeAutomationToolStep({
      node, controls: { key: "name" }, sourceAttachments,
      registry, environmentId: "dev", automationId: "automation1", capturedGrant: grant,
      currentGrant: async () => grant,
      requestId: "request1", abortSignal: new AbortController().signal,
      beforeEffect: async () => undefined, afterEffect: async () => undefined,
    });
    expect(result.kind).toBe("settled");
    expect(execute.mock.calls[0]?.[1]?.sharedState?.requestAttachments).toEqual(sourceAttachments);
  });

  it("keeps an aborted mutating call uncertain even when the tool layer returns a result", async () => {
    const { registry, grant, execute } = fixture();
    const registration = registry.listNormalInvocations!()[0]!;
    const mutating: RegisteredToolNormalInvocation = {
      ...registration,
      definition: { ...registration.definition, executionEffect: "mutating" },
      contract: { ...registration.contract, operations: [
        { ...registration.contract.operations[0]!, effect: "mutating" },
      ] },
    };
    const selectedRegistry: ToolRegistry = {
      ...registry, listDefinitions: () => [mutating.definition],
      getDefinition: () => mutating.definition,
      listNormalInvocations: () => [mutating],
    };
    execute.mockResolvedValueOnce({
      ok: false, tool: "sample_tool", output: "tool execution aborted",
      producedNewInformation: false, errorCode: "request_aborted",
    });
    const afterEffect = vi.fn(async () => undefined);
    const result = await executeAutomationToolStep({
      node, controls: { key: "name" }, registry: selectedRegistry,
      environmentId: "dev", automationId: "automation1", capturedGrant: grant,
      currentGrant: async () => grant,
      requestId: "request1", abortSignal: new AbortController().signal,
      beforeEffect: async () => undefined, afterEffect,
    });
    expect(result).toMatchObject({ kind: "uncertain", code: "automation_effect_uncertain" });
    expect(afterEffect).toHaveBeenCalledWith(expect.any(Object), result, false);
  });
});
