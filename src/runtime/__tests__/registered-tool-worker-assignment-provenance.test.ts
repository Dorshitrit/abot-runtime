import { describe, expect, test, vi } from "vitest";

import { createRegisteredToolWorkerCapabilityProvider } from "../adapters/registered-tool-worker-capabilities.js";
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
  isWorkerCapabilityPayloadSourceProvenanceValid,
  projectWorkerPayloadRequestSourceProjection,
  type WorkerCapabilityAssignmentProvenance,
  type WorkerCapabilityPayloadSourceProvenance,
  type WorkerCapabilityPayloadAuthor,
  type WorkerCapabilityPayloadModelPort,
} from "../orchestration/worker-capabilities/index.js";
import { projectWorkerCapabilityPayloadSourceProvenance } from "../orchestration/worker-capabilities/payload-source-provenance.js";
import type { ToolRegistry } from "../ports.js";
import type {
  RegisteredToolNormalInvocation,
  ToolExecutionResult,
  ToolNormalInvocationOperation,
} from "../../capabilities/tool-types.js";

type TestContext = Readonly<{ marker: string }>;

const WORKER_CALL: RoleCallFrame = Object.freeze({
  callId: "worker-call",
  parentCallId: "planner-call",
  roleId: "worker",
  depth: 2,
  objective: "Execute one bound plan item.",
  dependencyResultRefs: Object.freeze([]),
  status: "waiting_for_capability",
  childCallIds: Object.freeze([]),
  activationCount: 1,
  resultRef: null,
});

const ASSIGNMENT_PROVENANCE = Object.freeze({
  kind: "planner_plan_item_v1",
  requestId: "transport-request",
  sourceRevision: 4,
  plannerCallId: "planner-call",
  planId: "planner-plan",
  itemId: "planner-item",
  workerCallId: WORKER_CALL.callId,
  invocationAttempt: 1,
}) as unknown as WorkerCapabilityAssignmentProvenance;

