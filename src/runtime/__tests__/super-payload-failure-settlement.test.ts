import { expect, test, vi } from "vitest";
import { createSuperCompactionSourceFixture } from "./support/super-compaction-source.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";
import { readSuperWorkerCompactionSidecar } from "../context/super-worker-compaction-sidecar.js";
import {
  createSemanticCompactionSha256Fingerprint as hash,
  SEMANTIC_COMPACTION_CONTEXT_LANE,
} from "../context/semantic-compaction/contracts.js";
import { CompactionSourceInvariantError } from "../context/compaction-source-invariant.js";
import { WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS } from "../orchestration/worker-capabilities/payload-contracts.js";
import { createRequestWorkerCapabilityPayloadAuthor } from "../request/worker-capability-payload.js";
import { containSuperContextFailures } from "../request/super-context-failure-executor.js";
import {
  createRoleExecutorRegistry,
  type RoleExecutorInput,
} from "../orchestration/role-executors/index.js";
import { executeBoundWorkerCapability } from "../orchestration/worker-capabilities/execution.js";
import { projectWorkerCapabilityScope } from "../orchestration/worker-capabilities/scope.js";
import type { WorkerCapabilityAdapter } from "../orchestration/worker-capabilities/contracts.js";
import type { RequestExecutionScope } from "../request/execution-scope.js";

type Fault =
  | "bad_checkpoint"
  | "missing_source"
  | "healthy_candidate_rejection";

async function payloadSettlement(fault: Fault) {
  const fixture = await createSuperCompactionSourceFixture();
  const { ledger, head, call, view, payloadInput, invoke } = fixture;
  const base = fixture.request.contextCompactionStore!;
  const sources = readSuperWorkerCompactionSidecar(view)!.sources;
  base.registerSourcesAtomically!(sources);
  const checkpoint = {
    kind: "runtime_semantic_compaction_checkpoint_v2" as const,
    scopeId: `worker:${call.callId}:request-tool-results`,
    requestId: fixture.request.requestId,
    currentRequestFingerprint: hash(fixture.request.prompt),
    roleId: "worker",
    callId: call.callId,
    objectiveFingerprint: hash(call.objective!),
    contextLane: SEMANTIC_COMPACTION_CONTEXT_LANE,
    allowedConsumers: WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS,
    sourceRevision: head.revision,
    sourceDigests: sources.map((source) => ({
      sourceRef: source.sourceRef,
      sourceFingerprint: source.sourceFingerprint,
      digest: "Catalog evidence preserved.",
    })),
    continuation: {
      completed: ["Catalog read"],
      currentState: "Catalog ready.",
      findings: ["Catalog evidence preserved."],
      evidenceRefs: sources.map((source) => source.sourceRef),
      artifacts: [],
      decisions: [],
      failedApproaches: [],
      openWork: ["Write a draft."],
      blockers: [],
      nextStep: "Author the draft.",
    },
  };
  base.commit(checkpoint);
  let sourceMissing = false;
  let rejectOnce = false;
  const store = {
    ...base,
    materializeSource: (ref: string, fingerprint: string) =>
      sourceMissing ? undefined : base.materializeSource(ref, fingerprint),
    get: (scope: string) => {
      if (rejectOnce) {
        rejectOnce = false;
        throw new CompactionSourceInvariantError(
          "context_compaction_source_identity_conflict",
          sources[0]!.sourceRef,
        );
      }
      return base.get(scope);
    },
  };
  const request = deriveTestRequestExecutionScope(fixture.request, {
    contextCompactionStore: store,
  });
  const author = createRequestWorkerCapabilityPayloadAuthor(request);
  const authored = vi.fn();
  const adapter: WorkerCapabilityAdapter<RequestExecutionScope> = {
    descriptor: payloadInput.descriptor,
    async execute(input) {
      // The accepted execution is already canonical; the decorator's original
      // head cannot return a child while this capability is still unsettled.
      expect(ledger.current().revision).toBeGreaterThan(head.revision);
      expect(ledger.current().state.capabilityExecutions.at(-1)?.status).toBe(
        "running",
      );
      if (fault === "healthy_candidate_rejection") rejectOnce = true;
      else base.commit({ ...checkpoint, sourceRevision: head.revision + 100 });
      if (fault === "missing_source") sourceMissing = true;
      const result = await author.author({
        ...payloadInput,
        call: input.call,
        executionId: input.executionId,
        assignmentProvenance: input.assignmentProvenance,
        settledCapabilityResults: input.settledCapabilityResults,
      });
      authored(result);
      expect(result.status).toBe("failed");
      return {
        outcome: "failed",
        observedEffect: "none",
        summary: "Payload authoring did not complete.",
        failureOutcomeFingerprint: null,
      };
    },
  };
  const execute = vi.fn(
    async (input: RoleExecutorInput<RequestExecutionScope>) => {
      if (input.continuation)
        return {
          kind: "terminal" as const,
          outcome: "failed" as const,
          summary:
            "The normal Worker continuation consumed the failed capability.",
        };
      const attempt = await executeBoundWorkerCapability({
        context: request,
        call: input.call,
        currentHead: input.ledger.current(),
        ledger,
        adapter,
        intent: "Write a draft.",
        authoringObjective: "Write the draft.",
        controls: {},
        capabilityScope: projectWorkerCapabilityScope({
          entries: [adapter],
          descriptorOf: (entry) => entry.descriptor,
        }),
        diagnostic: {
          requestId: request.requestId,
          call: input.call,
          capabilityIds: [adapter.descriptor.capabilityId],
          scopeMode: "full",
          scopeCatalogGroupIds: [],
          knownCatalogGroupCount: 0,
          fullCapabilityCount: 1,
          filteredCapabilityCount: 1,
        },
      });
      if (!("executionId" in attempt))
        throw new Error("fixture_execution_expected");
      return {
        kind: "continue" as const,
        continuation: {
          kind: "capability_execution" as const,
          executionId: attempt.executionId,
        },
      };
    },
  );
  const registry = createRoleExecutorRegistry([
    containSuperContextFailures(
      { roleId: "worker", execute },
      "delegated.worker",
    ),
  ]);
  const outcome = await registry
    .execute({ requestId: request.requestId, context: request, ledger, call })
    .catch((error: unknown) => error);
  return {
    outcome,
    execute,
    authored,
    ledger,
    invoke,
    store,
    sources,
    checkpoint,
    base,
  };
}

