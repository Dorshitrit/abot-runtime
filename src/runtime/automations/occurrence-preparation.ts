import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { RuntimeAttachmentStore } from "../attachments/store.js";
import type { RuntimeConfig } from "../ports.js";
import type {
  PreparedAutomationOccurrence,
  SchedulerAutomationExecutor,
  SchedulerAutomationJob,
} from "../scheduler/contracts.js";
import type { AutomationRevision, FolderSource } from "./definition-contracts.js";
import { selectAutomationInputBatch } from "./input-batch-selection.js";
import { createAutomationSnapshotStaging, type AutomationSnapshotStaging } from "./snapshot-staging.js";
import {
  baselineFileRecord,
  cachedContentVersion,
  commitInputObservation,
  eligibleFileRecord,
  findSourceVersion,
  hasSourceBaseline,
  isReusableSourceInput,
  MAX_INPUT_SNAPSHOT_BYTES,
  recordsForSource,
  sourceBaselineMarker,
  type ObservationRefresh,
} from "./input-ledger.js";
import type { AutomationPersistence } from "./persistence.js";
import {
  captureSourceFile,
  discoverSourceFiles,
  type DiscoveredSourceFile,
} from "./source-discovery.js";
import type {
  AutomationInputRecord,
  AutomationJournalState,
} from "./storage-records.js";

type Candidate = Readonly<{
  file: DiscoveredSourceFile;
  existing?: AutomationInputRecord;
  contentVersion?: string;
}>;

type SourcePlan = Readonly<{
  marker?: AutomationInputRecord;
  baselineFiles: readonly AutomationInputRecord[];
  candidates: readonly Candidate[];
  refresh: readonly ObservationRefresh[];
}>;

function sourceFailure(error: unknown): string {
  if (error instanceof Error && error.message === "automation_source_changed")
    return "automation_source_changed";
  if (error instanceof Error && error.message === "automation_source_capacity_exceeded")
    return "automation_source_capacity_exceeded";
  return "automation_source_unavailable";
}

function failedForJob(
  job: SchedulerAutomationJob,
  error: string,
  terminalAt: string,
): PreparedAutomationOccurrence {
  return {
    kind: "failed",
    error,
    commit: (state, runId) => {
      state.executions.push({
        id: runId,
        automationId: job.target.automationId,
        definitionRevision: job.target.definitionRevision,
        revision: 1,
        inputIds: [],
        nodes: [],
        reportRef: `derived:${runId}`,
        terminalAt,
      });
    },
  };
}

function sourceFree(job: SchedulerAutomationJob): PreparedAutomationOccurrence {
  return {
    kind: "ready",
    inputIds: [],
    commit: (state, runId) => {
      state.executions.push({
        id: runId,
        automationId: job.target.automationId,
        definitionRevision: job.target.definitionRevision,
        revision: 1,
        inputIds: [],
        nodes: [],
      });
    },
  };
}

async function planSource(input: {
  definition: AutomationRevision;
  source: FolderSource;
  state: AutomationJournalState;
  config: RuntimeConfig;
  observedAt: string;
  now: number;
}): Promise<SourcePlan | "unstable_baseline"> {
  const discovered = await discoverSourceFiles({
    source: input.source,
    paths: input.config.paths,
    now: input.now,
  });
  const records = recordsForSource(
    input.state, input.definition.automationId, input.source.sourceId,
  );
  const firstScan = !hasSourceBaseline(records, discovered.root);
  if (firstScan && !input.source.includeExisting && discovered.unstableCount > 0)
    return "unstable_baseline";
  const establishExcludingBaseline = firstScan && !input.source.includeExisting;
  const excludedInputIds: string[] = [];
  const baselineFiles: AutomationInputRecord[] = [];
  const candidates: Candidate[] = [];
  const refresh: ObservationRefresh[] = [];
  for (const file of discovered.files) {
    const cached = cachedContentVersion(file, records);
    const captured = cached ? undefined : await captureSourceFile(file);
    const version = cached ?? captured!.contentVersion;
    const existing = findSourceVersion(records, file.canonicalPath, version);
    const existingVersionNeedsBaseline = existing && establishExcludingBaseline;
    if (existingVersionNeedsBaseline) {
      excludedInputIds.push(existing.id);
      continue;
    }
    if (existing) {
      if (!cached) refresh.push({
        recordId: existing.id, file, observedAt: input.observedAt,
      });
      if (isReusableSourceInput(existing, records, discovered.root))
        candidates.push({ file, existing });
      continue;
    }
    if (establishExcludingBaseline) {
      baselineFiles.push(baselineFileRecord({
        automationId: input.definition.automationId,
        sourceId: input.source.sourceId,
        file: captured!,
        observedAt: input.observedAt,
      }));
      continue;
    }
    candidates.push({ file, contentVersion: version });
  }
  const marker = firstScan ? sourceBaselineMarker({
    automationId: input.definition.automationId,
    sourceId: input.source.sourceId,
    root: discovered.root,
    observedAt: input.observedAt,
    excludedInputIds,
  }) : undefined;
  return { marker, baselineFiles, candidates, refresh };
}

function selectedCandidates(
  definition: AutomationRevision,
  source: FolderSource,
  candidates: readonly Candidate[],
): Candidate[] {
  const threshold = definition.trigger.kind === "folder"
    ? definition.trigger.minimumEligibleFiles : 1;
  const maxFiles = source.mode === "per_file" ? 1 : source.maxBatchFiles;
  return selectAutomationInputBatch(candidates, threshold, maxFiles);
}

