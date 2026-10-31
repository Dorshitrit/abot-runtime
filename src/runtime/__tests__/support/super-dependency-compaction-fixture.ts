import {
  createRequestContextCompactionStore,
  createSemanticCompactionSha256Fingerprint as hash,
  type SemanticCompactionCheckpoint,
  type SemanticCompactionSource,
} from "../../context/semantic-compaction/index.js";
import { projectSelectedDependencyObservations } from "../../context/super-dependency-observation-lineage.js";
import { createCapabilityResultCompactionSource } from "../../context/capability-result-compaction-source.js";
import { WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS } from "../../orchestration/worker-capabilities/index.js";
import { dependencyObservationFixture } from "./super-dependency-observation-fixture.js";

type Fixture = Awaited<ReturnType<typeof dependencyObservationFixture>>;

export function createDependencyCheckpoints(
  fixture: Fixture,
  options: { sources?: readonly SemanticCompactionSource[]; consumerOwned?: boolean } = {},
) {
  const sources = options.sources ?? projectSelectedDependencyObservations(fixture.head, fixture.call)
    .map(createCapabilityResultCompactionSource);
  const byCall = new Map<string, SemanticCompactionSource[]>();
  for (const source of sources) {
    const callId: string = options.consumerOwned ? fixture.call.callId : JSON.parse(source.content).callId;
    const group = byCall.get(callId) ?? [];
    group.push(source);
    byCall.set(callId, group);
  }
  const store = createRequestContextCompactionStore();
  store.registerSources(sources);
  const checkpoints: SemanticCompactionCheckpoint[] = [];
  for (const [callId, group] of byCall) {
    const call = fixture.head.state.calls.find(item => item.callId === callId)!;
    if (call.roleId !== "worker" || !call.objective) throw new Error("expected_worker_checkpoint_owner");
    const checkpoint: SemanticCompactionCheckpoint = {
      kind: "runtime_semantic_compaction_checkpoint_v2",
      requestId: fixture.requestId, currentRequestFingerprint: hash(fixture.prompt),
      roleId: "worker", callId, objectiveFingerprint: hash(call.objective),
      contextLane: "role_continuation", scopeId: `worker:${callId}:request-tool-results`,
      sourceRevision: fixture.head.revision,
      allowedConsumers: WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS,
      sourceDigests: group.map(source => ({
        sourceRef: source.sourceRef, sourceFingerprint: source.sourceFingerprint,
        digest: "PRESERVED_DEPENDENCY_DIGEST_" + source.sourceRef,
      })),
      continuation: {
        completed: ["The assigned observation settled."],
        currentState: "Source details are retained by the bound digests.",
        findings: [], evidenceRefs: group.map(source => source.sourceRef),
        artifacts: [], decisions: [], failedApproaches: [], openWork: [],
        blockers: [], nextStep: "Use the selected source evidence.",
      },
    };
    store.commit(checkpoint);
    checkpoints.push(checkpoint);
  }
  return { store, sources, checkpoints };
}
