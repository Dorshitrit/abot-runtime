import { vi } from "vitest";
import type {
  RegisteredToolNormalInvocation,
  ToolExecutionSharedState,
} from "../../../capabilities/tool-types.js";
import { createRegisteredToolWorkerCapabilityProvider } from "../../adapters/registered-tool-worker-capabilities.js";
import {
  createRoleCallLedger,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  type RoleCallLedger,
} from "../../orchestration/role-calls/index.js";
import {
  createRoleCapabilityBinding,
  type WorkerCapabilityPayloadAuthor,
} from "../../orchestration/worker-capabilities/index.js";
import type { ToolRegistry } from "../../ports.js";
import { EXECUTION_AGENT_V1_EXECUTION_POLICY } from "../../request/role-executor-composition.js";

export async function runtimePathRejectionFixture(options: {
  root: string;
  role: "root" | "worker";
  preparationError?: unknown;
  executeError?: unknown;
}) {
  const requestId = "request-path-rejection";
  const registration: RegisteredToolNormalInvocation = {
    toolName: "path_writer",
    definition: {
      name: "path_writer",
      routingCapability: "filesystem_mutation",
      executionEffect: "mutating",
      params: { path: "string", content: "string" },
      runtimePathBindings: [{
        operationId: "write_scoped_text", param: "path",
        base: "worker_working_directory",
      }],
    },
    contract: {
      version: 1,
      operations: [{
        operationId: "write_scoped_text",
        summary: "Write text within the allowed directory.",
        input: {
          type: "object", additionalProperties: false,
          properties: { path: { type: "string", minLength: 1, maxLength: 4096 } },
          required: ["path"],
        },
        effect: "mutating", approval: "always",
        payload: {
          kind: "raw_text", param: "content", maxBytes: 1024,
          instructions: "Write the complete requested text.",
        },
      }],
    },
  };
  const execute = vi.fn<ToolRegistry["execute"]>(async () => {
    if (options.executeError !== undefined) throw options.executeError;
    return {
      ok: true, tool: "path_writer", output: "Text written.",
      producedNewInformation: true, data: { mutationEvidence: true },
    };
  });
  const author = vi.fn<WorkerCapabilityPayloadAuthor["author"]>(async () => ({
    status: "authored", body: "Requested content.",
  }));
  const requestToolApproval = vi.fn(async () => ({ approved: true }));
  const nextApprovalId = vi.fn(() => "approval-path");
  const onEvent = vi.fn<(name: string, payload: Record<string, unknown>) => void>();
  const runtimePaths: NonNullable<ToolExecutionSharedState["runtimePaths"]> = {
    agentWorkDir: options.root,
  };
  if (options.preparationError !== undefined) {
    Object.defineProperty(runtimePaths, "agentWorkDir", {
      get() { throw options.preparationError; },
    });
  }
  const registry: ToolRegistry = {
    listDefinitions: () => [registration.definition],
    listNormalInvocations: () => [registration],
    getDefinition: () => registration.definition,
    hasToolsAvailable: () => true,
    getImplementations: () => ({}),
    prepareSharedState: (state = {}) => ({ ...state, runtimePaths }),
    execute,
  };
  const provider = createRegisteredToolWorkerCapabilityProvider({
    getRequestToolRegistry: () => registry,
    requestId, sessionId: "session-path-rejection",
    abortSignal: new AbortController().signal,
    toolPermissionMode: "full_access",
    toolApprovalController: { requestToolApproval },
    payloadAuthor: { author }, nextApprovalId, onEvent,
  });
  const ledger = createRoleCallLedger({
    requestId,
    policy: {
      ...(options.role === "root"
        ? { authority: EXECUTION_AGENT_V1_EXECUTION_POLICY.authority } : {}),
      limits: {
        maxDepth: 4, maxCalls: 8, maxCapabilityExecutions: 8,
        maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
        maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
        maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
      },
    },
  });
  async function commit(command: Parameters<RoleCallLedger["apply"]>[0]["command"]) {
    const result = await ledger.apply({ expectedHead: ledger.current(), command });
    if (!result.ok) throw new Error(result.code);
  }
  await commit({ authority: "runtime", type: "create_root" });
  if (options.role === "worker") {
    await commit({
      authority: "active_role", type: "open_child", callerCallId: "call-1",
      roleId: "worker", objective: "Write the requested text.",
      workingDirectory: "Project",
    });
  } else {
    await commit({
      authority: "active_role", type: "establish_working_directory",
      callId: "call-1", invocationAttempt: 1, workingDirectory: ".",
    });
  }
  const call = ledger.current().state.calls.find(
    (candidate) => candidate.callId === ledger.current().state.activeCallId,
  )!;
  const adapters = provider.getAdapters();
  const adapter = adapters[0]!;
  const input = (path: string) => ({
    context: {}, call, controls: { path },
    preparationId: "preparation-path",
    intent: "Write the requested text.",
    authoringObjective: "Write the complete requested text.",
    settledCapabilityResults: [],
  });
  return {
    adapter, input, ledger, execute, author, requestToolApproval,
    nextApprovalId, onEvent, call,
    run: (path: string) => createRoleCapabilityBinding({
      requestId, context: {}, call, ledger, adapters,
    }).execute({
      capabilityId: "write_scoped_text", controls: { path },
      intent: "Write the requested text.",
      authoringObjective: "Write the complete requested text.",
    }),
  };
}
