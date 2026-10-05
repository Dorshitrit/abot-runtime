import { randomUUID } from "node:crypto";
import type {
  AutomationInputRecord,
  AutomationJournalState,
} from "./storage-records.js";
import type { CapturedSourceFile, DiscoveredSourceFile } from "./source-discovery.js";
import { requireObservedInputCapacity } from "./input-capacity.js";
export { MAX_INPUT_SNAPSHOT_BYTES } from "./input-capacity.js";

export function recordsForSource(
  state: AutomationJournalState,
  automationId: string,
  sourceId: string,
): AutomationInputRecord[] {
  return state.inputs.filter((record) =>
    record.automationId === automationId && record.sourceId === sourceId);
}

export function hasSourceBaseline(
  records: readonly AutomationInputRecord[],
  root: string,
): boolean {
  return records.some((record) =>
    record.baselineMarker === true && record.canonicalPath === root);
}

export function cachedContentVersion(
  file: DiscoveredSourceFile,
  records: readonly AutomationInputRecord[],
): string | undefined {
  const cached = records.find((record) =>
    !record.baselineMarker && record.canonicalPath === file.canonicalPath &&
    record.observedSizeBytes === file.sizeBytes &&
    record.observedMtimeMs === file.mtimeMs &&
    record.observedCtimeMs === file.ctimeMs);
  return cached?.contentVersion;
}

export function findSourceVersion(
  records: readonly AutomationInputRecord[],
  canonicalPath: string,
  contentVersion: string,
): AutomationInputRecord | undefined {
  return records.find((record) =>
    !record.baselineMarker && record.canonicalPath === canonicalPath &&
    record.contentVersion === contentVersion);
}

export function sourceBaselineMarker(input: {
  automationId: string;
  sourceId: string;
  root: string;
  observedAt: string;
  excludedInputIds?: readonly string[];
}): AutomationInputRecord {
  return {
    id: randomUUID(),
    automationId: input.automationId,
    sourceId: input.sourceId,
    canonicalPath: input.root,
    contentVersion: "source-baseline-marker-v1",
    observedAt: input.observedAt,
    eligibility: "baseline",
    baselineMarker: true,
    ...(input.excludedInputIds?.length ? { excludedInputIds: input.excludedInputIds } : {}),
  };
}

export function isReusableSourceInput(
  record: AutomationInputRecord,
  records: readonly AutomationInputRecord[],
  root: string,
): boolean {
  if (record.eligibility !== "eligible") return false;
  if (record.claimRunId) return false;
  if (record.outcomeRef) return false;
  if (!record.snapshot) return false;
  const baseline = records.find((candidate) =>
    candidate.baselineMarker === true && candidate.canonicalPath === root);
  return !baseline?.excludedInputIds?.includes(record.id);
}

function observedMetadata(file: DiscoveredSourceFile) {
  return {
    observedSizeBytes: file.sizeBytes,
    observedMtimeMs: file.mtimeMs,
    observedCtimeMs: file.ctimeMs,
  };
}

export function baselineFileRecord(input: {
  automationId: string;
  sourceId: string;
  file: CapturedSourceFile;
  observedAt: string;
}): AutomationInputRecord {
  return {
    id: randomUUID(),
    automationId: input.automationId,
    sourceId: input.sourceId,
    canonicalPath: input.file.canonicalPath,
    contentVersion: input.file.contentVersion,
    observedAt: input.observedAt,
    eligibility: "baseline",
    ...observedMetadata(input.file),
  };
}

export function eligibleFileRecord(input: {
  id?: string;
  automationId: string;
  sourceId: string;
  file: CapturedSourceFile;
  observedAt: string;
  attachment: NonNullable<AutomationInputRecord["snapshot"]>["attachment"];
}): AutomationInputRecord {
  return {
    id: input.id ?? randomUUID(),
    automationId: input.automationId,
    sourceId: input.sourceId,
    canonicalPath: input.file.canonicalPath,
    contentVersion: input.file.contentVersion,
    observedAt: input.observedAt,
    eligibility: "eligible",
    ...observedMetadata(input.file),
    snapshot: {
      attachment: input.attachment,
      contentVersion: input.file.contentVersion,
      sizeBytes: input.file.sizeBytes,
    },
  };
}

export type ObservationRefresh = Readonly<{
  recordId: string;
  file: DiscoveredSourceFile;
  observedAt: string;
}>;

export function commitInputObservation(input: {
  state: AutomationJournalState;
  marker?: AutomationInputRecord;
  baselineFiles?: readonly AutomationInputRecord[];
  newFiles?: readonly AutomationInputRecord[];
  selectedExistingIds?: readonly string[];
  refresh?: readonly ObservationRefresh[];
  runId?: string;
}): void {
  const additions = [
    ...(input.marker ? [input.marker] : []),
    ...(input.baselineFiles ?? []),
    ...(input.newFiles ?? []),
  ];
  for (const candidate of additions) {
    if (input.state.inputs.some((record) =>
      record.automationId === candidate.automationId &&
      record.sourceId === candidate.sourceId &&
      record.baselineMarker === candidate.baselineMarker &&
      record.canonicalPath === candidate.canonicalPath &&
      record.contentVersion === candidate.contentVersion))
      throw new Error("automation_source_changed");
  }
  for (const id of input.selectedExistingIds ?? []) {
    const existing = input.state.inputs.find((record) => record.id === id);
    if (!existing || existing.eligibility !== "eligible" ||
        existing.claimRunId || existing.outcomeRef || !existing.snapshot)
      throw new Error("automation_source_changed");
  }
  if (input.runId) {
    for (const record of input.newFiles ?? []) {
      input.state.inputs.push({ ...record, claimRunId: input.runId });
    }
    for (const id of input.selectedExistingIds ?? []) {
      replaceInput(input.state, id, (record) => ({ ...record, claimRunId: input.runId }));
    }
  } else {
    input.state.inputs.push(...(input.newFiles ?? []));
  }
  input.state.inputs.push(...(input.marker ? [input.marker] : []));
  input.state.inputs.push(...(input.baselineFiles ?? []));
  for (const update of input.refresh ?? []) {
    replaceInput(input.state, update.recordId, (record) => ({
      ...record,
      observedAt: update.observedAt,
      ...observedMetadata(update.file),
    }));
  }
  requireObservedInputCapacity(input.state.inputs, new Set([
    ...additions.map((record) => record.id),
    ...(input.selectedExistingIds ?? []),
    ...(input.refresh ?? []).map((record) => record.recordId),
  ]));
}

function replaceInput(
  state: AutomationJournalState,
  id: string,
  update: (record: AutomationInputRecord) => AutomationInputRecord,
): void {
  const index = state.inputs.findIndex((record) => record.id === id);
  if (index < 0) throw new Error("automation_source_changed");
  state.inputs[index] = update(state.inputs[index]!);
}

export function releaseNeverDispatchedInputs(
  state: AutomationJournalState,
  runId: string,
): void {
  for (const record of state.inputs.filter((item) => item.claimRunId === runId)) {
    if (record.outcomeRef) continue;
    replaceInput(state, record.id, ({ claimRunId: _claim, ...rest }) => rest);
  }
}

export function holdInterruptedInputs(
  state: AutomationJournalState,
  runId: string,
): void {
  for (const record of state.inputs.filter((item) => item.claimRunId === runId)) {
    if (record.outcomeRef) continue;
    replaceInput(state, record.id, (existing) => ({ ...existing, eligibility: "held" }));
  }
}
