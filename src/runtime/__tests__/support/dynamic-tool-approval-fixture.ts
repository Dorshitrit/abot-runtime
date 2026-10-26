import { vi } from "vitest";
import type {
  ToolCallAdapter,
  ToolImplementation,
  ToolModuleDeclaration,
} from "../../../capabilities/tool-types.js";
import type { ToolApprovalController, ToolPermissionMode } from "../../ports.js";
import { createConfiguredToolRegistry } from "../../capabilities/configured-tool-registry.js";
import { createRegisteredToolNormalInvocationExecutor } from "../../adapters/registered-tool-normal-invocations.js";

export type ExecutionBinding = NonNullable<ToolCallAdapter["executionBinding"]>;

export function dynamicApprovalFixture(options: {
  mode?: ToolPermissionMode;
  demand?: boolean;
  binding?: ExecutionBinding;
  withoutBinding?: boolean;
  withoutController?: boolean;
  approved?: boolean;
  staticApproval?: "request_policy" | "always";
} = {}) {
  const state = { identity: "target:revision-1", demand: options.demand };
  const abort = new AbortController();
  const implementation = vi.fn<ToolImplementation>(async () => ({
    ok: true, output: "Observation", producedNewInformation: true,
  }));
  const binding = vi.fn<ExecutionBinding>(options.binding ?? (async () => ({
    identity: state.identity,
    metadata: { destinationLabel: "Private target disclosure" },
    ...(state.demand !== undefined ? { requiresApproval: state.demand } : {}),
  })));
  const requestApproval = vi.fn<ToolApprovalController["requestToolApproval"]>(
    async () => ({ approved: options.approved !== false }),
  );
  const onEvent = vi.fn();
  let sequence = 0;
  const nextApprovalId = vi.fn(() => "approval-" + ++sequence);
  const module: ToolModuleDeclaration = {
    definition: { name: "guarded_lookup", routingCapability: "semantic_lookup" },
    normalInvocation: {
      version: 1,
      operations: [{
        operationId: "guarded_lookup",
        summary: "Read one selected target.",
        effect: "read_only",
        approval: options.staticApproval ?? "request_policy",
        input: {
          type: "object", additionalProperties: false,
          properties: {
            query: { type: "string", minLength: 1, maxLength: 100 },
            toolPermissionMode: { type: "string", minLength: 1, maxLength: 100 },
            executionIdentity: { type: "string", minLength: 1, maxLength: 100 },
          },
          required: ["query"],
        },
      }],
    },
    ...(options.withoutBinding ? {} : { adapter: { executionBinding: binding } }),
    implementation,
  };
  const registry = createConfiguredToolRegistry(undefined, [module]);
  const createExecutor = () => createRegisteredToolNormalInvocationExecutor({
    registrations: registry.listNormalInvocations!(),
    toolRegistry: registry,
    requestId: "dynamic-approval-request",
    abortSignal: abort.signal,
    toolPermissionMode: options.mode ?? "full_access",
    sharedState: {
      currentSessionId: "bound-session",
      requestContext: { agentMode: "fast", toolPermissionMode: "full_plus" },
    },
    nextApprovalId,
    onEvent,
    ...(options.withoutController ? {} : {
      toolApprovalController: { requestToolApproval: requestApproval },
    }),
  });
  const executor = createExecutor();
  const input = {
    handle: executor.operations[0]!.handle,
    controls: { query: "selected-target" },
  };
  const prepare = async (controls: Record<string, unknown> = input.controls) => {
    const result = await executor.prepare({ ...input, controls });
    if (result.status !== "prepared") throw new Error(result.code);
    return result;
  };
  return { state, abort, implementation, binding, requestApproval, onEvent,
    nextApprovalId, executor, input, createExecutor, prepare };
}

export function deferredBinding() {
  let resolve!: (value: Awaited<ReturnType<ExecutionBinding>>) => void;
  const promise = new Promise<Awaited<ReturnType<ExecutionBinding>>>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