test("F2 payload checkpoint failure settles once then the fresh activation rejects its quarantined scope before inference", async () => {
  const result = await payloadSettlement("bad_checkpoint");
  expect(result.authored).toHaveBeenCalledOnce();
  expect(result.execute).toHaveBeenCalledOnce();
  expect(result.invoke).not.toHaveBeenCalled();
  expect(result.outcome).toMatchObject({
    kind: "terminal",
    outcome: "failed",
    summary: expect.stringContaining("context_compaction_scope_invalidated"),
  });
  expect(result.ledger.current().state.capabilityExecutions).toHaveLength(2);
  expect(
    result.ledger.current().state.capabilityExecutions.at(-1),
  ).toMatchObject({ status: "settled", outcome: "failed" });
  expect(result.store.snapshot!().sources).toEqual(result.sources);
  expect(result.store.snapshot!().invalidatedScopes).toMatchObject([
    {
      scopeId: result.checkpoint.scopeId,
      failureCode: "context_compaction_checkpoint_revision_invalid",
    },
  ]);
});

test("F2 a healthy rejected payload projection preserves the checkpoint and ordinary settled-failure continuation", async () => {
  const result = await payloadSettlement("healthy_candidate_rejection");
  expect(result.authored).toHaveBeenCalledOnce();
  expect(result.execute).toHaveBeenCalledTimes(2);
  expect(result.invoke).not.toHaveBeenCalled();
  expect(result.outcome).toMatchObject({
    kind: "terminal",
    outcome: "failed",
    summary: "The normal Worker continuation consumed the failed capability.",
  });
  expect(result.store.get(result.checkpoint.scopeId)).toEqual(
    result.checkpoint,
  );
  expect(result.store.snapshot!()).not.toHaveProperty("invalidatedScopes");
  expect(result.ledger.current().state.capabilityExecutions).toHaveLength(2);
});

test("R5 missing canonical materialization during payload cannot be hidden by checkpoint quarantine or another inference", async () => {
  const result = await payloadSettlement("missing_source");
  expect(result.authored).toHaveBeenCalledOnce();
  expect(result.execute).toHaveBeenCalledOnce();
  expect(result.invoke).not.toHaveBeenCalled();
  expect(result.outcome).toBeInstanceOf(Error);
  expect((result.outcome as Error).message).toBe(
    "context_compaction_source_materialization_missing",
  );
  expect(result.store.snapshot!()).not.toHaveProperty("invalidatedScopes");
  expect(result.ledger.current().state.capabilityExecutions).toHaveLength(2);
  expect(
    result.ledger.current().state.capabilityExecutions.at(-1),
  ).toMatchObject({ status: "settled", outcome: "failed" });
  expect(result.ledger.current().state.results).toEqual([]);
});
