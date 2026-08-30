import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import {
  createRoleCallLedger,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  type RoleCallFrame,
  type RoleCallLedger,
  type RoleCallLedgerCommitResult,
  type RoleCallLedgerHead,
} from "../orchestration/role-calls/index.js";
import {
  createRoleCapabilityBinding,
  createWorkerCapabilityBinding,
  EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
  projectWorkerCapabilityScope,
  WORKER_CAPABILITY_COUNT_MAX,
  WORKER_CAPABILITY_INTENT_MAX_LENGTH,
  WORKER_CAPABILITY_SUMMARY_MAX_LENGTH,
  type WorkerCapabilityAdapter,
} from "../orchestration/worker-capabilities/index.js";

type TestContext = Readonly<{ marker: string }>;

const AUTHORING_OBJECTIVE =
  "Create the complete text document for the accepted target path.";

async function openWorkerLedger(
  requestId = "request-1",
  workerCapabilityCatalogGroupIds?: readonly string[],
  workingDirectory?: string,
): Promise<Readonly<{ ledger: RoleCallLedger; call: RoleCallFrame }>> {
  const ledger = createRoleCallLedger({
    requestId,
    policy: {
      limits: {
        maxDepth: 4,
        maxCalls: 8,
        maxCapabilityExecutions: 16,
        maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
        maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
        maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
      },
    },
  });
  await commit(ledger, {
    authority: "runtime",
    type: "create_root",
  });
  const opened = await commit(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId: "worker",
    objective: "Observe the requested state.",
    ...(workingDirectory ? { workingDirectory } : {}),
    ...(workerCapabilityCatalogGroupIds
      ? {
          workerCapabilityScope: {
            catalogGroupIds: workerCapabilityCatalogGroupIds,
          },
        }
      : {}),
  });
  const call = opened.state.calls.find(
    (candidate) => candidate.callId === opened.state.activeCallId,
  );
  if (!call) {
    throw new Error("active Worker call was not created");
  }
  return Object.freeze({ ledger, call });
}

async function openRootCapabilityLedger(
  requestId = "request-root",
): Promise<Readonly<{ ledger: RoleCallLedger; call: RoleCallFrame }>> {
  const ledger = createRoleCallLedger({
    requestId,
    policy: {
      authority: {
        id: "execution-agent-v1",
        version: 1,
        definitionHash: `sha256:${"a".repeat(64)}`,
        rootContractId: "execution_agent",
        availableSubordinateContractIds: ["worker"],
        capabilityAuthorities: ["root", "worker"],
      },
      limits: {
        maxDepth: 4,
        maxCalls: 8,
        maxCapabilityExecutions: 16,
        maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
        maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
        maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
      },
    },
  });
  const rooted = await commit(ledger, {
    authority: "runtime",
    type: "create_root",
  });
  const call = rooted.state.calls.find(
    (candidate) => candidate.callId === rooted.state.activeCallId,
  );
  if (!call) throw new Error("active root call was not created");
  return Object.freeze({ ledger, call });
}

async function commit(
  ledger: RoleCallLedger,
  command: unknown,
): Promise<RoleCallLedgerHead> {
  const result = await ledger.apply({
    expectedHead: ledger.current(),
    command: withTestExactResult(command),
  });
  if (!result.ok) {
    throw new Error(`role call commit rejected: ${result.code}`);
  }
  return result.head;
}

function withTestExactResult(command: unknown): unknown {
  if (
    typeof command !== "object" ||
    command === null ||
    Array.isArray(command)
  ) {
    return command;
  }
  const record = command as Record<string, unknown>;
  if (record.type !== "settle_capability_execution") return command;
  return {
    ...record,
    exactResult: record.exactResult ?? {
      kind: "generic_capability_result_v1",
      authority: "capability_adapter",
      status: "executed",
      ok: record.outcome === "succeeded",
      payload: {
        outcome: record.outcome,
        observedEffect: record.observedEffect,
        summary: record.summary,
        ...(typeof record.referenceData === "string"
          ? { referenceData: record.referenceData }
          : {}),
      },
      ...(Array.isArray(record.references)
        ? { references: record.references }
        : {}),
    },
  };
}

function observeLedgerApplies(ledger: RoleCallLedger) {
  const apply = vi.fn((input: Parameters<RoleCallLedger["apply"]>[0]) =>
    ledger.apply(input),
  );
  return Object.freeze({
    ledger: Object.freeze({
      current: () => ledger.current(),
      commits: ledger.commits,
      apply,
    }) satisfies RoleCallLedger,
    apply,
  });
}

function createObservationAdapter(
  execute: WorkerCapabilityAdapter<TestContext>["execute"] = vi.fn(
    async () => ({
      outcome: "succeeded" as const,
      observedEffect: "observation" as const,
      summary: "  Observation captured.  ",
    }),
  ),
  capabilityId = "example.observe",
): WorkerCapabilityAdapter<TestContext> {
  return {
    descriptor: {
      capabilityId,
      summary: "Read one example value.",
      effect: "observation",
      controls: EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
      catalogGroups: ["read", "other"],
    },
    execute,
  };
}

beforeEach(() => {
  configureDebugLogger({ enabled: false });
});

afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

