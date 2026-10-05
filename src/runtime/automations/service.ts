import type { RuntimeConfig, ToolRegistry } from "../ports.js";
import type {
  SchedulerAutomationRun,
  SchedulerService,
} from "../scheduler/contracts.js";
import { readAutomationCatalog } from "./catalog.js";
import { createAutomationDraftManager } from "./draft-management.js";
import { createAutomationArchiveManager } from "./archive-management.js";
import { createAutomationGrantManager } from "./permission-grants.js";
import { currentAutomationGrant } from "./permission-grants.js";
import type { AutomationPersistence } from "./persistence.js";
import { AutomationPublicationError, createAutomationPublicationService } from "./publication.js";
import { publishedAutomationScheduleTiming } from "./trigger-schedule.js";
import { validateAutomationPublication } from "./publication-validation.js";
import { fingerprintAutomationDependencies } from "./dependency-fingerprint.js";
import {
  buildAutomationRunReport,
  projectAutomationLateEvidence,
  verifiedToolCallCount,
  type AutomationRunReport,
} from "./run-report.js";
import type { AutomationResultStore } from "./result-store.js";
import { readAutomationRunOutputSummary } from "./run-output-summary.js";
import { createAutomationSavedAgentManager } from "./saved-agent-management.js";
import { listAutomationStarters, prepareAutomationStarter } from "./starter-templates.js";
import { createAutomationStepEvidenceReader } from "./step-evidence.js";
import {
  findAutomationStep, readAutomationRunEffectSummary, withCurrentLateEvidence,
} from "./step-evidence-effects.js";

function requireRunDefinition(
  state: Awaited<ReturnType<AutomationPersistence["read"]>>,
  run: SchedulerAutomationRun,
) {
  const record = state.definitions.find((item) =>
    item.automationId === run.target.automationId &&
    item.revision === run.target.definitionRevision);
  if (!record) throw new Error("automation_definition_not_found");
  return record.definition;
}

function derivedOutcome(status: SchedulerAutomationRun["status"]): AutomationRunReport["outcome"] {
  switch (status) {
    case "succeeded":
    case "completed_with_skips":
    case "failed":
    case "cancelled":
    case "interrupted":
    case "missed":
      return status;
    default:
      throw new Error("automation_report_not_terminal");
  }
}

function listedStatus(
  draftStatus: "draft" | "paused" | "active" | "archived",
  jobState: string | undefined,
): "draft" | "paused" | "active" | "archived" {
  if (draftStatus === "archived") return "archived";
  if (jobState === "active") return "active";
  return jobState ? "paused" : "draft";
}

