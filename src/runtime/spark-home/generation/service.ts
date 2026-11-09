import { randomUUID } from "node:crypto";
import { createSparkHomeGenerationModel, resolveHomeGenerationSelection } from "./model.js";
import { createSparkHomeReadTools, type SparkHomeReadTools } from "./read-tools.js";
import { createSparkHomeRunStore } from "./run-store.js";
import { createSparkHomeRunApprovals } from "./run-approvals.js";
import { executeSparkHomeRun } from "./run-execution.js";
import { parseSparkHomeStartInput, parseSparkHomeReadRunInput, parseSparkHomeCancelInput,
  parseSparkHomeApprovalDecisionInput } from "./input.js";
import { homeGenerationFailure, isSparkHomeRunActive, SparkHomeGenerationError,
  type SparkHomeGenerationDependencies, type SparkHomeGenerationService, type SparkHomeRunSnapshot,
  type SparkHomeStartInput } from "./contracts.js";

type ActiveHomeRun = {
  runId: string; abort: AbortController; signal: AbortSignal; pending: Promise<void>;
  snapshot?: SparkHomeRunSnapshot; approvals?: ReturnType<typeof createSparkHomeRunApprovals>;
};

function homeRunFailureCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && /^[a-z_]{1,100}$/.test(code)) return code;
  return "spark_home_generation_failed";
}