describe("registered tool Worker assignment provenance transport", () => {
  test("forwards the exact receipt through an ordinary payload lifecycle", async () => {
    const author = vi.fn<WorkerCapabilityPayloadAuthor["author"]>(async () => ({
      status: "authored" as const,
      body: "complete body\n",
    }));
    const execute = vi.fn(async () => executed());
    const adapter = createProvider(
      ordinaryPayloadRegistration(),
      author,
      execute,
    ).getAdapters()[0]!;

    await adapter.execute({
      context: { marker: "ordinary" },
      call: WORKER_CALL,
      assignmentProvenance: ASSIGNMENT_PROVENANCE,
      executionId: "ordinary-execution",
      intent: "Write the supplied body.",
      authoringObjective: "Author the complete body.",
      controls: { path: "index.html" },
      settledCapabilityResults: Object.freeze([]),
    });

    expect(author).toHaveBeenCalledOnce();
    expect(author.mock.calls[0]![0].assignmentProvenance).toBe(
      ASSIGNMENT_PROVENANCE,
    );
  });

  test("forwards the exact receipt through every staged payload call", async () => {
    const author = vi.fn<WorkerCapabilityPayloadAuthor["author"]>(
      async (input) => ({
        status: "authored" as const,
        body:
          input.stage?.index === 1
            ? JSON.stringify({ placement: "before" })
            : "inserted body\n",
      }),
    );
    const execute = vi.fn(async () => executed());
    const adapter = createProvider(
      stagedPayloadRegistration(),
      author,
      execute,
    ).getAdapters()[0]!;

    await adapter.execute({
      context: { marker: "staged" },
      call: WORKER_CALL,
      assignmentProvenance: ASSIGNMENT_PROVENANCE,
      executionId: "staged-execution",
      intent: "Apply one staged edit.",
      authoringObjective: "Author the complete staged edit payload.",
      controls: { instruction: "Insert the content." },
      settledCapabilityResults: Object.freeze([]),
    });

    expect(author).toHaveBeenCalledTimes(2);
    expect(
      author.mock.calls.every(
        ([input]) => input.assignmentProvenance === ASSIGNMENT_PROVENANCE,
      ),
    ).toBe(true);
  });

  test("issues request scope through the canonical binding for every payload in a batch", async () => {
    const { ledger, call } = await openDirectWorkerLedger();
    const invokeModel = vi.fn<WorkerCapabilityPayloadModelPort["invoke"]>(
      async () => "bounded query\n",
    );
    const runtimeAuthor = createWorkerCapabilityPayloadAuthor({
      requestId: "transport-request",
      abortSignal: new AbortController().signal,
      model: { invoke: invokeModel },
    });
    const author = vi.fn<WorkerCapabilityPayloadAuthor["author"]>((input) =>
      runtimeAuthor.author(input),
    );
    const execute = vi.fn(async () => observed());
    const provider = createProvider(
      observationPayloadRegistration(),
      author,
      execute,
    );
    const binding = createWorkerCapabilityBinding({
      requestId: "transport-request",
      context: { marker: "request-scoped" },
      call,
      ledger,
      adapters: provider.getAdapters(),
    });

    await expect(
      binding.executeBatch({
        invocations: [
          {
            capabilityId: "prepare_payload_query",
            intent: "Prepare the first bounded query.",
            authoringObjective: "Author the complete first query.",
            controls: { source: "first" },
          },
          {
            capabilityId: "prepare_payload_query",
            intent: "Prepare the second bounded query.",
            authoringObjective: "Author the complete second query.",
            controls: { source: "second" },
          },
        ],
      }),
    ).resolves.toEqual({
      executionIds: ["capability-execution-1", "capability-execution-2"],
    });
    expect(author).toHaveBeenCalledTimes(2);
    expect(invokeModel).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(
      invokeModel.mock.calls.map(
        ([request]) => request.requestSourceProjection,
      ),
    ).toEqual(["full_request", "full_request"]);
    for (const [input] of author.mock.calls) {
      const provenance = input.assignmentProvenance;
      expect(provenance?.kind).toBe("request_scoped_worker_v1");
      expect(
        isWorkerCapabilityPayloadSourceProvenanceValid(
          provenance,
          input.call,
          "transport-request",
        ),
      ).toBe(true);
      expect(
        projectWorkerPayloadRequestSourceProjection(
          provenance,
          input.call,
          "transport-request",
        ),
      ).toBe("full_request");
      expect(
        isWorkerCapabilityPayloadSourceProvenanceValid(
          Object.freeze({
            ...provenance,
          }) as WorkerCapabilityPayloadSourceProvenance,
          input.call,
          "transport-request",
        ),
      ).toBe(false);
    }
  });

  test("refuses to issue request scope for a completed Worker", async () => {
    const { ledger, call } = await openDirectWorkerLedger();
    const completed = await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-1",
      childCallId: call.callId,
      outcome: "completed",
      summary: "Worker finished.",
    });
    const completedCall = completed.state.calls.find(
      ({ callId }) => callId === call.callId,
    );
    if (!completedCall) throw new Error("completed Worker call missing");

    expect(() =>
      projectWorkerCapabilityPayloadSourceProvenance({
        ledger,
        head: completed,
        call: completedCall,
      }),
    ).toThrow("worker_payload_source_provenance_authority_invalid");
  });
});

function createProvider(
  registration: RegisteredToolNormalInvocation,
  author: WorkerCapabilityPayloadAuthor["author"],
  execute: ToolRegistry["execute"],
) {
  return createRegisteredToolWorkerCapabilityProvider<TestContext>({
    getRequestToolRegistry: () => createRegistry(registration, execute),
    requestId: "transport-request",
    sessionId: "transport-session",
    abortSignal: new AbortController().signal,
    toolPermissionMode: "full_access",
    payloadAuthor: { author },
    nextApprovalId: () => "approval-unused",
  });
}

function createRegistry(
  registration: RegisteredToolNormalInvocation,
  execute: ToolRegistry["execute"],
): ToolRegistry {
  return {
    listDefinitions: () => [registration.definition],
    listNormalInvocations: () => [registration],
    getDefinition: (name) =>
      name === registration.definition.name
        ? registration.definition
        : undefined,
    hasToolsAvailable: () => true,
    getImplementations: () => ({}),
    execute,
  };
}

function ordinaryPayloadRegistration(): RegisteredToolNormalInvocation {
  const operation = payloadOperation("write_complete_file", {
    path: { type: "string", minLength: 1, maxLength: 4_096 },
  });
  return {
    toolName: "complete_file_writer",
    definition: {
      name: "complete_file_writer",
      routingCapability: "filesystem_mutation",
      executionEffect: "mutating",
      params: { path: "string", content: "string" },
      payloadChannelSpec: {
        params: ["content"],
        outputParam: "content",
        generationMode: "raw_text",
        targetParam: "path",
        targetRole: "payload_body",
      },
    },
    contract: { version: 1, operations: [operation] },
  };
}

