import { describe, expect, test, vi } from "vitest";

import {
  SEMANTIC_COMPACTION_CONTEXT_LANE,
  createRequestContextCompactionStore,
  createSemanticCompactionSha256Fingerprint,
  projectSemanticCompactionDependencyResults,
} from "../context/semantic-compaction/index.js";
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
  EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
  WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS,
  WORKER_CAPABILITY_RAW_PAYLOAD_MODEL_STEP,
  type WorkerCapabilityDescriptor,
  type WorkerCapabilityPayloadModelRequest,
} from "../orchestration/worker-capabilities/index.js";

const REQUEST_ID = "request-semantic-dependency-continuity";
const PROMPT = "Create the final artifact from the collected source evidence.";
const DESCRIPTOR: WorkerCapabilityDescriptor = Object.freeze({
  capabilityId: "write_grounded_artifact",
  summary: "Writes the final artifact from supplied evidence.",
  effect: "observation" as const,
  controls: EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
});

describe("semantic compaction dependency continuity", () => {
  test("projects only canonical transitive checkpoints through resultRef into tool_payload.raw", async () => {
    const ledger = createLedger();
    const store = createRequestContextCompactionStore();
    const rooted = await commit(ledger, {
      authority: "runtime",
      type: "create_root",
    });
    const rootCallId = requireId(rooted.state.rootCallId);

    const irrelevant = await openWorker(
      ledger,
      rootCallId,
      "Collect evidence for an unrelated sibling outcome.",
    );
    store.commit(
      checkpoint(irrelevant, "scope:irrelevant", "irrelevant-source"),
    );
    const irrelevantResultRef = await returnWorker(
      ledger,
      rootCallId,
      irrelevant,
      "Unrelated evidence was collected.",
    );

    const producer = await openWorker(
      ledger,
      rootCallId,
      "Collect the exact evidence required by the final artifact.",
    );
    store.commit(checkpoint(producer, "scope:producer", "required-source"));
    const producerResultRef = await returnWorker(
      ledger,
      rootCallId,
      producer,
      "The required evidence was collected.",
    );

    const intermediate = await openWorker(
      ledger,
      rootCallId,
      "Prepare the collected evidence for the final writer.",
      [producerResultRef],
    );
    const intermediateResultRef = await returnWorker(
      ledger,
      rootCallId,
      intermediate,
      "The evidence is ready for the final writer.",
    );

    const writer = await openWorker(
      ledger,
      rootCallId,
      "Write the final grounded artifact.",
      [intermediateResultRef],
    );
    const dependencyResults = projectSemanticCompactionDependencyResults({
      requestId: REQUEST_ID,
      prompt: PROMPT,
      head: ledger.current(),
      call: writer,
      consumer: WORKER_CAPABILITY_RAW_PAYLOAD_MODEL_STEP,
      store,
    });

    expect(dependencyResults).toEqual([
      expect.objectContaining({
        resultRef: intermediateResultRef,
        semanticCheckpoints: [
          expect.objectContaining({
            scopeId: "scope:producer",
            callId: producer.callId,
          }),
        ],
      }),
    ]);
    expect(JSON.stringify(dependencyResults)).not.toContain("scope:irrelevant");
    expect(JSON.stringify(dependencyResults)).not.toContain(
      irrelevantResultRef,
    );

    const payloadModel = vi.fn(
      async (request: WorkerCapabilityPayloadModelRequest) => {
        expect(request.modelStep).toBe(
          WORKER_CAPABILITY_RAW_PAYLOAD_MODEL_STEP,
        );
        expect(request.context.dependencyResults).toEqual(dependencyResults);
        return "grounded artifact body";
      },
    );
    const payloadAuthor = createWorkerCapabilityPayloadAuthor({
      requestId: REQUEST_ID,
      abortSignal: new AbortController().signal,
      model: { invoke: payloadModel },
    });
    const adapterExecute = vi.fn(async (input) => {
      await expect(
        payloadAuthor.author({
          call: input.call,
          executionId: input.executionId,
          descriptor: DESCRIPTOR,
          controls: input.controls,
          dependencyResults: input.dependencyResults,
          settledCapabilityResults: input.settledCapabilityResults,
          contract: {
            instructions: "Return the grounded artifact body.",
            minBytes: 1,
            maxBytes: 256,
          },
        }),
      ).resolves.toEqual({
        status: "authored",
        body: "grounded artifact body",
      });
      return Object.freeze({
        outcome: "succeeded" as const,
        observedEffect: "observation" as const,
        summary: "The grounded artifact body was authored.",
      });
    });
    const binding = createWorkerCapabilityBinding({
      requestId: REQUEST_ID,
      context: Object.freeze({}),
      call: writer,
      ledger,
      adapters: Object.freeze([
        Object.freeze({ descriptor: DESCRIPTOR, execute: adapterExecute }),
      ]),
      dependencyResults,
    });

    await expect(
      binding.execute({
        capabilityId: DESCRIPTOR.capabilityId,
        intent: "Author the final grounded artifact body.",
        controls: {},
      }),
    ).resolves.toEqual({ executionId: "capability-execution-1" });
    expect(adapterExecute).toHaveBeenCalledOnce();
    expect(payloadModel).toHaveBeenCalledOnce();
  });
});

