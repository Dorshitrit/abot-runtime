import { expect, test, vi } from "vitest";
import type { RegisteredToolNormalInvocation, ToolCall, ToolExecutionResult, ToolRequestAttachment } from "../../capabilities/tool-types.js";
import type { ToolExecutionOptions, ToolRegistry } from "../ports.js";
import { scopeToolRegistry } from "../automations/agent-tool-scope.js";
import { sourceAttachmentsForNode } from "../automations/source-attachment-access.js";
import { createAutomationToolLifetimes } from "../automations/tool-lifetimes.js";

test("only the admitted attachment-capable operation receives automation input handles", async () => {
  const reader = { toolName: "sample_tool", operationId: "read_source", contractVersion: 1 };
  const plain = { toolName: "sample_tool", operationId: "other", contractVersion: 1 };
  const registration: RegisteredToolNormalInvocation = {
    toolName: "sample_tool",
    definition: { name: "sample_tool", routingCapability: "semantic_lookup",
      executionEffect: "read_only", params: { source: "string" } },
    contract: { version: 1, operations: [
      { operationId: "read_source", summary: "Read source", effect: "read_only",
        approval: "request_policy", attachmentInput: {
          param: "source", acceptedMimeTypes: ["text/plain"],
        }, input: { type: "object", additionalProperties: false,
          properties: { source: { type: "string", minLength: 1, maxLength: 100 } }, required: ["source"] } },
      { operationId: "other", summary: "Other operation", effect: "read_only",
        approval: "request_policy", input: { type: "object", additionalProperties: false,
          properties: {}, required: [] } },
    ] },
  };
  const execute = vi.fn(async (_call: ToolCall, _options?: ToolExecutionOptions): Promise<ToolExecutionResult> =>
    ({ ok: true, tool: "sample_tool", output: "done", producedNewInformation: true }));
  const registry: ToolRegistry = {
    listDefinitions: () => [registration.definition],
    listNormalInvocations: () => [registration],
    getDefinition: () => registration.definition,
    hasToolsAvailable: () => true,
    getImplementations: () => ({}),
    execute,
  };
  const handle: ToolRequestAttachment = { id: "input-1", kind: "file", mimeType: "text/plain",
    absolutePath: "/runtime/snapshot.txt" };
  const admissions = new WeakMap<object, string>();
  const admittedOperations = new Map<string, typeof reader>();
  const controller = new AbortController();
  const lifetimes = createAutomationToolLifetimes();
  const scoped = scopeToolRegistry(registry, [reader, plain], admissions,
    admittedOperations, () => undefined,
    (invoke) => lifetimes.runInvocation("run", controller.signal, invoke));

  const plainToken = Object.freeze({});
  admissions.set(plainToken, "attempt-plain");
  admittedOperations.set("attempt-plain", plain);
  await scoped.execute({ tool: "sample_tool", params: {} }, {
    trustedEffectAdmission: plainToken,
    sharedState: { activeDirectory: "/work", requestAttachments: [handle] },
  });
  expect(execute.mock.calls[0]?.[1]?.sharedState)
    .toEqual({ activeDirectory: "/work" });

  const readerToken = Object.freeze({});
  admissions.set(readerToken, "attempt-reader");
  admittedOperations.set("attempt-reader", reader);
  await scoped.execute({ tool: "sample_tool", params: { source: "input-1" } }, {
    trustedEffectAdmission: readerToken,
    sharedState: { activeDirectory: "/work", requestAttachments: [handle] },
  });
  expect(execute.mock.calls[1]?.[1]?.sharedState?.requestAttachments)
    .toEqual([handle]);
  const lateToken = Object.freeze({});
  admissions.set(lateToken, "attempt-late");
  admittedOperations.set("attempt-late", reader);
  controller.abort(new Error("automation_run_stopped"));
  await expect(scoped.execute({ tool: "sample_tool", params: {} }, {
    trustedEffectAdmission: lateToken,
  })).rejects.toThrow("automation_run_stopped");
  expect(execute).toHaveBeenCalledTimes(2);
});

test.each([
  ["read_text", "text/plain"],
  ["read_pdf", "application/pdf"],
] as const)("mixed source handles are narrowed to the admitted %s operation", async (operationId, mimeType) => {
  const refs = ["read_text", "read_pdf"].map((id) => ({
    toolName: "reader", operationId: id, contractVersion: 1,
  }));
  const registration: RegisteredToolNormalInvocation = {
    toolName: "reader",
    definition: { name: "reader", routingCapability: "semantic_lookup",
      executionEffect: "read_only", params: { source: "string" } },
    contract: { version: 1, operations: refs.map((ref, index) => ({
      operationId: ref.operationId, summary: "Read a source", effect: "read_only",
      approval: "request_policy", attachmentInput: {
        param: "source", acceptedMimeTypes: [index === 0 ? "text/plain" : "application/pdf"],
      }, input: { type: "object", additionalProperties: false,
        properties: { source: { type: "string", minLength: 1, maxLength: 100 } }, required: ["source"] },
    })) },
  };
  const execute = vi.fn(async (_call: ToolCall, _options?: ToolExecutionOptions): Promise<ToolExecutionResult> =>
    ({ ok: true, tool: "reader", output: "done", producedNewInformation: true }));
  const registry: ToolRegistry = {
    listDefinitions: () => [registration.definition], listNormalInvocations: () => [registration],
    getDefinition: () => registration.definition, getImplementations: () => ({}),
    hasToolsAvailable: () => true, execute,
  };
  const files = ["one.txt", "two.pdf"].map((name, index) => ({
    inputId: `input-${index}`, sourceId: "source", originalPath: `/inbox/${name}`,
    snapshotPath: `/runtime/${name}`, version: "v1", sizeBytes: 3,
  }));
  const handles: ToolRequestAttachment[] = files.map((file, index) => ({
    id: file.inputId, kind: "file", mimeType: index === 0 ? "text/plain" : "application/pdf",
    absolutePath: file.snapshotPath,
  }));
  const selected = sourceAttachmentsForNode({
    node: { kind: "agent", id: "agent", title: "Read", onFailure: "stop", modelProfileId: "model",
      agentMode: "fast", roleInstructions: "Read", prompt: "Read", result: { kind: "text" },
      inputs: { files: { kind: "source_files" } },
      tools: refs.map((operation) => ({ operation, usage: "available" })),
    },
    operations: refs.map((ref, index) => ({ ...ref,
      attachmentInput: registration.contract.operations[index]!.attachmentInput })),
    sourceFiles: files, sourceAttachments: handles,
  });
  expect(selected).toHaveLength(4);
  const sharedState = { activeDirectory: "/work", requestAttachments: selected };
  const token = Object.freeze({});
  const admissions = new WeakMap<object, string>([[token, "invocation"]]);
  const admitted = new Map([["invocation", refs.find((ref) => ref.operationId === operationId)!]]);
  const scoped = scopeToolRegistry(registry, refs, admissions, admitted, () => undefined, (invoke) => invoke());
  await scoped.execute({ tool: "reader", params: { source: "input-0" } }, {
    trustedEffectAdmission: token, sharedState,
  });
  expect(execute.mock.calls[0]?.[1]?.sharedState).toEqual({ activeDirectory: "/work",
    requestAttachments: selected.filter((item) => item.mimeType === mimeType),
  });
  expect(sharedState.requestAttachments).toHaveLength(4);
  expect(await scoped.execute({ tool: "reader", params: {} }, {
    trustedEffectAdmission: token, sharedState,
  })).toMatchObject({ ok: false, errorCode: "automation_operation_unavailable" });
  expect(execute).toHaveBeenCalledTimes(1);
});
