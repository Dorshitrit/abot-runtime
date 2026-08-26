import type {
  SessionArtifactPath,
  SessionArtifactPathInput,
} from "../../sessions/types.js";
import {
  MAX_SESSION_ARTIFACT_PATHS,
  MAX_SESSION_ARTIFACT_PATH_TARGET_LENGTH,
} from "../../sessions/artifact-paths.js";
import { traceDebug } from "../observability/debug-logger.js";
import { classifyRuntimeErrorType } from "../observability/error-type.js";
import type { RoleCallLedgerHead } from "../orchestration/role-calls/index.js";

const LOG_SCOPE = "runtime.session_artifact_paths";

export type RequestArtifactPathPersistence = (
  inputs: readonly SessionArtifactPathInput[],
) => Promise<void>;

export function collectSettledSessionArtifactPathInputs(
  head: RoleCallLedgerHead,
): readonly SessionArtifactPathInput[] {
  const byTarget = new Map<string, SessionArtifactPathInput>();

  for (const execution of head.state.capabilityExecutions) {
    if (
      execution.status !== "settled" ||
      execution.outcome !== "succeeded" ||
      !execution.references
    ) {
      continue;
    }
    for (const reference of execution.references) {
      if (reference.kind !== "tool_target") {
        continue;
      }
      const input = Object.freeze({
        target: reference.target,
        sourceRequestId: head.state.requestId,
        sourceExecutionId: execution.executionId,
      });
      // Keep unique inputs ordered by their final successful occurrence so the
      // session store can refresh recency deterministically.
      byTarget.delete(reference.target);
      byTarget.set(reference.target, input);
    }
  }

  return Object.freeze([...byTarget.values()]);
}

export function snapshotSessionArtifactPathTargets(
  artifactPaths: readonly SessionArtifactPath[] | undefined,
): readonly string[] {
  if (!Array.isArray(artifactPaths) || artifactPaths.length === 0) {
    return Object.freeze([]);
  }
  const targets: string[] = [];
  const seen = new Set<string>();
  for (
    let index = artifactPaths.length - 1;
    index >= 0 && targets.length < MAX_SESSION_ARTIFACT_PATHS;
    index -= 1
  ) {
    const target = artifactPaths[index]?.target;
    if (
      typeof target !== "string" ||
      target.trim().length === 0 ||
      target.length > MAX_SESSION_ARTIFACT_PATH_TARGET_LENGTH ||
      seen.has(target)
    ) {
      continue;
    }
    seen.add(target);
    targets.push(target);
  }
  return Object.freeze(targets);
}

export async function persistSettledSessionArtifactPaths(params: {
  head: RoleCallLedgerHead;
  sessionId: string;
  trigger: "root_succeeded" | "root_failed";
  persistArtifactPaths?: RequestArtifactPathPersistence;
}): Promise<void> {
  const inputs = collectSettledSessionArtifactPathInputs(params.head);
  if (inputs.length === 0) {
    return;
  }

  const diagnostic = {
    requestId: params.head.state.requestId,
    sessionId: params.sessionId,
    trigger: params.trigger,
    pathCount: inputs.length,
    sourceExecutionCount: new Set(
      inputs.map(({ sourceExecutionId }) => sourceExecutionId),
    ).size,
  };
  if (!params.persistArtifactPaths) {
    traceDebug(LOG_SCOPE, "persistence.skipped", {
      ...diagnostic,
      reason: "store_method_unavailable",
    });
    return;
  }

  try {
    await params.persistArtifactPaths(inputs);
    traceDebug(LOG_SCOPE, "persistence.completed", diagnostic);
  } catch (error: unknown) {
    traceDebug(LOG_SCOPE, "persistence.failed", {
      ...diagnostic,
      errorType: classifyRuntimeErrorType(error),
    });
  }
}
