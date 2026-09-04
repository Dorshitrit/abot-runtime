import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type {
  RegisteredToolNormalInvocation,
  ToolExecutionResult,
  ToolNormalInvocationOperation,
} from "../../capabilities/tool-types.js";
import { MODEL_STEPS } from "../../shared/model-steps.js";
import { createRegisteredToolWorkerCapabilityProvider } from "../adapters/registered-tool-worker-capabilities.js";
import { projectRequestToolResults } from "../context/request-tool-results.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { CAPABILITY_ADAPTER_RESULT_SERIALIZED_MAX_BYTES } from "../orchestration/capability-adapters/index.js";
import {
  createRoleCallLedger,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  type RoleCallFrame,
  type RoleCallLedger,
  type RoleCallLedgerHead,
} from "../orchestration/role-calls/index.js";
import {
  createWorkerCapabilityBinding,
  createWorkerCapabilityPayloadAuthor,
  projectWorkerSettledCapabilityResults,
  type WorkerCapabilityPayloadModelRequest,
} from "../orchestration/worker-capabilities/index.js";
import { projectWorkerCapabilityPayloadSourceProvenance } from "../orchestration/worker-capabilities/payload-source-provenance.js";
import type { ToolRegistry } from "../ports.js";

const REQUEST_ID = "request-delegated-tool-evidence";
const STRUCTURED_RECORD_ID = "record-only-in-structured-data-7";
const AGGREGATE_OUTPUT = "One current record is available.";

beforeEach(() => {
  configureDebugLogger({ enabled: false });
});

afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

