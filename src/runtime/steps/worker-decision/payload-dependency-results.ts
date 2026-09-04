import type { SemanticCompactionDependencyResult } from "../../context/semantic-compaction/dependency-results.js";

export type WorkerPayloadDependencyResult = Readonly<
  Pick<
    SemanticCompactionDependencyResult,
    | "resultRef"
    | "producerCallId"
    | "roleId"
    | "outcome"
    | "summary"
    | "semanticCheckpoints"
  >
>;

export type WorkerPayloadDependencyInput = Readonly<{
  dependencyResults?: readonly WorkerPayloadDependencyResult[];
}>;

/** Keeps role lineage out of the raw capability-payload authoring boundary. */
export function projectWorkerPayloadDependencyResults(
  dependencyResults: readonly SemanticCompactionDependencyResult[],
): readonly WorkerPayloadDependencyResult[] {
  return Object.freeze(
    dependencyResults.map((result) =>
      Object.freeze({
        resultRef: result.resultRef,
        producerCallId: result.producerCallId,
        roleId: result.roleId,
        outcome: result.outcome,
        summary: result.summary,
        ...(result.semanticCheckpoints
          ? { semanticCheckpoints: result.semanticCheckpoints }
          : {}),
      }),
    ),
  );
}

export function projectWorkerPayloadDependencyInput(
  dependencyResults: readonly SemanticCompactionDependencyResult[],
): WorkerPayloadDependencyInput {
  const projected = projectWorkerPayloadDependencyResults(dependencyResults);
  return projected.length > 0
    ? Object.freeze({ dependencyResults: projected })
    : Object.freeze({});
}