function stagedPayloadRegistration(): RegisteredToolNormalInvocation {
  const operation = payloadOperation("edit_conditional_content", {
    instruction: { type: "string", minLength: 1, maxLength: 4_096 },
    selection: { type: "string", minLength: 1, maxLength: 4_096 },
  });
  return {
    toolName: "conditional_editor",
    definition: {
      name: "conditional_editor",
      routingCapability: "filesystem_mutation",
      executionEffect: "mutating",
      params: {
        instruction: "string",
        selection: "string",
        content: "string",
      },
      payloadChannelSpec: {
        params: ["selection", "content"],
        outputParam: "content",
        generationMode: "raw_text",
        stages: [
          {
            outputParam: "selection",
            promptHint: "Return one placement object.",
            responseFormat: {
              type: "object",
              properties: {
                placement: {
                  type: "string",
                  enum: ["before", "after", "replace"],
                },
              },
              required: ["placement"],
              additionalProperties: false,
            },
          },
          {
            outputParam: "content",
            includeMaterializedParams: ["selection"],
            minBytes: 1,
          },
        ],
      },
    },
    contract: { version: 1, operations: [operation] },
  };
}

function observationPayloadRegistration(): RegisteredToolNormalInvocation {
  const capabilityId = "prepare_payload_query";
  const operation: ToolNormalInvocationOperation = {
    operationId: capabilityId,
    summary: "Prepare and execute one bounded query.",
    input: {
      type: "object",
      additionalProperties: false,
      properties: {
        source: { type: "string", minLength: 1, maxLength: 64 },
      },
      required: ["source"],
    },
    payload: {
      kind: "raw_text",
      param: "query",
      instructions: "Return the complete bounded query.",
      maxBytes: 1_024,
    },
    effect: "read_only",
    approval: "request_policy",
  };
  return {
    toolName: "query_tool",
    definition: {
      name: "query_tool",
      routingCapability: "semantic_lookup",
      executionEffect: "read_only",
      params: { source: "string", query: "string" },
      payloadChannelSpec: {
        params: ["query"],
        outputParam: "query",
        generationMode: "raw_text",
      },
    },
    contract: { version: 1, operations: [operation] },
  };
}

function payloadOperation(
  operationId: string,
  properties: ToolNormalInvocationOperation["input"]["properties"],
): ToolNormalInvocationOperation {
  return {
    operationId,
    summary: "Execute one payload-backed operation.",
    input: {
      type: "object",
      additionalProperties: false,
      properties,
      required: Object.keys(properties),
    },
    payload: {
      kind: "raw_text",
      param: "content",
      instructions: "Return the complete payload.",
      maxBytes: 1_024,
    },
    effect: "mutating",
    approval: "request_policy",
  };
}

function executed(): ToolExecutionResult {
  return {
    ok: true,
    tool: "transport-test",
    output: "Executed.",
    producedNewInformation: true,
    data: { mutationEvidence: true },
  };
}

function observed(): ToolExecutionResult {
  return {
    ok: true,
    tool: "transport-observation-test",
    output: "Observed.",
    producedNewInformation: true,
    data: { currentStateEvidence: true },
  };
}

async function openDirectWorkerLedger(): Promise<
  Readonly<{ ledger: RoleCallLedger; call: RoleCallFrame }>
> {
  const ledger = createRoleCallLedger({
    requestId: "transport-request",
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
  await commit(ledger, { authority: "runtime", type: "create_root" });
  const opened = await commit(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId: "worker",
    objective: "Prepare two independent bounded queries.",
  });
  const call = opened.state.calls.find(
    ({ callId }) => callId === opened.state.activeCallId,
  );
  if (!call) throw new Error("transport Worker call missing");
  return Object.freeze({ ledger, call });
}

async function commit(
  ledger: RoleCallLedger,
  command: unknown,
): Promise<RoleCallLedgerHead> {
  const result = await ledger.apply({
    expectedHead: ledger.current(),
    command,
  });
  if (!result.ok) throw new Error(`transport ledger rejected:${result.code}`);
  return result.head;
}