describe("delegated registered-tool evidence flow", () => {
  test("preserves exact structured evidence for its Worker without replaying execution or leaking it to the caller", async () => {
    expect(AGGREGATE_OUTPUT).not.toContain(STRUCTURED_RECORD_ID);
    const executeTool = vi.fn(
      async (): Promise<ToolExecutionResult> => ({
        ok: true,
        tool: "record_reader",
        output: AGGREGATE_OUTPUT,
        producedNewInformation: true,
        data: {
          records: [{ id: STRUCTURED_RECORD_ID, visibility: "public" }],
        },
      }),
    );
    const provider = createRegisteredToolWorkerCapabilityProvider({
      getRequestToolRegistry: () =>
        createRegistry({
          registrations: [recordReaderRegistration()],
          execute: executeTool,
        }),
      requestId: REQUEST_ID,
      sessionId: "session-delegated-tool-evidence",
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      nextApprovalId: () => "approval-unused",
    });
    const ledger = createLedger();

    const rooted = await commit(ledger, {
      authority: "runtime",
      type: "create_root",
    });
    const rootCall = requireCall(
      rooted,
      requireCallId(rooted.state.rootCallId, "root"),
    );
    expect(rootCall).toMatchObject({
      roleId: "supervisor",
      parentCallId: null,
      status: "active",
    });

    const opened = await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: rootCall.callId,
      roleId: "worker",
      objective:
        "Read the current record index and report the exact record ID.",
    });
    const workerCall = requireCall(
      opened,
      requireCallId(opened.state.activeCallId, "active"),
    );
    expect(workerCall).toMatchObject({
      roleId: "worker",
      parentCallId: rootCall.callId,
      activationCount: 1,
    });

    const binding = createWorkerCapabilityBinding({
      requestId: REQUEST_ID,
      context: Object.freeze({ marker: "delegated-evidence" }),
      call: workerCall,
      ledger,
      adapters: provider.getAdapters(),
    });
    await expect(
      binding.execute({
        capabilityId: "inspect_record_index",
        intent: "Inspect the current record index once.",
        controls: {},
      }),
    ).resolves.toEqual({ executionId: "capability-execution-1" });
    expect(executeTool).toHaveBeenCalledOnce();

    await expect(
      binding.execute({
        capabilityId: "inspect_record_index",
        intent: "Inspect the current record index again.",
        controls: {},
      }),
    ).rejects.toThrow("worker_capability_rejected:invocation_attempt_mismatch");
    expect(executeTool).toHaveBeenCalledOnce();

    const resumedHead = ledger.current();
    const resumedWorker = requireCall(resumedHead, workerCall.callId);
    const execution = resumedHead.state.capabilityExecutions[0];
    expect(resumedHead.state.capabilityExecutions).toHaveLength(1);
    expect(execution).toMatchObject({
      executionId: "capability-execution-1",
      callId: workerCall.callId,
      status: "settled",
      outcome: "succeeded",
      summary: AGGREGATE_OUTPUT,
      exactResult: expectedExactResult(),
    });

    const settledEvidence = projectWorkerSettledCapabilityResults({
      ledger,
      head: resumedHead,
      call: resumedWorker,
    });
    expect(settledEvidence).toEqual([
      expect.objectContaining({
        executionId: "capability-execution-1",
        adapterResult: expectedExactResult(),
      }),
    ]);

    const workerRequestEvidence = projectRequestToolResults({
      ledger,
      head: resumedHead,
      modelStep: MODEL_STEPS.WORKER_DECISION,
      callId: resumedWorker.callId,
    });
    expect(workerRequestEvidence.results).toEqual([
      expect.objectContaining({
        executionId: "capability-execution-1",
        adapterResult: expectedExactResult(),
      }),
    ]);

    const invokePayloadModel = vi.fn(
      async (_request: WorkerCapabilityPayloadModelRequest) => "Grounded body.",
    );
    const payloadAuthor = createWorkerCapabilityPayloadAuthor({
      requestId: REQUEST_ID,
      abortSignal: new AbortController().signal,
      model: { invoke: invokePayloadModel },
    });
    const payloadDescriptor = Object.freeze({
      ...provider.getDescriptors()[0]!,
      requiresPayloadAuthoringObjective: true as const,
    });
    await expect(
      payloadAuthor.author({
        call: resumedWorker,
        assignmentProvenance: projectWorkerCapabilityPayloadSourceProvenance({
          ledger,
          head: resumedHead,
          call: resumedWorker,
        }),
        executionId: "capability-execution-2",
        descriptor: payloadDescriptor,
        authoringObjective:
          "Author the grounded body from the settled record evidence.",
        controls: {},
        contextScope: "standard",
        settledCapabilityResults: settledEvidence,
        contract: {
          instructions: "Return one grounded body.",
          minBytes: 1,
          maxBytes: 256,
        },
      }),
    ).resolves.toEqual({ status: "authored", body: "Grounded body." });
    expect(invokePayloadModel).toHaveBeenCalledOnce();
    expect(
      invokePayloadModel.mock.calls[0]![0].context.settledCapabilityResults,
    ).toEqual([
      expect.objectContaining({ adapterResult: expectedExactResult() }),
    ]);
    expect(executeTool).toHaveBeenCalledOnce();

    const returned = await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: rootCall.callId,
      childCallId: resumedWorker.callId,
      outcome: "completed",
      summary: "The Worker returned the current record observation.",
    });
    const callerEvidence = projectRequestToolResults({
      ledger,
      head: returned,
      modelStep: MODEL_STEPS.SUPERVISOR_DECISION,
      callId: rootCall.callId,
    });
    expect(callerEvidence.results).toEqual([
      expect.objectContaining({
        executionId: "capability-execution-1",
        summary: AGGREGATE_OUTPUT,
      }),
    ]);
    expect(callerEvidence.results[0]).not.toHaveProperty("adapterResult");
    expect(JSON.stringify(callerEvidence)).not.toContain(STRUCTURED_RECORD_ID);
    expect(returned.state.capabilityExecutions).toHaveLength(1);
    expect(executeTool).toHaveBeenCalledOnce();
  });

  test("settles oversized plugin evidence as an explicit technical failure", async () => {
    const oversizedBody = "x".repeat(
      CAPABILITY_ADAPTER_RESULT_SERIALIZED_MAX_BYTES,
    );
    const executeTool = vi.fn(
      async (): Promise<ToolExecutionResult> => ({
        ok: true,
        tool: "record_reader",
        output: AGGREGATE_OUTPUT,
        producedNewInformation: true,
        data: { oversizedBody },
      }),
    );
    const provider = createRegisteredToolWorkerCapabilityProvider({
      getRequestToolRegistry: () =>
        createRegistry({
          registrations: [recordReaderRegistration()],
          execute: executeTool,
        }),
      requestId: `${REQUEST_ID}-oversized`,
      sessionId: "session-delegated-tool-evidence-oversized",
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      nextApprovalId: () => "approval-unused",
    });
    const ledger = createLedger(`${REQUEST_ID}-oversized`);
    const rooted = await commit(ledger, {
      authority: "runtime",
      type: "create_root",
    });
    const rootCall = requireCall(
      rooted,
      requireCallId(rooted.state.rootCallId, "root"),
    );
    const opened = await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: rootCall.callId,
      roleId: "worker",
      objective: "Read the current record index.",
    });
    const workerCall = requireCall(
      opened,
      requireCallId(opened.state.activeCallId, "active"),
    );
    const binding = createWorkerCapabilityBinding({
      requestId: `${REQUEST_ID}-oversized`,
      context: Object.freeze({ marker: "oversized-evidence" }),
      call: workerCall,
      ledger,
      adapters: provider.getAdapters(),
    });

    await expect(
      binding.execute({
        capabilityId: "inspect_record_index",
        intent: "Inspect the current record index once.",
        controls: {},
      }),
    ).resolves.toEqual({ executionId: "capability-execution-1" });
    expect(executeTool).toHaveBeenCalledOnce();

    const execution = ledger.current().state.capabilityExecutions[0];
    expect(execution).toMatchObject({
      status: "settled",
      outcome: "failed",
      observedEffect: "indeterminate",
      summary:
        "The capability result exceeded the Runtime evidence size limit.",
      exactResult: {
        kind: "generic_capability_result_v1",
        authority: "capability_adapter",
        status: "executed",
        ok: false,
        payload: {
          outcome: "failed",
          observedEffect: "indeterminate",
          summary:
            "The capability result exceeded the Runtime evidence size limit.",
        },
      },
    });
    expect(JSON.stringify(execution?.exactResult)).not.toContain(
      oversizedBody.slice(0, 1_024),
    );
  });
});

