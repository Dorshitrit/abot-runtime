import {
  createRoleCallLedger,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  type RoleCallFrame,
  type RoleCallLedger,
  type RoleCallLedgerHead,
} from "../../orchestration/role-calls/index.js";
import {
  createWorkerCapabilityBinding,
  createWorkerCapabilityPayloadAuthor as createRuntimeWorkerPayloadAuthor,
  EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
  type WorkerCapabilityAdapter,
  type WorkerCapabilityPayloadAuthor,
} from "../../orchestration/worker-capabilities/index.js";
import { projectWorkerCapabilityPayloadSourceProvenance } from "../../orchestration/worker-capabilities/payload-source-provenance.js";
import { createRequestWorkerCapabilityPayloadAuthor as createRuntimeRequestWorkerPayloadAuthor } from "../../request/worker-capability-payload.js";

type TestPayloadContext = Readonly<Record<string, never>>;
type PayloadAuthorInput = Parameters<
  WorkerCapabilityPayloadAuthor["author"]
>[0];

/** Supplies direct-Worker author fixtures with a canonical runtime receipt. */
export function createTestWorkerCapabilityPayloadAuthor(
  params: Parameters<typeof createRuntimeWorkerPayloadAuthor>[0],
): WorkerCapabilityPayloadAuthor {
  return bindRuntimeWorkerReceipt(
    createRuntimeWorkerPayloadAuthor(params),
    params.requestId,
  );
}

export function createTestRequestWorkerCapabilityPayloadAuthor(
  ...args: Parameters<typeof createRuntimeRequestWorkerPayloadAuthor>
): WorkerCapabilityPayloadAuthor {
  return bindRuntimeWorkerReceipt(
    createRuntimeRequestWorkerPayloadAuthor(...args),
    args[0].requestId,
  );
}

function bindRuntimeWorkerReceipt(
  author: WorkerCapabilityPayloadAuthor,
  requestId: string,
): WorkerCapabilityPayloadAuthor {
  return Object.freeze({
    author: (input) =>
      isDirectWorkerCall(input.call) && !input.assignmentProvenance
        ? authorWithRuntimeReceipt(author, requestId, input)
        : author.author(input),
  });
}

async function authorWithRuntimeReceipt(
  author: WorkerCapabilityPayloadAuthor,
  requestId: string,
  input: PayloadAuthorInput,
): ReturnType<WorkerCapabilityPayloadAuthor["author"]> {
  const ledger = await openDirectWorkerLedger(requestId, input.call);
  await advanceWorkerActivation(ledger, requestId, input.call.activationCount);
  const head = ledger.current();
  const call = requireActiveWorker(ledger);
  const assignmentProvenance = projectWorkerCapabilityPayloadSourceProvenance({
    ledger,
    head,
    call,
  });
  return author.author(Object.freeze({ ...input, call, assignmentProvenance }));
}

async function openDirectWorkerLedger(
  requestId: string,
  sourceCall: RoleCallFrame,
): Promise<RoleCallLedger> {
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
  await commit(ledger, { authority: "runtime", type: "create_root" });
  await commit(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId: "worker",
    objective: sourceCall.objective,
    ...(sourceCall.workingDirectory
      ? { workingDirectory: sourceCall.workingDirectory }
      : {}),
    ...(sourceCall.workerCapabilityScope
      ? { workerCapabilityScope: sourceCall.workerCapabilityScope }
      : {}),
  });
  return ledger;
}

async function advanceWorkerActivation(
  ledger: RoleCallLedger,
  requestId: string,
  expectedActivation: number,
): Promise<void> {
  for (let activation = 1; activation < expectedActivation; activation += 1) {
    const capabilityId = `test.advance_${activation}`;
    const adapter: WorkerCapabilityAdapter<TestPayloadContext> = {
      descriptor: {
        capabilityId,
        summary: "Advance one test Worker activation.",
        effect: "observation",
        controls: EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
      },
      execute: async () => ({
        outcome: "succeeded",
        observedEffect: "observation",
        summary: "Test Worker activation advanced.",
      }),
    };
    const binding = createWorkerCapabilityBinding({
      requestId,
      context: Object.freeze({}),
      call: requireActiveWorker(ledger),
      ledger,
      adapters: [adapter],
    });
    await binding.execute({
      capabilityId,
      intent: "Advance the test Worker activation.",
      controls: {},
    });
  }
}

async function commit(
  ledger: RoleCallLedger,
  command: unknown,
): Promise<RoleCallLedgerHead> {
  const result = await ledger.apply({
    expectedHead: ledger.current(),
    command,
  });
  if (!result.ok) {
    throw new Error(`test_role_call_commit_rejected:${result.code}`);
  }
  return result.head;
}

function requireActiveWorker(ledger: RoleCallLedger): RoleCallFrame {
  const head = ledger.current();
  const call = head.state.calls.find(
    ({ callId }) => callId === head.state.activeCallId,
  );
  if (!call || call.roleId !== "worker") {
    throw new Error("test_active_worker_missing");
  }
  return call;
}

function isDirectWorkerCall(call: RoleCallFrame): boolean {
  return (
    call.roleId === "worker" &&
    call.parentCallId !== null &&
    call.depth === 1 &&
    call.objective !== null
  );
}
