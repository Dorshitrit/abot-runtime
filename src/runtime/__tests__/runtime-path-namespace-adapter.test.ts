import { describe, expect, test, vi } from "vitest";

import type {
  RegisteredToolNormalInvocation,
  ToolExecutionResult,
} from "../../capabilities/tool-types.js";
import { createRegisteredToolWorkerCapabilityProvider } from "../adapters/registered-tool-worker-capabilities.js";
import type { RoleCallFrame } from "../orchestration/role-calls/index.js";
import type { WorkerCapabilityPayloadAuthor } from "../orchestration/worker-capabilities/index.js";
import type { ToolRegistry } from "../ports.js";

const registration: RegisteredToolNormalInvocation = {
  toolName: "namespace_writer",
  definition: {
    name: "namespace_writer",
    routingCapability: "filesystem_mutation",
    executionEffect: "mutating",
    params: { path: "string", content: "string" },
    payloadChannelSpec: {
      params: ["content"],
      outputParam: "content",
      generationMode: "raw_text",
      targetParam: "path",
      targetRole: "operation_target",
    },
  },
  contract: {
    version: 1,
    operations: [
      {
        operationId: "write_namespace_target",
        summary: "Write the exact requested target.",
        input: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", minLength: 1, maxLength: 4_096 },
          },
          required: ["path"],
        },
        payload: {
          kind: "raw_text",
          param: "content",
          instructions: "Return complete content.",
          maxBytes: 1_024,
        },
        effect: "mutating",
        approval: "request_policy",
      },
    ],
  },
};

function callFrame(
  role: "root" | "worker",
  workingDirectory?: string,
): RoleCallFrame {
  const root = role === "root";
  return {
    callId: root ? "call-1" : "call-2",
    parentCallId: root ? null : "call-1",
    roleId: root ? "supervisor" : "worker",
    depth: root ? 0 : 1,
    objective: root ? null : "Create the requested page.",
    dependencyResultRefs: [],
    status: "active",
    childCallIds: [],
    activationCount: 1,
    resultRef: null,
    ...(workingDirectory ? { workingDirectory } : {}),
  };
}

describe.skipIf(process.platform === "win32")(
  "registered path namespace admission",
  () => {
    test.each([
      ["root", undefined],
      ["root", "."],
      ["worker", undefined],
      ["worker", "Project"],
    ] as const)(
      "rejects a foreign target before %s payload or effect with directory %s",
      async (role, workingDirectory) => {
        const author = vi.fn<WorkerCapabilityPayloadAuthor["author"]>(
          async () => ({ status: "authored", body: "must not be authored" }),
        );
        const execute = vi.fn<ToolRegistry["execute"]>(
          async (): Promise<ToolExecutionResult> => ({
            ok: true,
            tool: "namespace_writer",
            output: "must not execute",
          producedNewInformation: true,
          }),
        );
        const onEvent = vi.fn();
        const registry: ToolRegistry = {
          listDefinitions: () => [registration.definition],
          listNormalInvocations: () => [registration],
          getDefinition: () => registration.definition,
          hasToolsAvailable: () => true,
          getImplementations: () => ({}),
          prepareSharedState: (state = {}) => ({
            ...state,
            runtimePaths: { agentWorkDir: process.cwd() },
          }),
          execute,
        };
        const provider = createRegisteredToolWorkerCapabilityProvider({
          getRequestToolRegistry: () => registry,
          requestId: "request-namespace-admission",
          sessionId: "session-namespace-admission",
          abortSignal: new AbortController().signal,
          toolPermissionMode: "full_access",
          payloadAuthor: { author },
          nextApprovalId: () => "approval-unused",
          onEvent,
        });

        await expect(
          provider.getAdapters()[0]!.execute({
            context: {},
            call: callFrame(role, workingDirectory),
            executionId: "capability-execution-1",
            intent: "Create the requested page.",
            authoringObjective: "Write the complete requested page.",
            controls: { path: "C:/namespace-project/index.html" },
            settledCapabilityResults: [],
          }),
        ).rejects.toThrow(
          "registered_tool_worker_capability_execution:runtime_tool_path_namespace_invalid",
        );
        expect(author).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
        expect(onEvent).not.toHaveBeenCalled();
      },
    );
  },
);
