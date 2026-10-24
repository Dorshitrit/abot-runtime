import {
  createSemanticCompactionSha256Fingerprint as hash,
  type SemanticCompactionCheckpoint,
  type SemanticCompactionGenerationParams,
} from "../../context/semantic-compaction/index.js";
import {
  compactContinuation,
  semanticContractFixture,
} from "./semantic-compaction-contract-fixture.js";

export function inheritedCompactionFixture(
  options: Parameters<typeof semanticContractFixture>[0] = {},
) {
  const fixture = semanticContractFixture({
    ...options,
    policy: "execution-agent-v1",
  });
  const original = {
    sourceRef: "inherited-source",
    content: "The earlier observed interface remains canonical.",
    sourceFingerprint: hash("The earlier observed interface remains canonical."),
  };
  const digest = {
    sourceRef: original.sourceRef,
    sourceFingerprint: original.sourceFingerprint,
    digest: "The exact earlier interface fact.",
  };
  const previous: SemanticCompactionCheckpoint = {
    kind: "runtime_semantic_compaction_checkpoint_v2",
    ...fixture.params.binding,
    scopeId: fixture.params.scopeId,
    sourceRevision: 1,
    sourceDigests: [digest],
    continuation: compactContinuation({
      openWork: ["OLD_OBJECTIVE_PENDING_ACTION"],
      nextStep: "OLD_OBJECTIVE_NEXT_ACTION",
    }),
  };
  fixture.store.registerSources([original]);
  fixture.store.commit(previous);
  const preservationObjective = fixture.params.preservationObjective + "\nUse the new objective.";
  const params: SemanticCompactionGenerationParams = {
    ...fixture.params,
    scopeId: fixture.params.scopeId + ":new-objective",
    sourceRevision: 2,
    preservationObjective,
    binding: {
      ...fixture.params.binding,
      objectiveFingerprint: hash(preservationObjective),
    },
    inheritedSourceDigests: previous.sourceDigests,
  };
  return { ...fixture, params, original, digest, previous };
}