function verifyPlanFits(
  state: AutomationJournalState,
  plan: SourcePlan,
  newFiles: readonly AutomationInputRecord[],
  existingIds: readonly string[],
  runId?: string,
): void {
  const preview = structuredClone(state);
  commitInputObservation({
    state: preview,
    marker: plan.marker,
    baselineFiles: plan.baselineFiles,
    newFiles,
    selectedExistingIds: existingIds,
    refresh: plan.refresh,
    runId,
  });
}

export function createAutomationOccurrencePreparer(options: {
  config: RuntimeConfig;
  persistence: AutomationPersistence;
  attachments: RuntimeAttachmentStore;
  snapshots?: AutomationSnapshotStaging;
  now?: () => number;
}): SchedulerAutomationExecutor["prepare"] {
  const snapshots = options.snapshots ?? createAutomationSnapshotStaging({
    runtimeDir: options.config.paths.runtimeDir, persistence: options.persistence,
    attachments: options.attachments,
  });
  return async (job, candidateRunId) => {
    const now = options.now?.() ?? Date.now();
    const observedAt = new Date(now).toISOString();
    const state = await options.persistence.read();
    const definition = state.definitions.find((item) =>
      item.automationId === job.target.automationId &&
      item.revision === job.target.definitionRevision)?.definition;
    if (!definition) return failedForJob(job, "automation_definition_not_found", observedAt);
    if (!definition.source) {
      return definition.trigger.kind === "folder"
        ? failedForJob(job, "automation_source_unavailable", observedAt)
        : sourceFree(job);
    }
    let plan: SourcePlan | "unstable_baseline";
    try {
      await snapshots.reconcile();
      plan = await planSource({
        definition,
        source: definition.source,
        state,
        config: options.config,
        observedAt,
        now,
      });
    } catch (error) {
      const code = sourceFailure(error);
      return code === "automation_source_changed"
        ? { kind: "no_input" }
        : failedForJob(job, code, observedAt);
    }
    if (plan === "unstable_baseline") return { kind: "no_input" };
    let selected: Candidate[];
    try { selected = selectedCandidates(definition, definition.source, plan.candidates); }
    catch (error) { return failedForJob(job, sourceFailure(error), observedAt); }
    if (selected.length === 0) {
      try { verifyPlanFits(state, plan, [], []); }
      catch (error) { return failedForJob(job, sourceFailure(error), observedAt); }
      return {
        kind: "no_input",
        commit: plan.marker || plan.baselineFiles.length || plan.refresh.length
          ? (current) => commitInputObservation({
              state: current,
              marker: plan.marker,
              baselineFiles: plan.baselineFiles,
              refresh: plan.refresh,
            })
          : undefined,
      };
    }
    const retainedBytes = state.inputs.reduce((bytes, record) =>
      bytes + (record.snapshot?.sizeBytes ?? 0), 0);
    const newBytes = selected.reduce((bytes, candidate) =>
      bytes + (candidate.existing ? 0 : candidate.file.sizeBytes), 0);
    if (retainedBytes + newBytes > MAX_INPUT_SNAPSHOT_BYTES)
      return failedForJob(job, "automation_source_capacity_exceeded", observedAt);
    const newFiles: AutomationInputRecord[] = [];
    const existingIds: string[] = [];
    try {
      const needsNewSnapshots = selected.some((candidate) => !candidate.existing);
      if (needsNewSnapshots) await snapshots.begin(candidateRunId);
      for (const candidate of selected) {
        if (candidate.existing) {
          existingIds.push(candidate.existing.id);
          continue;
        }
        const captured = await captureSourceFile(candidate.file);
        if (captured.contentVersion !== candidate.contentVersion)
          throw new Error("automation_source_changed");
        const id = randomUUID();
        const attachment = await options.attachments.saveAttachment({
          sessionId: candidateRunId,
          requestId: id,
          kind: captured.kind,
          mimeType: captured.mimeType,
          bytes: captured.bytes,
          name: basename(captured.canonicalPath),
        });
        newFiles.push(eligibleFileRecord({
          id,
          automationId: definition.automationId,
          sourceId: definition.source.sourceId,
          file: captured,
          observedAt,
          attachment,
        }));
      }
      verifyPlanFits(state, plan, newFiles, existingIds, candidateRunId);
    } catch (error) {
      await snapshots.discard(candidateRunId);
      const code = sourceFailure(error);
      return code === "automation_source_changed"
        ? { kind: "no_input" }
        : failedForJob(job, code, observedAt);
    }
    const inputIds = [...existingIds, ...newFiles.map((record) => record.id)];
    return {
      kind: "ready",
      inputIds,
      commit: (current, runId) => {
        commitInputObservation({
          state: current,
          marker: plan.marker,
          baselineFiles: plan.baselineFiles,
          newFiles,
          selectedExistingIds: existingIds,
          refresh: plan.refresh,
          runId,
        });
        current.executions.push({
          id: runId,
          automationId: job.target.automationId,
          definitionRevision: job.target.definitionRevision,
          revision: 1,
          inputIds,
          nodes: [],
        });
      },
      discard: newFiles.length > 0
        ? () => snapshots.discard(candidateRunId)
        : undefined,
    };
  };
}
