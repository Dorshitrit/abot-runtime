import type { ToolRequestAttachment } from "../../../capabilities/tool-types.js";
import type {
  SessionActivation,
  SessionRequestLifecycleSnapshot,
} from "../../../sessions/request-lifecycle/contracts.js";
import type { RequestExecutionSeed } from "../contracts.js";
import type { RequestSteeringSnapshot } from "../request-steering.js";
import type { RequestPresentationSnapshot } from "../../streaming/request-callbacks.js";
import type { RequestExecutionBudgets } from "../../orchestration/lifecycle/execution-budgets.js";
import type { BoundApprovalDecision } from "../../orchestration/worker-capabilities/approval-contracts.js";
import type { captureRequestContextCompaction } from "../../context/semantic-compaction/snapshot.js";
import type { captureRequestSessionMemory } from "../../context/session-memory/snapshot.js";
import type { RequestToolResources } from "../../capabilities/request-tool-resources.js";
import type { RequestApprovalContinuation } from "../approval-continuation.js";
import { captureApprovalSnapshotData } from "./snapshot-data.js";

export const REQUEST_APPROVAL_SNAPSHOT = "request_approval_snapshot_v1";

/** Frozen data consumed by the existing request constructor; no service objects. */
export type PersistedRequestSeed = Pick<
  RequestExecutionSeed,
  | "requestId"
  | "sessionId"
  | "prompt"
  | "temporalContext"
  | "historyMessages"
  | "sessionArtifactPaths"
  | "shouldGenerateSessionTitle"
  | "runnerConfig"
  | "executionPolicySelection"
  | "attachments"
  | "agentMode"
  | "modelPreference"
  | "modelPolicy"
  | "toolPermissionMode"
  | "memoryRecallLimit"
>;

export type RequestApprovalSnapshot = Readonly<{
  kind: typeof REQUEST_APPROVAL_SNAPSHOT;
  originalPrompt: string;
  seed: PersistedRequestSeed;
  requestWorkingDirectory: string;
  toolAttachments: readonly ToolRequestAttachment[];
  runner: RequestApprovalContinuation;
  resources: ReturnType<RequestToolResources["snapshot"]>;
  compaction: ReturnType<typeof captureRequestContextCompaction>;
  sessionMemory?: ReturnType<typeof captureRequestSessionMemory>;
  presentation: RequestPresentationSnapshot;
  steering: RequestSteeringSnapshot;
  budgets: RequestExecutionBudgets;
}>;

/** Trusted owner input. Never deserialized from request.run client options. */
export type RequestApprovalExecution = Readonly<{
  activation: SessionActivation;
  resume?: Readonly<{
    snapshot: RequestApprovalSnapshot;
    current: SessionRequestLifecycleSnapshot;
    decisions: readonly BoundApprovalDecision[];
  }>;
}>;

export function snapshotRequestSeed(
  seed: RequestExecutionSeed,
): PersistedRequestSeed {
  return captureApprovalSnapshotData({
    requestId: seed.requestId,
    sessionId: seed.sessionId,
    prompt: seed.prompt,
    temporalContext: seed.temporalContext,
    historyMessages: seed.historyMessages,
    sessionArtifactPaths: seed.sessionArtifactPaths,
    shouldGenerateSessionTitle: seed.shouldGenerateSessionTitle,
    runnerConfig: seed.runnerConfig,
    executionPolicySelection: seed.executionPolicySelection,
    attachments: seed.attachments,
    agentMode: seed.agentMode,
    modelPreference: seed.modelPreference,
    modelPolicy: seed.modelPolicy,
    toolPermissionMode: seed.toolPermissionMode,
    memoryRecallLimit: seed.memoryRecallLimit,
  });
}
