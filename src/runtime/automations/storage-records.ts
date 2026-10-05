import type { RuntimeAttachmentReference } from "../../shared/attachments.js";
import type { SchedulerToolPermissionMode } from "../scheduler/tool-permission-mode.js";
import type {
  AgentNode,
  AutomationRevision,
  OperationRef,
} from "./definition-contracts.js";

export type AutomationDraftRecord = Readonly<{
  id: string;
  automationId: string;
  revision: number;
  definition: AutomationRevision;
  updatedAt: string;
  archivedAt?: string;
  storageRevision?: number;
}>;

export type AutomationDefinitionRecord = Readonly<{
  id: string;
  automationId: string;
  revision: number;
  definition: AutomationRevision;
  publishedAt: string;
  /** Hash of selected tool contracts and applicable model configuration. */
  dependencyFingerprint?: string;
}>;

export type AutomationSavedAgentRecord = Readonly<{
  id: string;
  agentId: string;
  revision: number;
  agent: AgentNode;
  updatedAt: string;
}>;

export type AutomationGrantRecord = Readonly<{
  id: string;
  automationId: string;
  environmentId: string;
  grantRevision: number;
  mode: SchedulerToolPermissionMode;
  operations: readonly OperationRef[];
  evidence: Readonly<{
    kind: "authenticated_user_action";
    actionId: string;
    at: string;
  }>;
}>;

export type AutomationInputRecord = Readonly<{
  id: string;
  automationId: string;
  sourceId: string;
  canonicalPath: string;
  contentVersion: string;
  observedAt: string;
  observedSizeBytes?: number;
  observedMtimeMs?: number;
  observedCtimeMs?: number;
  eligibility: "baseline" | "eligible" | "held";
  /** One marker per source records that first activation was scanned, even if empty. */
  baselineMarker?: true;
  /** Existing retained versions excluded when this canonical root was first scanned. */
  excludedInputIds?: readonly string[];
  snapshot?: Readonly<{
    attachment: RuntimeAttachmentReference;
    contentVersion: string;
    sizeBytes: number;
  }>;
  /** Durable cleanup marker; snapshot bytes are deleted before clearing this field. */
  snapshotRetiredAt?: string;
  claimRunId?: string;
  outcomeRef?: string;
}>;

export type AutomationNodeStateRecord = Readonly<{
  nodeId: string;
  status:
    | "pending"
    | "ready"
    | "running"
    | "succeeded"
    | "skipped"
    | "failed"
    | "cancelled"
    | "interrupted";
  attemptId?: string;
  resultRef?: string;
  errorCode?: string;
}>;

export type AutomationExecutionRecord = Readonly<{
  id: string; // The scheduler Run ID; root status lives only on that Run.
  automationId: string;
  definitionRevision: number;
  revision: number;
  inputIds: readonly string[];
  nodes: readonly AutomationNodeStateRecord[];
  /** Counts every admitted model invocation, including failed calls. */
  modelCalls?: number;
  stopRequestedAt?: string;
  reportRef?: string;
  terminalAt?: string;
  detailsExpiredAt?: string;
  reportExpiredAt?: string;
}>;

export type AutomationAttemptRecord = Readonly<{
  id: string;
  runId: string;
  nodeId: string;
  invocationId: string;
  fingerprint: string;
  state: "started" | "settled" | "uncertain";
  startedAt: string;
  settledAt?: string;
  settlementRef?: string;
  /** Versioned evidence received after the original attempt became uncertain. */
  lateSettlement?: Readonly<{
    revision: number;
    observedAt: string;
    status: "succeeded" | "failed" | "rejected";
    errorCode?: string;
  }>;
}>;

export type AutomationResultRecord = Readonly<{
  id: string;
  runId: string;
  nodeId?: string;
  kind: "node_output" | "effect_receipt" | "report" | "artifact";
  storageRef: string;
  digest: string;
  sizeBytes: number;
  createdAt: string;
}>;

export type AutomationJournalState = {
  schemaVersion: 1;
  drafts: AutomationDraftRecord[];
  definitions: AutomationDefinitionRecord[];
  savedAgents: AutomationSavedAgentRecord[];
  grants: AutomationGrantRecord[];
  inputs: AutomationInputRecord[];
  executions: AutomationExecutionRecord[];
  attempts: AutomationAttemptRecord[];
  results: AutomationResultRecord[];
};

export type AutomationCollection = Exclude<
  keyof AutomationJournalState,
  "schemaVersion"
>;
export type AutomationStoredRecord =
  | AutomationDraftRecord
  | AutomationDefinitionRecord
  | AutomationSavedAgentRecord
  | AutomationGrantRecord
  | AutomationInputRecord
  | AutomationExecutionRecord
  | AutomationAttemptRecord
  | AutomationResultRecord;