/** One management surface shared by ABot Studio and future authoring tools. */
export function createAutomationService(options: {
  config: RuntimeConfig;
  scheduler: SchedulerService;
  persistence: AutomationPersistence;
  results: AutomationResultStore;
  tools: ToolRegistry;
  timeZone?: string;
}) {
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const drafts = createAutomationDraftManager({ persistence: options.persistence });
  const savedAgents = createAutomationSavedAgentManager({ persistence: options.persistence });
  const grants = createAutomationGrantManager({
    persistence: options.persistence,
    environmentId: options.config.runtimeId,
    availableOperations: async () => {
      const catalog = await readAutomationCatalog({
        automationId: "catalog",
        environmentId: options.config.runtimeId,
        config: options.config,
        tools: options.tools,
        persistence: options.persistence,
      });
      return catalog.grantableOperations.map((entry) => ({
        operation: {
          toolName: entry.toolName,
          operationId: entry.operationId,
          contractVersion: entry.contractVersion,
        },
        requiredMode: entry.permissionMode,
      }));
    },
  });
  const publication = createAutomationPublicationService({
    config: options.config,
    drafts,
    grants,
    persistence: options.persistence,
    scheduler: options.scheduler,
    tools: options.tools,
    timeZone,
  });
  const stepEvidence = createAutomationStepEvidenceReader(options);
  const archiveManagement = createAutomationArchiveManager(options);

  async function list() {
    const [listed, jobs] = await Promise.all([
      drafts.list(), options.scheduler.listAutomationJobs(),
    ]);
    const jobsByAutomation = new Map(jobs.map((job) => [job.target.automationId, job]));
    return Promise.all(listed.map(async (draft) => {
      const job = jobsByAutomation.get(draft.id);
      const recent = job
        ? await options.scheduler.listAutomationRuns(draft.id, { limit: 1 })
        : [];
      return {
        ...draft,
        status: listedStatus(draft.status, job?.state),
        ...(job ? { publishedRevision: job.target.definitionRevision } : {}),
        ...(recent[0] ? { latestRunId: recent[0].id, latestRunStatus: recent[0].status } : {}),
      };
    }));
  }

  async function catalog(automationId: string) {
    const available = await readAutomationCatalog({
      automationId,
      environmentId: options.config.runtimeId,
      config: options.config,
      tools: options.tools,
      persistence: options.persistence,
    });
    return { ...available, templates: automationId
      ? [] : listAutomationStarters(available.grantableOperations) };
  }

  async function create(title: string, templateId?: string) {
    if (!templateId) return drafts.create(title);
    const available = await catalog("");
    const starter = prepareAutomationStarter(templateId, available.grantableOperations);
    return drafts.create(starter.title, starter.buildDefinition);
  }

  async function validate(automationId: string) {
    const draft = await drafts.get(automationId);
    if (!draft) throw new Error("automation_not_found");
    const available = await catalog(automationId);
    const job = await options.scheduler.getAutomationJob(automationId);
    // Preview whether the selected operations could be granted. Publication
    // checks the actual grant against the selected graph separately.
    return validateAutomationPublication({
      definition: draft.definition,
      config: options.config,
      operations: available.grantableOperations,
      grantMode: "full_plus",
      timeZone,
      existingSchedule: publishedAutomationScheduleTiming(await options.persistence.read(), job, draft.definition.trigger),
    });
  }

  async function getRun(runId: string) {
    const run = await options.scheduler.getAutomationRun(runId);
    if (!run) throw new Error("automation_run_not_found");
    const state = await options.persistence.read();
    const definition = requireRunDefinition(state, run);
    const execution = state.executions.find((item) => item.id === run.id);
    const selectedRunId = run.id;
    async function readEffectSummary() {
      try {
        return await readAutomationRunEffectSummary({
          state, results: options.results, runId: selectedRunId, definition,
        });
      } catch (error) {
        const latest = await options.persistence.read();
        if (latest.executions.some((item) => item.id === selectedRunId && item.detailsExpiredAt))
          return null;
        throw error;
      }
    }
    let report: AutomationRunReport | null = null;
    if (!execution?.reportExpiredAt && run.reportRef?.startsWith("derived:") && execution) {
      const effectSummary = execution.detailsExpiredAt ? undefined :
        await readEffectSummary();
      if (effectSummary === null) return getRun(runId);
      report = buildAutomationRunReport({
        run, definition, execution,
        inputs: state.inputs.filter((item) => execution.inputIds.includes(item.id)),
        attempts: state.attempts.filter((item) => item.runId === run.id),
        results: state.results.filter((item) => item.runId === run.id),
        outcome: derivedOutcome(run.status),
        finishedAt: run.finishedAt ?? run.scheduledAt,
        ...(effectSummary ? { effectSummary } : {}),
      });
    } else if (!execution?.reportExpiredAt && run.reportRef) {
      const record = state.results.find((item) => item.id === run.reportRef &&
        item.runId === run.id && item.kind === "report");
      if (!record) throw new Error("automation_report_missing");
      let saved: AutomationRunReport;
      try {
        saved = await options.results.read(record) as AutomationRunReport;
      } catch (error) {
        // Cleanup commits expiry before deleting bytes. A read that began just
        // before that commit can retry the authoritative expired projection.
        const latest = await options.persistence.read();
        if (latest.executions.some((item) => item.id === run.id && item.reportExpiredAt))
          return getRun(runId);
        throw error;
      }
      const attempts = state.attempts.filter((item) => item.runId === run.id);
      const summary = saved.effectSummary || (!execution?.detailsExpiredAt
        ? await readEffectSummary() : undefined);
      if (summary === null) return getRun(runId);
      const currentSummary = summary ? withCurrentLateEvidence(summary, attempts) : undefined;
      report = {
        ...saved,
        nodeResults: saved.nodeResults.map((node) => {
          const step = findAutomationStep(definition.body, node.nodeId);
          return { ...node, ...(step ? { title: step.title } : {}) };
        }),
        ...(currentSummary ? {
          effectSummary: currentSummary,
          toolCalls: verifiedToolCallCount(currentSummary, currentSummary.total),
        } : {}),
        lateEvidence: projectAutomationLateEvidence(attempts),
      };
    }
    return {
      ...run,
      automationId: run.target.automationId,
      definition,
      nodes: execution?.nodes.map((node) => ({
        nodeId: node.nodeId,
        status: node.status,
        ...(node.errorCode ? { errorCode: node.errorCode } : {}),
      })) ?? [],
      report,
      outputSummary: await readAutomationRunOutputSummary({
        state, runId: run.id, definition, results: options.results,
        persistence: options.persistence,
      }),
      ...(execution?.detailsExpiredAt
        ? { detailsExpiredAt: execution.detailsExpiredAt } : {}),
      ...(execution?.reportExpiredAt
        ? { reportState: "expired" as const, reportExpiredAt: execution.reportExpiredAt }
        : {}),
    };
  }

  async function requireJob(automationId: string) {
    const job = await options.scheduler.getAutomationJob(automationId);
    if (!job) throw new Error("automation_not_published");
    return job;
  }

  async function getPublishedDefinition(automationId: string) {
    const job = await options.scheduler.getAutomationJob(automationId);
    if (!job) return null;
    const state = await options.persistence.read();
    const published = state.definitions.find((item) =>
      item.automationId === automationId &&
      item.revision === job.target.definitionRevision);
    if (!published) throw new Error("automation_definition_not_found");
    return published.definition;
  }

  async function rerun(runId: string, idempotencyKey: string, confirmed: true) {
    if (confirmed !== true) throw new Error("automation_rerun_confirmation_required");
    let admittedGrantRevision: number | null | undefined;
    let admittedDefinitionFingerprint: string | undefined;
    return options.scheduler.rerunAutomationRun(runId, {
      idempotencyKey,
      confirmed: true,
      async preflight(job, previous) {
        const state = await options.persistence.read();
        const published = state.definitions.find((item) =>
          item.automationId === job.target.automationId &&
          item.revision === previous.target.definitionRevision);
        if (!published) throw new Error("automation_definition_not_found");
        const [grant, available] = await Promise.all([
          grants.get(job.target.automationId), catalog(job.target.automationId),
        ]);
        const issues = validateAutomationPublication({
          definition: published.definition,
          config: options.config,
          operations: available.operations,
          grantMode: grant?.mode ?? "full_access",
          timeZone,
          checkScheduleReadiness: false,
        });
        if (issues.length > 0) throw new AutomationPublicationError(issues);
        if (published.dependencyFingerprint && fingerprintAutomationDependencies({
          definition: published.definition,
          config: options.config,
          operations: available.operations,
        }) !== published.dependencyFingerprint)
          throw new Error("automation_contract_changed");
        admittedGrantRevision = grant?.grantRevision ?? null;
        admittedDefinitionFingerprint = published.dependencyFingerprint;
      },
      validateAdmission(state, job, previous) {
        if (admittedGrantRevision === undefined)
          throw new Error("automation_rerun_admission_missing");
        const published = state.definitions.find((item) =>
          item.automationId === job.target.automationId &&
          item.revision === previous.target.definitionRevision);
        if (!published || published.dependencyFingerprint !== admittedDefinitionFingerprint)
          throw new Error("automation_contract_changed");
        const latest = currentAutomationGrant(
          state.grants, options.config.runtimeId, job.target.automationId);
        if ((latest?.grantRevision ?? null) !== admittedGrantRevision)
          throw new Error("automation_operation_unavailable");
      },
    });
  }

  return {
    list,
    create,
    getDraft: drafts.get,
    deleteDraft: drafts.deleteUnpublishedDraft,
    archive: archiveManagement.archive,
    restore: archiveManagement.restore,
    getPublishedDefinition,
    updateDraft: drafts.update,
    createDraftPlan: drafts.createPlan,
    applyDraftPlan: drafts.applyPlan,
    getSavedAgent: savedAgents.get,
    listSavedAgents: savedAgents.list,
    saveAgentFromDraft: savedAgents.saveFromDraft,
    validate,
    catalog,
    getGrant: grants.get,
    replaceGrant: grants.replace,
    publish: publication.publish,
    async activate(automationId: string) {
      const job = await requireJob(automationId);
      return options.scheduler.resumeAutomationJob(job.id);
    },
    async pause(automationId: string) {
      const job = await requireJob(automationId);
      return options.scheduler.pauseAutomationJob(job.id);
    },
    async runNow(automationId: string, idempotencyKey?: string) {
      const job = await requireJob(automationId);
      return options.scheduler.runNowAutomation(job.id, { idempotencyKey });
    },
    listRuns: options.scheduler.listAutomationRuns.bind(options.scheduler),
    getRun,
    getStepEvidence: stepEvidence.get,
    stopRun: options.scheduler.stopAutomationRun.bind(options.scheduler),
    rerun,
  };
}

export type AutomationService = ReturnType<typeof createAutomationService>;