/** Environment-owned HOME work; no ordinary request or transcript lifecycle is created. */
export function createSparkHomeGenerationService(dependencies: SparkHomeGenerationDependencies): SparkHomeGenerationService {
  const store = dependencies.store ?? createSparkHomeRunStore(dependencies.config.paths.runtimeDir);
  const listeners = new Set<(snapshot: SparkHomeRunSnapshot) => void>();
  let active: ActiveHomeRun | undefined;
  let latest: SparkHomeRunSnapshot | null = null;
  let stopped = false;
  let initialized: Promise<void> | undefined;
  let writes: Promise<void> = Promise.resolve();

  const publish = (snapshot: SparkHomeRunSnapshot) => {
    for (const listener of listeners) {
      try { listener(structuredClone(snapshot)); } catch { /* A view cannot alter the run. */ }
    }
  };
  function initialize(): Promise<void> {
    initialized ??= (async () => {
      latest = await store.read();
      if (!latest || !isSparkHomeRunActive(latest.status)) return;
      latest = { ...latest, revision: latest.revision + 1, status: "interrupted", pendingApproval: null,
        errorCode: "spark_home_run_interrupted", updatedAt: new Date().toISOString() };
      await store.write(latest);
    })();
    return initialized;
  }
  function change(entry: ActiveHomeRun, patch: Partial<SparkHomeRunSnapshot>): Promise<void> {
    const pending = writes.then(async () => {
      if (!entry.snapshot) return homeGenerationFailure("spark_home_run_not_found");
      const next = { ...entry.snapshot, ...patch, revision: entry.snapshot.revision + 1, updatedAt: new Date().toISOString() };
      await store.write(next);
      entry.snapshot = next;
      latest = next;
      publish(next);
    });
    writes = pending.catch(() => {});
    return pending;
  }
  async function find(runId?: string): Promise<SparkHomeRunSnapshot | null> {
    await initialize();
    const snapshot = active?.snapshot ?? latest;
    if (!runId) return snapshot ? structuredClone(snapshot) : null;
    if (snapshot?.runId !== runId) return homeGenerationFailure("spark_home_run_not_found");
    return structuredClone(snapshot);
  }
  async function perform(entry: ActiveHomeRun, input: SparkHomeStartInput,
    admit: (snapshot: SparkHomeRunSnapshot) => void): Promise<void> {
    let tools: SparkHomeReadTools | undefined;
    try {
      await initialize();
      entry.signal.throwIfAborted();
      const settings = await dependencies.settings.prepareRequest({
        expectedRevision: input.expectedSettingsRevision,
        abortSignal: entry.signal,
      });
      const selection = resolveHomeGenerationSelection(dependencies.config, settings);
      const mode = await dependencies.getToolPermissionMode();
      const screen = await dependencies.screen.read();
      const model = createSparkHomeGenerationModel({ config: dependencies.config, models: dependencies.models,
        settings, runId: entry.runId, abortSignal: entry.signal });
      entry.approvals = createSparkHomeRunApprovals({ runId: entry.runId, signal: entry.signal, changed: approval =>
        change(entry, { pendingApproval: approval, status: approval ? "awaiting_approval" : "running" }) });
      tools = await createSparkHomeReadTools({ registry: dependencies.tools, runId: entry.runId, signal: entry.signal,
        mode, modelPlugins: selection.execution.plugins, sessionId: await dependencies.getSessionId?.(),
        approvals: entry.approvals.controller });
      const sources = await dependencies.context.capture({ expectedRevision: screen.revision, requestId: entry.runId,
        abortSignal: entry.signal, resourcesAccess: tools.resourcesAccess, appearance: await dependencies.getAppearance?.() });
      entry.signal.throwIfAborted();
      const now = new Date().toISOString();
      const snapshot: SparkHomeRunSnapshot = { runId: entry.runId, revision: 1, status: "running", phase: "plan",
        startedAt: now, updatedAt: now, screenRevision: null, pendingApproval: null, errorCode: null };
      await store.write(snapshot);
      entry.snapshot = snapshot;
      latest = snapshot;
      // pending was assigned synchronously before this async admission began.
      publish(snapshot);
      admit(structuredClone(snapshot));
      const screenRevision = await executeSparkHomeRun({ runId: entry.runId, settings, screenRevision: screen.revision,
        ...(input.instruction ? { instruction: input.instruction } : {}), sources, model, signal: entry.signal }, tools, dependencies,
      phase => change(entry, { phase }));
      await change(entry, { status: "completed", screenRevision, pendingApproval: null, errorCode: null });
    } catch (error) {
      if (!entry.snapshot) throw error;
      const interrupted = entry.abort.signal.reason instanceof SparkHomeGenerationError && entry.abort.signal.reason.code === "spark_home_run_interrupted";
      const status = entry.signal.aborted ? (interrupted ? "interrupted" : "cancelled") : "failed";
      await change(entry, { status, pendingApproval: null,
        errorCode: entry.signal.aborted ? `spark_home_run_${status}` : homeRunFailureCode(error) });
    } finally { await tools?.dispose(); }
  }
  function start(input: SparkHomeStartInput): Promise<SparkHomeRunSnapshot> {
    if (stopped) return Promise.reject(new SparkHomeGenerationError("spark_home_stopped"));
    if (active) return Promise.reject(new SparkHomeGenerationError("spark_home_run_busy"));
    const abort = new AbortController();
    const signal = abort.signal;
    let admit!: (snapshot: SparkHomeRunSnapshot) => void;
    let reject!: (error: unknown) => void;
    const admitted = new Promise<SparkHomeRunSnapshot>((yes, no) => { admit = yes; reject = no; });
    const entry: ActiveHomeRun = { runId: randomUUID(), abort, signal, pending: Promise.resolve() };
    active = entry;
    entry.pending = Promise.resolve().then(() => perform(entry, input, admit)).catch(error => {
      reject(error);
      if (!entry.snapshot) return;
      entry.snapshot = { ...entry.snapshot, revision: entry.snapshot.revision + 1, status: "failed", pendingApproval: null,
        errorCode: homeRunFailureCode(error), updatedAt: new Date().toISOString() };
      latest = entry.snapshot;
      publish(entry.snapshot);
    }).finally(() => { if (active === entry) active = undefined; });
    return admitted;
  }
  const service: SparkHomeGenerationService = {
    start: input => start(parseSparkHomeStartInput(input)),
    readRun: input => find(parseSparkHomeReadRunInput(input).runId),
    async cancel(input) {
      const { runId } = parseSparkHomeCancelInput(input);
      const current = active;
      if (current?.runId === runId) {
        current.abort.abort(new SparkHomeGenerationError("spark_home_run_cancelled"));
        await current.pending;
      }
      return (await find(runId))!;
    },
    async decideApproval(input) {
      const decision = parseSparkHomeApprovalDecisionInput(input);
      if (active?.runId !== decision.runId || !active.approvals) return homeGenerationFailure("spark_home_approval_not_pending");
      active.approvals.decide(decision);
      return (await find(decision.runId))!;
    },
    async wait(runId) {
      const current = active;
      if (current?.runId === runId) await current.pending;
      return (await find(runId))!;
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    isIdle: () => !active,
    async whenIdle() { while (active) await active.pending; },
    async stop() {
      stopped = true;
      active?.abort.abort(new SparkHomeGenerationError("spark_home_run_interrupted"));
      await service.whenIdle();
    },
  };
  return service;
}