export const AUTOMATION_COLLECTIONS = Object.freeze([
  "drafts",
  "definitions",
  "savedAgents",
  "grants",
  "inputs",
  "executions",
  "attempts",
  "results",
] as const satisfies readonly AutomationCollection[]);

export function emptyAutomationJournalState(): AutomationJournalState {
  return {
    schemaVersion: 1,
    drafts: [],
    definitions: [],
    savedAgents: [],
    grants: [],
    inputs: [],
    executions: [],
    attempts: [],
    results: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}
function isCanonicalPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= 4_096 && !value.includes("\0");
}

function hasValidBaselineExclusions(value: Record<string, unknown>): boolean {
  const excluded = value.excludedInputIds;
  if (excluded === undefined) return true;
  if (value.baselineMarker !== true) return false;
  if (!Array.isArray(excluded)) return false;
  if (!excluded.every(isIdentifier)) return false;
  return new Set(excluded).size === excluded.length;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function isOptionalNonnegativeNumber(value: unknown): boolean {
  return value === undefined ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function isInstant(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isOptionalIdentifier(value: unknown): boolean {
  return value === undefined || isIdentifier(value);
}

function isOptionalInstant(value: unknown): boolean {
  return value === undefined || isInstant(value);
}

function isOperationRef(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isIdentifier(value.toolName) || !isIdentifier(value.operationId))
    return false;
  return isPositiveInteger(value.contractVersion);
}

function isAttachmentReference(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isIdentifier(value.id) || !isIdentifier(value.storageRef)) return false;
  if (!isIdentifier(value.mimeType)) return false;
  if (value.kind !== "file" && value.kind !== "image") return false;
  if (value.name !== undefined && typeof value.name !== "string") return false;
  return value.size === undefined || isNonnegativeInteger(value.size);
}

function isNodeState(value: unknown): boolean {
  if (!isRecord(value) || !isIdentifier(value.nodeId)) return false;
  if (
    ![
      "pending",
      "ready",
      "running",
      "succeeded",
      "skipped",
      "failed",
      "cancelled",
      "interrupted",
    ].includes(String(value.status))
  )
    return false;
  return (
    isOptionalIdentifier(value.attemptId) &&
    isOptionalIdentifier(value.resultRef) &&
    isOptionalIdentifier(value.errorCode)
  );
}

function hasValidRecordEnvelope(
  value: unknown,
): value is Record<string, unknown> {
  return isRecord(value) && isIdentifier(value.id);
}

export function parseAutomationStoredRecord(
  collection: AutomationCollection,
  value: unknown,
): AutomationStoredRecord {
  if (!hasValidRecordEnvelope(value))
    throw new Error("scheduler_store_corrupt");
  switch (collection) {
    case "drafts":
    case "definitions": {
      const definition = value.definition;
      if (
        !isIdentifier(value.automationId) ||
        !isPositiveInteger(value.revision)
      )
        break;
      if (!isRecord(definition) || definition.schemaVersion !== 1) break;
      if (definition.automationId !== value.automationId) break;
      if (definition.revision !== value.revision) break;
      const timestamp =
        collection === "drafts" ? value.updatedAt : value.publishedAt;
      if (!isInstant(timestamp)) break;
      if (collection === "drafts") {
        if (!isOptionalInstant(value.archivedAt)) break;
        if (value.storageRevision !== undefined &&
            (!isPositiveInteger(value.storageRevision) || value.storageRevision < value.revision))
          break;
      }
      if (collection === "definitions" && value.dependencyFingerprint !== undefined &&
          !isIdentifier(value.dependencyFingerprint)) break;
      return value as AutomationStoredRecord;
    }
    case "savedAgents":
      if (!isIdentifier(value.agentId) || !isPositiveInteger(value.revision))
        break;
      if (!isRecord(value.agent) || value.agent.kind !== "agent") break;
      if (!isInstant(value.updatedAt)) break;
      return value as AutomationStoredRecord;
    case "grants": {
      if (
        !isIdentifier(value.automationId) ||
        !isIdentifier(value.environmentId)
      )
        break;
      if (!isPositiveInteger(value.grantRevision)) break;
      if (value.mode !== "full_access" && value.mode !== "full_plus") break;
      if (
        !Array.isArray(value.operations) ||
        !value.operations.every(isOperationRef)
      )
        break;
      if (
        !isRecord(value.evidence) ||
        value.evidence.kind !== "authenticated_user_action"
      )
        break;
      if (
        !isIdentifier(value.evidence.actionId) ||
        !isInstant(value.evidence.at)
      )
        break;
      return value as AutomationStoredRecord;
    }
    case "inputs": {
      if (!isIdentifier(value.automationId) || !isIdentifier(value.sourceId))
        break;
      if (
        !isCanonicalPath(value.canonicalPath) ||
        !isIdentifier(value.contentVersion)
      )
        break;
      if (!isInstant(value.observedAt)) break;
      if (!isOptionalNonnegativeNumber(value.observedSizeBytes) ||
          !isOptionalNonnegativeNumber(value.observedMtimeMs) ||
          !isOptionalNonnegativeNumber(value.observedCtimeMs)) break;
      if (!["baseline", "eligible", "held"].includes(String(value.eligibility))) break;
      if (value.baselineMarker !== undefined && value.baselineMarker !== true) break;
      if (value.baselineMarker && value.eligibility !== "baseline") break;
      if (!hasValidBaselineExclusions(value)) break;
      if (value.eligibility === "baseline") {
        if (value.snapshot !== undefined || value.claimRunId !== undefined ||
            value.outcomeRef !== undefined) break;
      } else {
        if (value.snapshot === undefined) {
          // Keep consumed-version dedup metadata after runtime-owned bytes expire.
          if (!isIdentifier(value.claimRunId) || !isIdentifier(value.outcomeRef)) break;
        } else {
          if (!isRecord(value.snapshot)) break;
          if (!isAttachmentReference(value.snapshot.attachment)) break;
          if (value.snapshot.contentVersion !== value.contentVersion) break;
          if (!isNonnegativeInteger(value.snapshot.sizeBytes)) break;
        }
      }
      if (
        !isOptionalIdentifier(value.claimRunId) ||
        !isOptionalIdentifier(value.outcomeRef) ||
        !isOptionalInstant(value.snapshotRetiredAt) ||
        (value.snapshotRetiredAt !== undefined && value.snapshot === undefined)
      )
        break;
      return value as AutomationStoredRecord;
    }
    case "executions":
      if (
        !isIdentifier(value.automationId) ||
        !isPositiveInteger(value.definitionRevision)
      )
        break;
      if (!isPositiveInteger(value.revision)) break;
      if (!Array.isArray(value.inputIds) || !value.inputIds.every(isIdentifier))
        break;
      if (!Array.isArray(value.nodes) || !value.nodes.every(isNodeState)) break;
      if (value.modelCalls !== undefined && !isNonnegativeInteger(value.modelCalls))
        break;
      if (
        !isOptionalInstant(value.stopRequestedAt) ||
        !isOptionalIdentifier(value.reportRef) ||
        !isOptionalInstant(value.terminalAt) ||
        !isOptionalInstant(value.detailsExpiredAt) ||
        !isOptionalInstant(value.reportExpiredAt)
      )
        break;
      return value as AutomationStoredRecord;
    case "attempts":
      if (!isIdentifier(value.runId) || !isIdentifier(value.nodeId)) break;
      if (!isIdentifier(value.invocationId) || !isIdentifier(value.fingerprint))
        break;
      if (!["started", "settled", "uncertain"].includes(String(value.state)))
        break;
      if (!isInstant(value.startedAt) || !isOptionalInstant(value.settledAt))
        break;
      if (!isOptionalIdentifier(value.settlementRef)) break;
      if (value.lateSettlement !== undefined) {
        if (!isRecord(value.lateSettlement) || value.state !== "uncertain") break;
        if (!isPositiveInteger(value.lateSettlement.revision) ||
            !isInstant(value.lateSettlement.observedAt)) break;
        if (!["succeeded", "failed", "rejected"].includes(String(value.lateSettlement.status))) break;
        if (!isOptionalIdentifier(value.lateSettlement.errorCode)) break;
      }
      return value as AutomationStoredRecord;
    case "results":
      if (!isIdentifier(value.runId) || !isOptionalIdentifier(value.nodeId))
        break;
      if (
        !["node_output", "effect_receipt", "report", "artifact"].includes(
          String(value.kind),
        )
      )
        break;
      if (!isIdentifier(value.storageRef) || !isIdentifier(value.digest)) break;
      if (!isNonnegativeInteger(value.sizeBytes) || !isInstant(value.createdAt))
        break;
      return value as AutomationStoredRecord;
  }
  throw new Error("scheduler_store_corrupt");
}

export function parseAutomationJournalState(
  value: unknown,
): AutomationJournalState {
  if (!isRecord(value) || value.schemaVersion !== 1)
    throw new Error("scheduler_store_corrupt");
  const state = emptyAutomationJournalState();
  for (const collection of AUTOMATION_COLLECTIONS) {
    const records = value[collection];
    if (!Array.isArray(records)) throw new Error("scheduler_store_corrupt");
    const ids = new Set<string>();
    for (const record of records) {
      const parsed = parseAutomationStoredRecord(collection, record);
      if (ids.has(parsed.id)) throw new Error("scheduler_store_corrupt");
      ids.add(parsed.id);
      (state[collection] as AutomationStoredRecord[]).push(parsed);
    }
  }
  return state;
}