function checkpoint(call: RoleCallFrame, scopeId: string, sourceRef: string) {
  const sourceFingerprint = createSemanticCompactionSha256Fingerprint(
    `${sourceRef}: exact source body`,
  );
  return Object.freeze({
    kind: "runtime_semantic_compaction_checkpoint_v2" as const,
    scopeId,
    requestId: REQUEST_ID,
    currentRequestFingerprint:
      createSemanticCompactionSha256Fingerprint(PROMPT),
    roleId: call.roleId,
    callId: call.callId,
    objectiveFingerprint: createSemanticCompactionSha256Fingerprint(
      call.objective!,
    ),
    contextLane: SEMANTIC_COMPACTION_CONTEXT_LANE,
    allowedConsumers: WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS,
    sourceRevision: 1,
    sourceDigests: Object.freeze([
      Object.freeze({
        sourceRef,
        sourceFingerprint,
        digest: `${sourceRef} task-relevant fact.`,
      }),
    ]),
    continuation: Object.freeze({
      completed: Object.freeze([`Compacted ${sourceRef}.`]),
      currentState: `${sourceRef} evidence is available.`,
      findings: Object.freeze([`${sourceRef} task-relevant fact.`]),
      evidenceRefs: Object.freeze([sourceRef]),
      artifacts: Object.freeze([]),
      decisions: Object.freeze([]),
      failedApproaches: Object.freeze([]),
      openWork: Object.freeze(["Create the final grounded artifact."]),
      blockers: Object.freeze([]),
      nextStep: "Continue through the canonical dependency result.",
    }),
  });
}

function createLedger(): RoleCallLedger {
  return createRoleCallLedger({
    requestId: REQUEST_ID,
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

async function openWorker(
  ledger: RoleCallLedger,
  callerCallId: string,
  objective: string,
  dependencyResultRefs: readonly string[] = [],
): Promise<RoleCallFrame> {
  const head = await commit(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId,
    roleId: "worker",
    objective,
    dependencyResultRefs,
  });
  const call = head.state.calls.find(
    (candidate) => candidate.callId === head.state.activeCallId,
  );
  if (!call) throw new Error("active worker missing");
  return call;
}

async function returnWorker(
  ledger: RoleCallLedger,
  callerCallId: string,
  worker: RoleCallFrame,
  summary: string,
): Promise<string> {
  const head = await commit(ledger, {
    authority: "runtime",
    type: "return_child",
    callerCallId,
    childCallId: worker.callId,
    outcome: "completed",
    summary,
  });
  const returned = head.state.calls.find(
    (candidate) => candidate.callId === worker.callId,
  );
  return requireId(returned?.resultRef ?? null);
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

function requireId(value: string | null): string {
  if (!value) throw new Error("required id missing");
  return value;
}