function createLedger(requestId = REQUEST_ID): RoleCallLedger {
  return createRoleCallLedger({
    requestId,
    policy: {
      limits: {
        maxDepth: 4,
        maxCalls: 8,
        maxCapabilityExecutions: 8,
        maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
        maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
        maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
      },
    },
  });
}

async function commit(
  ledger: RoleCallLedger,
  command: Parameters<RoleCallLedger["apply"]>[0]["command"],
): Promise<RoleCallLedgerHead> {
  const result = await ledger.apply({
    expectedHead: ledger.current(),
    command,
  });
  if (!result.ok) throw new Error(result.code);
  return result.head;
}

function requireCall(head: RoleCallLedgerHead, callId: string): RoleCallFrame {
  const call = head.state.calls.find(
    (candidate) => candidate.callId === callId,
  );
  if (!call) throw new Error(`missing role call: ${callId}`);
  return call;
}

function requireCallId(callId: string | null, label: string): string {
  if (!callId) throw new Error(`missing ${label} call id`);
  return callId;
}

function expectedExactResult() {
  return {
    kind: "registered_tool_execution_result_v1",
    authority: "registered_plugin",
    status: "executed",
    result: {
      ok: true,
      tool: "record_reader",
      output: AGGREGATE_OUTPUT,
      producedNewInformation: true,
      data: {
        records: [{ id: STRUCTURED_RECORD_ID, visibility: "public" }],
      },
    },
  } as const;
}

function createRegistry(
  params: Readonly<{
    registrations: readonly RegisteredToolNormalInvocation[];
    execute: ToolRegistry["execute"];
  }>,
): ToolRegistry {
  const definitions = params.registrations.map(
    (registration) => registration.definition,
  );
  return {
    listDefinitions: () => definitions,
    listNormalInvocations: () => params.registrations,
    getDefinition: (name) =>
      definitions.find((definition) => definition.name === name),
    hasToolsAvailable: () => definitions.length > 0,
    getImplementations: () => ({}),
    execute: params.execute,
  };
}

function recordReaderRegistration(): RegisteredToolNormalInvocation {
  const operation: ToolNormalInvocationOperation = {
    operationId: "inspect_record_index",
    summary: "Inspect the current record index.",
    input: {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: [],
    },
    effect: "read_only",
    approval: "request_policy",
  };
  return {
    toolName: "record_reader",
    definition: {
      name: "record_reader",
      routingCapability: "filesystem_inspection",
      executionEffect: "read_only",
      catalogGroups: ["read"],
      params: {},
    },
    contract: { version: 1, operations: [operation] },
  };
}