describe("call-scoped Worker capability binding", () => {
  test("uses one role-capability binding contract for authorized root and Worker calls", async () => {
    const root = await openRootCapabilityLedger();
    const worker = await openWorkerLedger("request-worker");
    const rootExecute = vi.fn(async () => ({
      outcome: "succeeded" as const,
      observedEffect: "observation" as const,
      summary: "Root observation captured.",
    }));
    const workerExecute = vi.fn(async () => ({
      outcome: "succeeded" as const,
      observedEffect: "observation" as const,
      summary: "Worker observation captured.",
    }));

    const rootBinding = createRoleCapabilityBinding({
      requestId: "request-root",
      context: { marker: "root-context" },
      call: root.call,
      ledger: root.ledger,
      adapters: [createObservationAdapter(rootExecute)],
    });
    const workerBinding = createRoleCapabilityBinding({
      requestId: "request-worker",
      context: { marker: "worker-context" },
      call: worker.call,
      ledger: worker.ledger,
      adapters: [createObservationAdapter(workerExecute)],
    });

    await expect(
      rootBinding.execute({
        capabilityId: "example.observe",
        intent: "Read the root capability value.",
        controls: {},
      }),
    ).resolves.toEqual({ executionId: "capability-execution-1" });
    await expect(
      workerBinding.execute({
        capabilityId: "example.observe",
        intent: "Read the Worker capability value.",
        controls: {},
      }),
    ).resolves.toEqual({ executionId: "capability-execution-1" });

    expect(rootExecute).toHaveBeenCalledExactlyOnceWith({
      context: { marker: "root-context" },
      call: root.call,
      executionId: "capability-execution-1",
      intent: "Read the root capability value.",
      controls: {},
      settledCapabilityResults: [],
    });
    expect(workerExecute).toHaveBeenCalledExactlyOnceWith({
      context: { marker: "worker-context" },
      call: worker.call,
      executionId: "capability-execution-1",
      intent: "Read the Worker capability value.",
      controls: {},
      settledCapabilityResults: [],
    });
    expect(root.ledger.current().state).toMatchObject({
      activeCallId: "call-1",
      calls: [
        {
          roleId: "supervisor",
          status: "active",
          activationCount: 2,
        },
      ],
      capabilityExecutions: [
        {
          callId: "call-1",
          intent: "Read the root capability value.",
          controlsJson: "{}",
          status: "settled",
        },
      ],
    });
    expect(worker.ledger.current().state).toMatchObject({
      activeCallId: "call-2",
      calls: [{}, { roleId: "worker", status: "active", activationCount: 2 }],
      capabilityExecutions: [
        {
          callId: "call-2",
          intent: "Read the Worker capability value.",
          controlsJson: "{}",
          status: "settled",
        },
      ],
    });
  });

  test("binds authoring objectives only for Worker payload capabilities", async () => {
    const workerPayloadAuthority = await openWorkerLedger(
      "request-worker-payload-objective",
    );
    const workerPayloadExecute = vi.fn(async () => ({
      outcome: "succeeded" as const,
      observedEffect: "observation" as const,
      summary: "Worker payload capability completed.",
    }));
    const payloadAdapter: WorkerCapabilityAdapter<TestContext> = {
      descriptor: {
        capabilityId: "example.payload",
        summary: "Author one payload-backed observation.",
        effect: "observation",
        requiresPayloadAuthoringObjective: true,
        controls: EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
      },
      execute: workerPayloadExecute,
    };
    const workerPayloadBinding = createWorkerCapabilityBinding({
      requestId: "request-worker-payload-objective",
      context: { marker: "worker-payload-context" },
      call: workerPayloadAuthority.call,
      ledger: workerPayloadAuthority.ledger,
      adapters: [payloadAdapter],
    });

    expect(workerPayloadBinding.capabilities[0]).toMatchObject({
      capabilityId: "example.payload",
      requiresPayloadAuthoringObjective: true,
    });
    await expect(
      workerPayloadBinding.execute({
        capabilityId: "example.payload",
        intent: "Author the accepted payload.",
        controls: {},
      }),
    ).rejects.toThrow(
      "worker_capability_rejected:authoring_objective_required",
    );
    await expect(
      workerPayloadBinding.execute({
        capabilityId: "example.payload",
        intent: "Author the accepted payload.",
        authoringObjective: "   ",
        controls: {},
      }),
    ).rejects.toThrow("worker_capability_rejected:authoring_objective_invalid");
    await expect(
      workerPayloadBinding.execute({
        capabilityId: "example.payload",
        intent: "Author the accepted payload.",
        authoringObjective: AUTHORING_OBJECTIVE,
        controls: {},
      }),
    ).resolves.toEqual({ executionId: "capability-execution-1" });
    expect(workerPayloadExecute).toHaveBeenCalledExactlyOnceWith({
      context: { marker: "worker-payload-context" },
      call: workerPayloadAuthority.call,
      executionId: "capability-execution-1",
      intent: "Author the accepted payload.",
      authoringObjective: AUTHORING_OBJECTIVE,
      controls: {},
      settledCapabilityResults: [],
    });

    const workerNonPayloadAuthority = await openWorkerLedger(
      "request-worker-non-payload-objective",
    );
    const workerNonPayloadExecute = vi.fn();
    const workerNonPayloadBinding = createWorkerCapabilityBinding({
      requestId: "request-worker-non-payload-objective",
      context: { marker: "worker-non-payload-context" },
      call: workerNonPayloadAuthority.call,
      ledger: workerNonPayloadAuthority.ledger,
      adapters: [
        createObservationAdapter(
          workerNonPayloadExecute,
          "example.non-payload",
        ),
      ],
    });
    await expect(
      workerNonPayloadBinding.execute({
        capabilityId: "example.non-payload",
        intent: "Observe without payload authoring.",
        authoringObjective: AUTHORING_OBJECTIVE,
        controls: {},
      }),
    ).rejects.toThrow(
      "worker_capability_rejected:authoring_objective_forbidden",
    );
    expect(workerNonPayloadExecute).not.toHaveBeenCalled();

    const rootPayloadAuthority = await openRootCapabilityLedger(
      "request-root-payload-objective",
    );
    const rootPayloadExecute = vi.fn(async () => ({
      outcome: "succeeded" as const,
      observedEffect: "observation" as const,
      summary: "Root payload capability completed.",
    }));
    const rootPayloadBinding = createRoleCapabilityBinding({
      requestId: "request-root-payload-objective",
      context: { marker: "root-payload-context" },
      call: rootPayloadAuthority.call,
      ledger: rootPayloadAuthority.ledger,
      adapters: [{ ...payloadAdapter, execute: rootPayloadExecute }],
    });
    await expect(
      rootPayloadBinding.execute({
        capabilityId: "example.payload",
        intent: "Author the direct root payload.",
        authoringObjective: AUTHORING_OBJECTIVE,
        controls: {},
      }),
    ).rejects.toThrow(
      "worker_capability_rejected:authoring_objective_forbidden",
    );
    await expect(
      rootPayloadBinding.execute({
        capabilityId: "example.payload",
        intent: "Author the direct root payload.",
        controls: {},
      }),
    ).resolves.toEqual({ executionId: "capability-execution-1" });
    expect(rootPayloadExecute).toHaveBeenCalledExactlyOnceWith({
      context: { marker: "root-payload-context" },
      call: rootPayloadAuthority.call,
      executionId: "capability-execution-1",
      intent: "Author the direct root payload.",
      controls: {},
      settledCapabilityResults: [],
    });
  });

  test("rejects a root binding when the policy does not grant root capability authority", async () => {
    const ledger = createRoleCallLedger({
      requestId: "request-default-root",
      policy: {
        limits: {
          maxDepth: 4,
          maxCalls: 8,
          maxCapabilityExecutions: 16,
          maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
          maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
          maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
        },
      },
    });
    const rooted = await commit(ledger, {
      authority: "runtime",
      type: "create_root",
    });
    const call = rooted.state.calls[0]!;

    expect(() =>
      createRoleCapabilityBinding({
        requestId: "request-default-root",
        context: { marker: "context-1" },
        call,
        ledger,
        adapters: [createObservationAdapter()],
      }),
    ).toThrow("worker_capability_rejected:worker_call_invalid");
  });

  test("projects catalog groups as an OR scope and rejects excluded or unknown capabilities", async () => {
    configureDebugLogger({ enabled: true });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const { ledger, call } = await openWorkerLedger("request-scoped", [
      "read",
      "write",
    ]);
    const readExecute = vi.fn();
    const writeExecute = vi.fn();
    const hiddenExecute = vi.fn();
    const adapters: readonly WorkerCapabilityAdapter<TestContext>[] = [
      {
        descriptor: {
          capabilityId: "example.read",
          summary: "Read one current value.",
          effect: "observation",
          controls: EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
          catalogGroups: ["read", "shared"],
        },
        execute: readExecute,
      },
      {
        descriptor: {
          capabilityId: "example.write",
          summary: "Write one current value.",
          effect: "mutation",
          controls: EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
          catalogGroups: ["write", "shared"],
        },
        execute: writeExecute,
      },
      {
        descriptor: {
          capabilityId: "example.hidden",
          summary: "Perform an unrelated administrative action.",
          effect: "mutation",
          controls: EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
          catalogGroups: ["admin"],
        },
        execute: hiddenExecute,
      },
    ];
    const binding = createWorkerCapabilityBinding({
      requestId: "request-scoped",
      context: { marker: "context-1" },
      call,
      ledger,
      adapters,
    });

    expect(
      binding.capabilities.map(({ capabilityId }) => capabilityId),
    ).toEqual(["example.read", "example.write"]);
    expect(
      binding.capabilities.filter(
        ({ capabilityId }) => capabilityId === "example.read",
      ),
    ).toHaveLength(1);
    await expect(
      binding.execute({
        capabilityId: "example.hidden",
        intent: "Run the unrelated action.",
        controls: {},
      }),
    ).rejects.toThrow("worker_capability_rejected:capability_out_of_scope");
    expect(readExecute).not.toHaveBeenCalled();
    expect(writeExecute).not.toHaveBeenCalled();
    expect(hiddenExecute).not.toHaveBeenCalled();
    expect(ledger.current().state.capabilityExecutions).toEqual([]);

    const bindingLog = consoleLog.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .find((entry) => entry.event === "binding.created");
    expect(bindingLog).toMatchObject({
      workerCapabilityScopeMode: "catalog_groups",
      workerCapabilityScopeCatalogGroupIds: ["read", "write"],
      workerCapabilityFullCount: 3,
      workerCapabilityFilteredCount: 2,
    });

    const unknown = await openWorkerLedger("request-unknown-scope", [
      "missing",
    ]);
    expect(() =>
      createWorkerCapabilityBinding({
        requestId: "request-unknown-scope",
        context: { marker: "context-1" },
        call: unknown.call,
        ledger: unknown.ledger,
        adapters,
      }),
    ).toThrow("worker_capability_rejected:catalog_group_unknown");
    const rejectionLog = consoleLog.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .find(
        (entry) =>
          entry.event === "binding.rejected" &&
          entry.requestId === "request-unknown-scope",
      );
    expect(rejectionLog).toMatchObject({
      issueCode: "catalog_group_unknown",
      availableCapabilityCount: 3,
      workerCapabilityKnownCatalogGroupCount: 4,
      workerCapabilityFullCount: 3,
      workerCapabilityFilteredCount: 0,
    });
    expect(() =>
      projectWorkerCapabilityScope({
        entries: adapters,
        scope: { catalogGroupIds: [] },
        descriptorOf: (adapter) => adapter.descriptor,
      }),
    ).toThrow("worker_capability_scope_rejected:scope_invalid");
  });

  test("publishes a frozen descriptor and executes the exact observation adapter", async () => {
    const { ledger, call } = await openWorkerLedger();
    const execute = vi.fn(async () => {
      expect(ledger.current().state).toMatchObject({
        activeCallId: call.callId,
        calls: [
          {},
          {
            callId: call.callId,
            status: "waiting_for_capability",
            activationCount: 1,
          },
        ],
        capabilityExecutions: [
          {
            executionId: "capability-execution-1",
            callId: call.callId,
            invocationAttempt: 1,
            capabilityId: "example.observe",
            declaredEffect: "observation",
            intent: "Read the exact current value.",
            controlsJson: "{}",
            status: "running",
          },
        ],
      });
      return {
        outcome: "succeeded" as const,
        observedEffect: "observation" as const,
        summary: "  Observation captured.  ",
      };
    });
    const context = Object.freeze({ marker: "context-1" });
    const sourceAdapter = createObservationAdapter(execute);
    const binding = createWorkerCapabilityBinding({
      requestId: "request-1",
      context,
      call,
      ledger,
      adapters: [sourceAdapter],
    });
    Object.assign(sourceAdapter.descriptor, {
      capabilityId: "example.mutated",
      summary: "Mutated after binding.",
      effect: "mutation",
      catalogGroups: ["write"],
    });

    expect(binding).toMatchObject({
      requestId: "request-1",
      ledger,
      callId: call.callId,
      invocationAttempt: 1,
      capabilities: [
        {
          capabilityId: "example.observe",
          summary: "Read one example value.",
          effect: "observation",
          controls: EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
          catalogGroups: ["read", "other"],
        },
      ],
    });
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding.capabilities)).toBe(true);
    expect(Object.isFrozen(binding.capabilities[0])).toBe(true);
    expect(Object.isFrozen(binding.capabilities[0]?.catalogGroups)).toBe(true);

    await expect(
      binding.execute({
        capabilityId: "example.observe",
        intent: "  Read the exact current value.  ",
        controls: {},
      }),
    ).resolves.toEqual({
      executionId: "capability-execution-1",
    });
    expect(execute).toHaveBeenCalledExactlyOnceWith({
      context,
      call,
      executionId: "capability-execution-1",
      intent: "Read the exact current value.",
      controls: {},
      settledCapabilityResults: [],
    });
    expect(ledger.current().state).toMatchObject({
      activeCallId: call.callId,
      calls: [
        {},
        {
          callId: call.callId,
          status: "active",
          activationCount: 2,
        },
      ],
      capabilityExecutions: [
        {
          executionId: "capability-execution-1",
          callId: call.callId,
          invocationAttempt: 1,
          capabilityId: "example.observe",
          declaredEffect: "observation",
          intent: "Read the exact current value.",
          controlsJson: "{}",
          status: "settled",
          outcome: "succeeded",
          observedEffect: "observation",
          summary: "Observation captured.",
        },
      ],
    });
    await expect(
      binding.execute({
        capabilityId: "example.observe",
        intent: "Read the exact current value.",
        controls: {},
      }),
    ).rejects.toThrow("worker_capability_rejected:invocation_attempt_mismatch");
    expect(execute).toHaveBeenCalledTimes(1);

    const resumedCall = ledger
      .current()
      .state.calls.find((candidate) => candidate.callId === call.callId);
    if (!resumedCall) throw new Error("resumed Worker call missing");
    const secondExecute = vi.fn<
      WorkerCapabilityAdapter<TestContext>["execute"]
    >(async () => ({
      outcome: "succeeded" as const,
      observedEffect: "observation" as const,
      summary: "Second observation captured.",
    }));
    const secondBinding = createWorkerCapabilityBinding({
      requestId: "request-1",
      context,
      call: resumedCall,
      ledger,
      adapters: [createObservationAdapter(secondExecute)],
    });
    await secondBinding.execute({
      capabilityId: "example.observe",
      intent: "Read a second current value.",
      controls: {},
    });
    expect(secondExecute).toHaveBeenCalledOnce();
    const secondInput = secondExecute.mock.calls[0]![0];
    expect(secondInput.settledCapabilityResults).toEqual([
      {
        executionId: "capability-execution-1",
        callId: call.callId,
        invocationAttempt: 1,
        capabilityId: "example.observe",
        declaredEffect: "observation",
        outcome: "succeeded",
        observedEffect: "observation",
        summary: "Observation captured.",
        adapterResult: {
          kind: "generic_capability_result_v1",
          authority: "capability_adapter",
          status: "executed",
          ok: true,
          payload: {
            outcome: "succeeded",
            observedEffect: "observation",
            summary: "  Observation captured.  ",
          },
        },
      },
    ]);
    expect(Object.isFrozen(secondInput.settledCapabilityResults)).toBe(true);
    expect(secondInput.settledCapabilityResults.every(Object.isFrozen)).toBe(
      true,
    );
  });

  test("normalizes and freezes selection control ownership with the descriptor", async () => {
    const { ledger, call } = await openWorkerLedger();
    const selectionControlIds = ["path"];
    const execute = vi.fn<WorkerCapabilityAdapter<TestContext>["execute"]>(
      async () => ({
        outcome: "succeeded" as const,
        observedEffect: "observation" as const,
        summary: "Selected target observed.",
      }),
    );
    const binding = createWorkerCapabilityBinding({
      requestId: "request-1",
      context: { marker: "context-1" },
      call,
      ledger,
      adapters: [
        {
          descriptor: {
            capabilityId: "example.target",
            summary: "Observe one selected target with one query.",
            effect: "observation",
            controls: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string", minLength: 1, maxLength: 64 },
                query: { type: "string", minLength: 1, maxLength: 64 },
              },
              required: ["path", "query"],
            },
            selectionControlIds,
          },
          execute,
        },
      ],
    });
    selectionControlIds[0] = "query";

    expect(binding.capabilities[0]).toMatchObject({
      capabilityId: "example.target",
      selectionControlIds: ["path"],
    });
    expect(Object.isFrozen(binding.capabilities[0]?.selectionControlIds)).toBe(
      true,
    );

    await expect(
      binding.execute({
        capabilityId: "example.target",
        intent: "Observe the selected target.",
        controls: { path: "project/a.txt", query: "current value" },
      }),
    ).resolves.toEqual({ executionId: "capability-execution-1" });
    expect(execute).toHaveBeenCalledExactlyOnceWith({
      context: { marker: "context-1" },
      call,
      executionId: "capability-execution-1",
      intent: "Observe the selected target.",
      controls: { path: "project/a.txt", query: "current value" },
      settledCapabilityResults: [],
    });
  });

  test("normalizes, freezes and preserves mechanical controls refinement", async () => {
    const { ledger, call } = await openWorkerLedger();
    const sourceDescriptor = {
      capabilityId: "example.mechanical",
      summary: "  Apply complete controls mechanically.  ",
      effect: "observation" as const,
      controls: EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
      controlsRefinement: "mechanical_when_complete" as const,
    };
    const binding = createWorkerCapabilityBinding({
      requestId: "request-1",
      context: { marker: "context-1" },
      call,
      ledger,
      adapters: [
        {
          descriptor: sourceDescriptor,
          execute: vi.fn(),
        },
      ],
    });

    expect(binding.capabilities[0]).toMatchObject({
      capabilityId: "example.mechanical",
      summary: "Apply complete controls mechanically.",
      controlsRefinement: "mechanical_when_complete",
    });
    expect(binding.capabilities[0]).not.toBe(sourceDescriptor);
    expect(Object.isFrozen(binding.capabilities[0])).toBe(true);
  });

  test("executes an admitted observation batch concurrently and settles it once", async () => {
    const { ledger, call } = await openWorkerLedger();
    let startedCount = 0;
    let resolveBothStarted!: () => void;
    let releaseExecutions!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      resolveBothStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseExecutions = resolve;
    });
    const execute = vi.fn<WorkerCapabilityAdapter<TestContext>["execute"]>(
      async () => {
        startedCount += 1;
        if (startedCount === 2) resolveBothStarted();
        await released;
        return {
          outcome: "succeeded" as const,
          observedEffect: "observation" as const,
          summary: `Observation ${startedCount}.`,
        };
      },
    );
    const binding = createWorkerCapabilityBinding({
      requestId: "request-1",
      context: { marker: "context-1" },
      call,
      ledger,
      adapters: [
        createObservationAdapter(execute),
        createObservationAdapter(execute, "example.observe_second"),
      ],
    });

    const execution = binding.executeBatch({
      invocations: [
        {
          capabilityId: "example.observe_second",
          intent: "Read the first independent source.",
          controls: {},
        },
        {
          capabilityId: "example.observe",
          intent: "Read the second independent source.",
          controls: {},
        },
      ],
    });
    await expect(
      Promise.race([
        bothStarted.then(() => "started"),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error("batch_not_concurrent")), 1_000),
        ),
      ]),
    ).resolves.toBe("started");
    expect(ledger.current().state).toMatchObject({
      calls: [{}, { callId: call.callId, status: "waiting_for_capability" }],
      capabilityExecutions: [
        {
          status: "running",
          invocationAttempt: 1,
          intent: "Read the first independent source.",
          controlsJson: "{}",
        },
        {
          status: "running",
          invocationAttempt: 1,
          intent: "Read the second independent source.",
          controlsJson: "{}",
        },
      ],
    });
    releaseExecutions();
    await expect(execution).resolves.toEqual({
      executionIds: ["capability-execution-1", "capability-execution-2"],
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(
      execute.mock.calls.map(([input]) => input.settledCapabilityResults),
    ).toEqual([[], []]);
    expect(ledger.current().state).toMatchObject({
      calls: [
        {},
        { callId: call.callId, status: "active", activationCount: 2 },
      ],
      capabilityExecutions: [
        { status: "settled", outcome: "succeeded" },
        { status: "settled", outcome: "succeeded" },
      ],
    });
  });

  test("rejects a write in a batch before beginning or executing any capability", async () => {
    const { ledger, call } = await openWorkerLedger();
    const observe = vi.fn(async () => ({
      outcome: "succeeded" as const,
      observedEffect: "observation" as const,
      summary: "Observed.",
    }));
    const mutate = vi.fn(async () => ({
      outcome: "succeeded" as const,
      observedEffect: "mutation" as const,
      summary: "Mutated.",
    }));
    const binding = createWorkerCapabilityBinding({
      requestId: "request-1",
      context: { marker: "context-1" },
      call,
      ledger,
      adapters: [
        createObservationAdapter(observe),
        {
          descriptor: {
            capabilityId: "example.write",
            summary: "Write one example value.",
            effect: "mutation",
            controls: EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
          },
          execute: mutate,
        },
      ],
    });

    await expect(
      binding.executeBatch({
        invocations: [
          {
            capabilityId: "example.observe",
            intent: "Read the current value.",
            controls: {},
          },
          {
            capabilityId: "example.write",
            intent: "Write the next value.",
            controls: {},
          },
        ],
      }),
    ).rejects.toThrow("worker_capability_rejected:batch_effect_invalid");
    expect(observe).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
    expect(ledger.current().state.capabilityExecutions).toEqual([]);
  });

  test("rejects invalid or duplicate registrations before exposing a binding", async () => {
    const { ledger, call } = await openWorkerLedger();
    const adapter = createObservationAdapter();
    expect(() =>
      createWorkerCapabilityBinding({
        requestId: "request-1",
        context: { marker: "context-1" },
        call,
        ledger,
        adapters: [adapter, adapter],
      }),
    ).toThrow("worker_capability_rejected:duplicate_capability_id");

    expect(() =>
      createWorkerCapabilityBinding({
        requestId: "request-1",
        context: { marker: "context-1" },
        call: { ...call, roleId: "reviewer" },
        ledger,
        adapters: [adapter],
      }),
    ).toThrow("worker_capability_rejected:worker_call_invalid");

    expect(() =>
      createWorkerCapabilityBinding({
        requestId: "request-1",
        context: { marker: "context-1" },
        call,
        ledger,
        adapters: Array.from(
          { length: WORKER_CAPABILITY_COUNT_MAX + 1 },
          (_, index) => ({
            ...adapter,
            descriptor: {
              ...adapter.descriptor,
              capabilityId: `example.observe.${index}`,
            },
          }),
        ),
      }),
    ).toThrow("worker_capability_rejected:capability_count_invalid");

    expect(() =>
      createWorkerCapabilityBinding({
        requestId: "request-1",
        context: { marker: "context-1" },
        call,
        ledger,
        adapters: [
          {
            ...adapter,
            descriptor: {
              ...adapter.descriptor,
              summary: ` ${"x".repeat(WORKER_CAPABILITY_SUMMARY_MAX_LENGTH)} `,
            },
          },
        ],
      }),
    ).toThrow("worker_capability_rejected:descriptor_summary_invalid");

    expect(() =>
      createWorkerCapabilityBinding({
        requestId: "request-1",
        context: { marker: "context-1" },
        call,
        ledger,
        adapters: [
          {
            ...adapter,
            descriptor: {
              ...adapter.descriptor,
              controlsRefinement:
                "model_refinement" as unknown as "mechanical_when_complete",
            },
          },
        ],
      }),
    ).toThrow(
      "worker_capability_rejected:descriptor_controls_refinement_invalid",
    );

    const controls = {
      type: "object" as const,
      additionalProperties: false as const,
      properties: {
        path: { type: "string" as const, minLength: 1, maxLength: 64 },
        optional: { type: "string" as const, minLength: 1, maxLength: 64 },
      },
      required: ["path"],
    };
    for (const [selectionControlIds, issueCode] of [
      ["path", "selection_control_ids_invalid"],
      [["path", "path"], "selection_control_ids_duplicate"],
      [["missing"], "selection_control_unknown"],
      [["optional"], "selection_control_not_required"],
    ] as const) {
      expect(() =>
        createWorkerCapabilityBinding({
          requestId: "request-1",
          context: { marker: "context-1" },
          call,
          ledger,
          adapters: [
            {
              ...adapter,
              descriptor: {
                ...adapter.descriptor,
                controls,
                selectionControlIds:
                  selectionControlIds as unknown as readonly string[],
              },
            },
          ],
        }),
      ).toThrow(`worker_capability_rejected:descriptor_${issueCode}`);
    }

    for (const [runtimePathControlIds, issueCode] of [
      ["path", "runtime_path_control_ids_invalid"],
      [["path", "path"], "runtime_path_control_ids_duplicate"],
      [["missing"], "runtime_path_control_unknown"],
      [[" path"], "runtime_path_control_ids_invalid"],
    ] as const) {
      expect(() =>
        createWorkerCapabilityBinding({
          requestId: "request-1",
          context: { marker: "context-1" },
          call,
          ledger,
          adapters: [
            {
              ...adapter,
              descriptor: {
                ...adapter.descriptor,
                controls,
                runtimePathControlIds:
                  runtimePathControlIds as unknown as readonly string[],
              },
            },
          ],
        }),
      ).toThrow(`worker_capability_rejected:descriptor_${issueCode}`);
    }

    const runtimePathControlIds = ["optional", "path"];
    const binding = createWorkerCapabilityBinding({
      requestId: "request-1",
      context: { marker: "context-1" },
      call,
      ledger,
      adapters: [
        {
          ...adapter,
          descriptor: {
            ...adapter.descriptor,
            controls,
            runtimePathControlIds,
          },
        },
      ],
    });
    expect(binding.capabilities[0]?.runtimePathControlIds).toEqual([
      "optional",
      "path",
    ]);
    expect(binding.capabilities[0]?.runtimePathControlIds).not.toBe(
      runtimePathControlIds,
    );
    expect(
      Object.isFrozen(binding.capabilities[0]?.runtimePathControlIds),
    ).toBe(true);
  });

  test("rejects a stale activation or no-longer-current call without executing an adapter", async () => {
    const { ledger, call } = await openWorkerLedger();
    const execute = vi.fn();
    const binding = createWorkerCapabilityBinding({
      requestId: "request-1",
      context: { marker: "context-1" },
      call,
      ledger,
      adapters: [createObservationAdapter(execute)],
    });

    await commit(ledger, {
      authority: "active_role",
      type: "begin_capability_execution",
      callId: call.callId,
      invocationAttempt: call.activationCount,
      capabilityId: "example.observe",
      declaredEffect: "observation",
      intent: "Read the exact current value.",
      controlsJson: "{}",
    });
    await commit(ledger, {
      authority: "runtime",
      type: "settle_capability_execution",
      callId: call.callId,
      executionId: "capability-execution-1",
      outcome: "succeeded",
      observedEffect: "observation",
      summary: "One observation was captured.",
    });
    await expect(
      binding.execute({
        capabilityId: "example.observe",
        intent: "Read the exact current value.",
        controls: {},
      }),
    ).rejects.toThrow("worker_capability_rejected:invocation_attempt_mismatch");
    await expect(
      binding.executeBatch({
        invocations: [
          {
            capabilityId: "example.observe",
            intent: "Read the first exact current value.",
            controls: {},
          },
          {
            capabilityId: "example.observe",
            intent: "Read the second exact current value.",
            controls: {},
          },
        ],
      }),
    ).rejects.toThrow("worker_capability_rejected:invocation_attempt_mismatch");

    await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-1",
      childCallId: call.callId,
      outcome: "completed",
      summary: "Worker finished.",
    });
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: "Observe another bounded value.",
    });
    await expect(
      binding.execute({
        capabilityId: "example.observe",
        intent: "Read the exact current value.",
        controls: {},
      }),
    ).rejects.toThrow("worker_capability_rejected:call_not_current");
    expect(execute).not.toHaveBeenCalled();
  });

  test("rejects execution when the authoritative Worker working directory differs from the frozen binding", async () => {
    const { ledger, call } = await openWorkerLedger(
      "request-working-directory-authority",
      undefined,
      "Project",
    );
    const execute = vi.fn();
    const authoritativeHead = ledger.current();
    let currentReadCount = 0;
    const driftedLedger = Object.freeze({
      current: () => {
        currentReadCount += 1;
        if (currentReadCount === 1) return authoritativeHead;
        return Object.freeze({
          ...authoritativeHead,
          state: Object.freeze({
            ...authoritativeHead.state,
            calls: Object.freeze(
              authoritativeHead.state.calls.map((candidate) =>
                candidate.callId === call.callId
                  ? Object.freeze({
                      ...candidate,
                      workingDirectory: "OtherProject",
                    })
                  : candidate,
              ),
            ),
          }),
        });
      },
      commits: ledger.commits,
      apply: vi.fn((input: Parameters<RoleCallLedger["apply"]>[0]) =>
        ledger.apply(input),
      ),
    }) satisfies RoleCallLedger;
    const binding = createWorkerCapabilityBinding({
      requestId: "request-working-directory-authority",
      context: { marker: "context-1" },
      call,
      ledger: driftedLedger,
      adapters: [createObservationAdapter(execute)],
    });

    await expect(
      binding.execute({
        capabilityId: "example.observe",
        intent: "Read the exact current value.",
        controls: {},
      }),
    ).rejects.toThrow("worker_capability_rejected:working_directory_mismatch");
    expect(execute).not.toHaveBeenCalled();
    expect(driftedLedger.apply).not.toHaveBeenCalled();
  });

  test("rejects wrong-request and completed call authority before adapter execution", async () => {
    const { ledger, call } = await openWorkerLedger();
    const execute = vi.fn();
    expect(() =>
      createWorkerCapabilityBinding({
        requestId: "request-other",
        context: { marker: "context-1" },
        call,
        ledger,
        adapters: [createObservationAdapter(execute)],
      }),
    ).toThrow("worker_capability_rejected:request_id_mismatch");

    await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-1",
      childCallId: call.callId,
      outcome: "completed",
      summary: "Worker finished.",
    });
    expect(() =>
      createWorkerCapabilityBinding({
        requestId: "request-1",
        context: { marker: "context-1" },
        call,
        ledger,
        adapters: [createObservationAdapter(execute)],
      }),
    ).toThrow("worker_capability_rejected:call_not_current");
    expect(execute).not.toHaveBeenCalled();
  });

  test("rejects unavailable capabilities, malformed intent, and controls without fallback", async () => {
    const { ledger, call } = await openWorkerLedger();
    const executeObservation = vi.fn();
    const binding = createWorkerCapabilityBinding({
      requestId: "request-1",
      context: { marker: "context-1" },
      call,
      ledger,
      adapters: [createObservationAdapter(executeObservation)],
    });

    await expect(
      binding.execute({
        capabilityId: "missing.observe",
        intent: "Read the exact current value.",
        controls: {},
      }),
    ).rejects.toThrow("worker_capability_rejected:capability_unavailable");
    await expect(
      binding.execute({
        capabilityId: "example.observe",
        intent: " ",
        controls: {},
      }),
    ).rejects.toThrow("worker_capability_rejected:intent_invalid");
    await expect(
      binding.execute({
        capabilityId: "example.observe",
        intent: "x".repeat(WORKER_CAPABILITY_INTENT_MAX_LENGTH + 1),
        controls: {},
      }),
    ).rejects.toThrow("worker_capability_rejected:intent_invalid");
    await expect(
      binding.execute({
        capabilityId: "example.observe",
        intent: 42,
        controls: {},
      }),
    ).rejects.toThrow("worker_capability_rejected:intent_invalid");
    await expect(
      binding.execute({
        capabilityId: "example.observe",
        intent: "Read the exact current value.",
        controls: { unexpected: true },
      }),
    ).rejects.toThrow("worker_capability_rejected:controls_unknown");
    await expect(
      binding.execute({
        capabilityId: "example.observe",
        intent: "Read the exact current value.",
        controls: [],
      }),
    ).rejects.toThrow("worker_capability_rejected:controls_not_object");
    expect(executeObservation).not.toHaveBeenCalled();
    expect(ledger.current().state.capabilityExecutions).toEqual([]);
  });

  test("validates exact capability-specific controls before ledger execution", async () => {
    const { ledger, call } = await openWorkerLedger();
    const execute = vi.fn<WorkerCapabilityAdapter<TestContext>["execute"]>(
      async () => ({
        outcome: "succeeded" as const,
        observedEffect: "observation" as const,
        summary: "Selected path observed.",
      }),
    );
    const binding = createWorkerCapabilityBinding({
      requestId: "request-1",
      context: { marker: "context-1" },
      call,
      ledger,
      adapters: [
        {
          descriptor: {
            capabilityId: "example.path",
            summary: "Observe one selected path.",
            effect: "observation",
            controls: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string", minLength: 1, maxLength: 8 },
              },
              required: ["path"],
            },
          },
          execute,
        },
      ],
    });

    for (const [controls, issueCode] of [
      [{}, "controls_required_missing"],
      [{ path: "ok", extra: true }, "controls_unknown"],
      [{ path: 42 }, "controls_string_invalid"],
      [{ path: "too-long-path" }, "controls_string_invalid"],
    ] as const) {
      await expect(
        binding.execute({
          capabilityId: "example.path",
          intent: "Observe the selected path.",
          controls,
        }),
      ).rejects.toThrow(`worker_capability_rejected:${issueCode}`);
    }
    expect(execute).not.toHaveBeenCalled();

    await expect(
      binding.execute({
        capabilityId: "example.path",
        intent: "Observe the selected path.",
        controls: { path: "safe.txt" },
      }),
    ).resolves.toEqual({ executionId: "capability-execution-1" });
    expect(execute).toHaveBeenCalledExactlyOnceWith({
      context: { marker: "context-1" },
      call,
      executionId: "capability-execution-1",
      intent: "Observe the selected path.",
      controls: { path: "safe.txt" },
      settledCapabilityResults: [],
    });
    expect(Object.isFrozen(execute.mock.calls[0]![0].controls)).toBe(true);
  });

  test("settles truthful domain failure and invalid adapter results exactly once", async () => {
    const mismatchedAuthority = await openWorkerLedger();
    const mismatched = createWorkerCapabilityBinding({
      requestId: "request-1",
      context: { marker: "context-1" },
      call: mismatchedAuthority.call,
      ledger: mismatchedAuthority.ledger,
      adapters: [
        createObservationAdapter(
          vi.fn(async () => ({
            outcome: "succeeded" as const,
            observedEffect: "mutation" as const,
            summary: "Unexpected mutation.",
          })),
        ),
      ],
    });
    await expect(
      mismatched.execute({
        capabilityId: "example.observe",
        intent: "Read the exact current value.",
        controls: {},
      }),
    ).resolves.toEqual({
      executionId: "capability-execution-1",
    });
    expect(
      mismatchedAuthority.ledger.current().state.capabilityExecutions,
    ).toEqual([
      expect.objectContaining({
        status: "settled",
        outcome: "failed",
        observedEffect: "indeterminate",
        summary: "The capability returned an invalid result.",
      }),
    ]);

    const failedAuthority = await openWorkerLedger();
    const failedAfterObservation = createWorkerCapabilityBinding({
      requestId: "request-1",
      context: { marker: "context-1" },
      call: failedAuthority.call,
      ledger: failedAuthority.ledger,
      adapters: [
        createObservationAdapter(
          vi.fn(async () => ({
            outcome: "failed" as const,
            observedEffect: "observation" as const,
            summary: "The observation occurred before the operation failed.",
            failureOutcomeFingerprint: `sha256:${"f".repeat(64)}`,
          })),
        ),
      ],
    });
    await expect(
      failedAfterObservation.execute({
        capabilityId: "example.observe",
        intent: "Read the exact current value.",
        controls: {},
      }),
    ).resolves.toEqual({
      executionId: "capability-execution-1",
    });
    expect(failedAuthority.ledger.current().state.capabilityExecutions).toEqual(
      [
        expect.objectContaining({
          status: "settled",
          outcome: "failed",
          observedEffect: "observation",
          summary: "The observation occurred before the operation failed.",
        }),
      ],
    );

    const malformedAuthority = await openWorkerLedger();
    const malformedObserved = observeLedgerApplies(malformedAuthority.ledger);
    const malformed = createWorkerCapabilityBinding({
      requestId: "request-1",
      context: { marker: "context-1" },
      call: malformedAuthority.call,
      ledger: malformedObserved.ledger,
      adapters: [
        createObservationAdapter(
          vi.fn(async () => {
            return {
              outcome: "succeeded",
              observedEffect: "observation",
              summary: "Observation.",
              hidden: "must not cross the boundary",
            } as never;
          }),
        ),
      ],
    });
    await expect(
      malformed.execute({
        capabilityId: "example.observe",
        intent: "Read the exact current value.",
        controls: {},
      }),
    ).resolves.toEqual({
      executionId: "capability-execution-1",
    });
    expect(
      malformedAuthority.ledger.current().state.capabilityExecutions,
    ).toEqual([
      expect.objectContaining({
        status: "settled",
        outcome: "failed",
        observedEffect: "indeterminate",
      }),
    ]);
    expect(
      malformedObserved.apply.mock.calls.map(
        ([input]) => (input.command as { type?: unknown }).type,
      ),
    ).toEqual(["begin_capability_execution", "settle_capability_execution"]);

    const oversizedAuthority = await openWorkerLedger();
    const oversized = createWorkerCapabilityBinding({
      requestId: "request-1",
      context: { marker: "context-1" },
      call: oversizedAuthority.call,
      ledger: oversizedAuthority.ledger,
      adapters: [
        createObservationAdapter(
          vi.fn(async () => ({
            outcome: "succeeded" as const,
            observedEffect: "observation" as const,
            summary: ` ${"x".repeat(ROLE_CALL_RESULT_MAX_LENGTH)} `,
          })),
        ),
      ],
    });
    await expect(
      oversized.execute({
        capabilityId: "example.observe",
        intent: "Read the exact current value.",
        controls: {},
      }),
    ).resolves.toEqual({
      executionId: "capability-execution-1",
    });
    expect(
      oversizedAuthority.ledger.current().state.capabilityExecutions,
    ).toEqual([
      expect.objectContaining({
        status: "settled",
        outcome: "failed",
        observedEffect: "indeterminate",
      }),
    ]);
  });

  test("does not execute before begin or retry after settle rejection", async () => {
    const beginAuthority = await openWorkerLedger();
    const beginExecute = vi.fn();
    const beginApply = vi.fn(
      async (): Promise<RoleCallLedgerCommitResult> =>
        Object.freeze({
          ok: false,
          status: "rejected",
          code: "stale_head",
          head: beginAuthority.ledger.current(),
        }),
    );
    const beginRejectingLedger: RoleCallLedger = Object.freeze({
      current: () => beginAuthority.ledger.current(),
      commits: beginAuthority.ledger.commits,
      apply: beginApply,
    });
    const beginRejected = createWorkerCapabilityBinding({
      requestId: "request-1",
      context: { marker: "context-1" },
      call: beginAuthority.call,
      ledger: beginRejectingLedger,
      adapters: [createObservationAdapter(beginExecute)],
    });

    await expect(
      beginRejected.execute({
        capabilityId: "example.observe",
        intent: "Read the exact current value.",
        controls: {},
      }),
    ).rejects.toThrow("worker_capability_begin_rejected:stale_head");
    expect(beginApply).toHaveBeenCalledTimes(1);
    expect(beginExecute).not.toHaveBeenCalled();
    expect(beginAuthority.ledger.current().state.capabilityExecutions).toEqual(
      [],
    );

    const settleAuthority = await openWorkerLedger();
    const settleExecute = vi.fn(async () => ({
      outcome: "succeeded" as const,
      observedEffect: "observation" as const,
      summary: "Observation captured.",
    }));
    const settleApply = vi.fn(
      async (
        input: Parameters<RoleCallLedger["apply"]>[0],
      ): Promise<RoleCallLedgerCommitResult> => {
        const command = input.command as { type?: unknown };
        if (command.type === "settle_capability_execution") {
          return Object.freeze({
            ok: false,
            status: "rejected",
            code: "stale_head",
            head: settleAuthority.ledger.current(),
          });
        }
        return settleAuthority.ledger.apply(input);
      },
    );
    const settleRejectingLedger: RoleCallLedger = Object.freeze({
      current: () => settleAuthority.ledger.current(),
      commits: settleAuthority.ledger.commits,
      apply: settleApply,
    });
    const settleRejected = createWorkerCapabilityBinding({
      requestId: "request-1",
      context: { marker: "context-1" },
      call: settleAuthority.call,
      ledger: settleRejectingLedger,
      adapters: [createObservationAdapter(settleExecute)],
    });

    await expect(
      settleRejected.execute({
        capabilityId: "example.observe",
        intent: "Read the exact current value.",
        controls: {},
      }),
    ).rejects.toThrow("worker_capability_settle_rejected:stale_head");
    expect(settleApply).toHaveBeenCalledTimes(2);
    expect(settleExecute).toHaveBeenCalledTimes(1);
    expect(settleAuthority.ledger.current().state.capabilityExecutions).toEqual(
      [
        expect.objectContaining({
          status: "running",
          outcome: null,
          observedEffect: null,
        }),
      ],
    );
  });

  test("propagates adapter cancellation instead of settling it as an ordinary capability failure", async () => {
    const { ledger, call } = await openWorkerLedger();
    const aborted = new Error("request cancelled");
    aborted.name = "AbortError";
    const binding = createWorkerCapabilityBinding({
      requestId: "request-1",
      context: { marker: "context-1" },
      call,
      ledger,
      adapters: [
        createObservationAdapter(
          vi.fn(async () => {
            throw aborted;
          }),
        ),
      ],
    });

    await expect(
      binding.execute({
        capabilityId: "example.observe",
        intent: "Read the exact current value.",
        controls: {},
      }),
    ).rejects.toBe(aborted);
    expect(ledger.current().state.capabilityExecutions).toEqual([
      expect.objectContaining({
        status: "running",
        outcome: null,
        observedEffect: null,
      }),
    ]);
  });

  test("logs exact accepted and failed boundaries without sensitive content", async () => {
    configureDebugLogger({ enabled: true });
    const resultSecret = "RESULT_SECRET_MUST_NOT_BE_LOGGED";
    const intentSecret = "INTENT_SECRET_MUST_NOT_BE_LOGGED";
    const controlSecret = "CONTROL_SECRET_MUST_NOT_BE_LOGGED";
    const errorSecret = "ERROR_SECRET_MUST_NOT_BE_LOGGED";
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const successfulAuthority = await openWorkerLedger("request-logging");
    const successful = createWorkerCapabilityBinding({
      requestId: "request-logging",
      context: { marker: "context-1" },
      call: successfulAuthority.call,
      ledger: successfulAuthority.ledger,
      adapters: [
        {
          descriptor: {
            capabilityId: "example.observe",
            summary: "CAPABILITY_SUMMARY_SECRET_MUST_NOT_BE_LOGGED",
            effect: "observation",
            controls: EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
          },
          execute: vi.fn(async () => ({
            outcome: "succeeded" as const,
            observedEffect: "observation" as const,
            summary: resultSecret,
          })),
        },
      ],
    });
    await expect(
      successful.execute({
        capabilityId: "example.observe",
        intent: "Read the exact current value.",
        controls: { token: controlSecret },
      }),
    ).rejects.toThrow("worker_capability_rejected:controls_unknown");
    await successful.execute({
      capabilityId: "example.observe",
      intent: intentSecret,
      controls: {},
    });
    await expect(
      successful.execute({
        capabilityId: "example.observe",
        intent: "Read the exact current value.",
        controls: {},
      }),
    ).rejects.toThrow("worker_capability_rejected:invocation_attempt_mismatch");

    const failingAuthority = await openWorkerLedger("request-logging");
    const failingObserved = observeLedgerApplies(failingAuthority.ledger);
    const failing = createWorkerCapabilityBinding({
      requestId: "request-logging",
      context: { marker: "context-1" },
      call: failingAuthority.call,
      ledger: failingObserved.ledger,
      adapters: [
        createObservationAdapter(
          vi.fn(async () => {
            const error = new TypeError(errorSecret);
            error.name = errorSecret;
            throw error;
          }),
        ),
      ],
    });
    await expect(
      failing.execute({
        capabilityId: "example.observe",
        intent: "Read the exact current value.",
        controls: {},
      }),
    ).resolves.toEqual({
      executionId: "capability-execution-1",
    });
    expect(
      failingAuthority.ledger.current().state.capabilityExecutions,
    ).toEqual([
      expect.objectContaining({
        status: "settled",
        outcome: "failed",
        observedEffect: "indeterminate",
      }),
    ]);
    expect(
      failingObserved.apply.mock.calls.map(
        ([input]) => (input.command as { type?: unknown }).type,
      ),
    ).toEqual(["begin_capability_execution", "settle_capability_execution"]);

    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.worker_capabilities",
          event: "binding.created",
          requestId: "request-logging",
          callId: successfulAuthority.call.callId,
          invocationAttempt: 1,
          availableCapabilityCount: 1,
          workerCapabilityScopeMode: "full",
          workerCapabilityScopeCatalogGroupIds: [],
          workerCapabilityFullCount: 1,
          workerCapabilityFilteredCount: 1,
        }),
        expect.objectContaining({
          scope: "runtime.worker_capabilities",
          event: "selection.resolved",
          capabilityId: "example.observe",
          declaredEffect: "observation",
          intentLength: intentSecret.length,
        }),
        expect.objectContaining({
          scope: "runtime.worker_capabilities",
          event: "execution.started",
          capabilityId: "example.observe",
          executionId: "capability-execution-1",
          intentLength: intentSecret.length,
        }),
        expect.objectContaining({
          scope: "runtime.worker_capabilities",
          event: "execution.completed",
          executionId: "capability-execution-1",
          observedEffect: "observation",
          summaryLength: resultSecret.length,
        }),
        expect.objectContaining({
          scope: "runtime.worker_capabilities",
          event: "selection.rejected",
          issueCode: "invocation_attempt_mismatch",
          attemptedCallId: successfulAuthority.call.callId,
          attemptedInvocationAttempt: 2,
        }),
        expect.objectContaining({
          scope: "runtime.worker_capabilities",
          event: "execution.failed",
          executionId: "capability-execution-1",
          errorType: "TypeError",
        }),
      ]),
    );
    expect(JSON.stringify(logs)).not.toContain(resultSecret);
    expect(JSON.stringify(logs)).not.toContain(intentSecret);
    expect(JSON.stringify(logs)).not.toContain(controlSecret);
    expect(JSON.stringify(logs)).not.toContain(errorSecret);
    expect(JSON.stringify(logs)).not.toContain(
      "CAPABILITY_SUMMARY_SECRET_MUST_NOT_BE_LOGGED",
    );
  });
});
