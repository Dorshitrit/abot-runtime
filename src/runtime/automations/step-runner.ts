import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ToolRequestAttachment } from "../../capabilities/tool-types.js";
import { hasToolAbortReceipt } from "../../capabilities/tool-interruption.js";
import type { ToolRegistry, RuntimeConfig } from "../ports.js";
import type { RuntimeAttachmentStore } from "../attachments/store.js";
import type { CapabilityJsonValue } from "../orchestration/capability-adapters/result.js";
import type { CompiledAutomationGraph, CompiledAutomationStep } from "./graph-validation.js";
import type { AutomationRevision, SourceFileSnapshot, ValueBinding } from "./definition-contracts.js";
import { resolveAutomationBinding, type AutomationBindingContext, type SettledNodeResult } from "./binding-resolution.js";
import type { AutomationStepCompletion } from "./graph-executor.js";
import type { AutomationNodeTransactions } from "./node-transactions.js";
import type { AutomationPersistence } from "./persistence.js";
import type { AutomationGrantManager } from "./permission-grants.js";
import type { AutomationResultStore } from "./result-store.js";
import type { AutomationJournalState } from "./storage-records.js";
import { executeAutomationToolStep, type AutomationToolStepOutcome } from "./tool-step-executor.js";
import { remainingAutomationResultBytes } from "./result-capacity.js";
import type { AutomationToolLifetimes } from "./tool-lifetimes.js";
import { normalizeAutomationStepInterruption } from "./step-interruption.js";
import { sourceAttachmentsForNode, type AttachmentInputOperation } from "./source-attachment-access.js";
import { projectAutomationBranchResults } from "./branch-result-projection.js";
import { publishAutomationResult } from "./result-publication.js";

type SourceManifest = Readonly<{
  files: readonly SourceFileSnapshot[];
  attachments: readonly ToolRequestAttachment[];
}>;

type StepBindingContext = AutomationBindingContext & Readonly<{
  sourceAttachments: readonly ToolRequestAttachment[];
}>;

function stepFailure(
  step: CompiledAutomationStep,
  code: string,
  uncertain = false,
): AutomationStepCompletion {
  return {
    status: uncertain || step.node.onFailure === "stop" ? "failed" : "skipped",
    errorCode: code,
    ...(uncertain ? { uncertain: true } : {}),
  };
}

export async function resolveAutomationSourceManifest(input: {
  inputIds: readonly string[];
  state: AutomationJournalState;
  definition: AutomationRevision;
  attachments: RuntimeAttachmentStore;
}): Promise<SourceManifest> {
  const source = input.definition.source;
  if (input.inputIds.length > (source?.maxBatchFiles ?? 0) ||
      (source?.mode === "per_file" && input.inputIds.length > 1))
    throw new Error("automation_source_unavailable");
  const files: SourceFileSnapshot[] = [];
  const attachments: ToolRequestAttachment[] = [];
  const seen = new Set<string>();
  for (const id of input.inputIds) {
    if (seen.has(id)) throw new Error("automation_source_unavailable");
    seen.add(id);
    const item = input.state.inputs.find((candidate) => candidate.id === id);
    if (!item?.snapshot || item.automationId !== input.definition.automationId ||
        item.sourceId !== source?.sourceId ||
        item.contentVersion !== item.snapshot.contentVersion)
      throw new Error("automation_source_unavailable");
    let resolved: Awaited<ReturnType<RuntimeAttachmentStore["resolveAttachment"]>>;
    let bytes: Buffer;
    try {
      resolved = await input.attachments.resolveAttachment(item.snapshot.attachment);
      bytes = await readFile(resolved.absolutePath);
    } catch {
      throw new Error("automation_source_unavailable");
    }
    if (bytes.byteLength !== item.snapshot.sizeBytes ||
        createHash("sha256").update(bytes).digest("hex") !== item.contentVersion)
      throw new Error("automation_source_changed");
    files.push({
      inputId: item.id,
      sourceId: item.sourceId,
      originalPath: item.canonicalPath,
      snapshotPath: resolved.absolutePath,
      version: item.contentVersion,
      sizeBytes: item.snapshot.sizeBytes,
    });
    attachments.push({
      id: item.id,
      kind: resolved.metadata.kind,
      mimeType: resolved.metadata.mimeType,
      absolutePath: resolved.absolutePath,
      ...(resolved.metadata.name ? { name: resolved.metadata.name } : {}),
      size: item.snapshot.sizeBytes,
    });
  }
  return { files, attachments };
}

async function bindingContext(input: {
  runId: string;
  definition: AutomationRevision;
  graph: CompiledAutomationGraph;
  persistence: AutomationPersistence;
  results: AutomationResultStore;
  attachments: RuntimeAttachmentStore;
  sourceManifest(): Promise<SourceManifest>;
}): Promise<StepBindingContext> {
  const state = await input.persistence.read();
  const execution = state.executions.find((candidate) => candidate.id === input.runId);
  if (!execution) throw new Error("automation_run_not_found");
  if (execution.automationId !== input.definition.automationId ||
      execution.definitionRevision !== input.definition.revision)
    throw new Error("automation_source_unavailable");
  const settled = new Map<string, SettledNodeResult>();
  for (const node of execution.nodes) {
    if (node.status === "pending" || node.status === "ready" || node.status === "running") continue;
    const record = state.results.find((candidate) => candidate.id === node.resultRef &&
      candidate.runId === input.runId && candidate.nodeId === node.nodeId);
    const value = record ? await input.results.read(record) : null;
    const projected = value && typeof value === "object" && !Array.isArray(value)
      ? value as { text?: unknown; data?: unknown }
      : {};
    settled.set(node.nodeId, {
      status: node.status,
      ...(typeof projected.text === "string" ? { text: projected.text } : {}),
      ...(projected.data !== undefined ? { data: projected.data as CapabilityJsonValue } : {}),
      ...(record ? { resultRef: record.id } : {}),
    });
  }
  const branchResults = projectAutomationBranchResults(input.graph.parallelGroups, settled);
  const manifest = await input.sourceManifest();
  return {
    runId: input.runId,
    runInputs: input.definition.inputs,
    sourceFiles: manifest.files,
    sourceAttachments: manifest.attachments,
    nodeResults: settled,
    branchResults,
  };
}

function resolveValue(binding: ValueBinding, context: AutomationBindingContext): CapabilityJsonValue {
  const value = resolveAutomationBinding(binding, context);
  if (!value.ok) throw new Error(value.code);
  return value.value;
}

function resolveValues(
  bindings: Readonly<Record<string, ValueBinding>>,
  context: AutomationBindingContext,
): Record<string, CapabilityJsonValue> {
  return Object.fromEntries(Object.entries(bindings).map(([key, value]) =>
    [key, resolveValue(value, context)]));
}

/** Resolves only committed producer outputs and runs one selected step. */
export function createAutomationStepRunner(options: {
  runId: string;
  automationId: string;
  definition: AutomationRevision;
  graph: CompiledAutomationGraph;
  config: RuntimeConfig;
  tools: ToolRegistry;
  attachments: RuntimeAttachmentStore;
  persistence: AutomationPersistence;
  results: AutomationResultStore;
  transactions: AutomationNodeTransactions;
  toolLifetimes: AutomationToolLifetimes;
  grants: Pick<AutomationGrantManager, "get">;
  executeAgent?(input: {
    step: CompiledAutomationStep;
    inputs: Readonly<Record<string, CapabilityJsonValue>>;
    sourceAttachments: readonly ToolRequestAttachment[];
    signal: AbortSignal;
  }): Promise<AutomationStepCompletion>;
}) {
  let sourceManifest: Promise<SourceManifest> | undefined;
  let attachmentOperations: Promise<readonly AttachmentInputOperation[]> | undefined;
  const loadAttachmentOperations = () => {
    if (!attachmentOperations) attachmentOperations = (async () => {
      const registry = await options.tools.prepareRequest?.() ?? options.tools;
      return (registry.listNormalInvocations?.() ?? []).flatMap((registration) =>
        registration.contract.operations.map((operation) => ({
          toolName: registration.toolName,
          operationId: operation.operationId,
          contractVersion: registration.contract.version,
          ...(operation.attachmentInput ? { attachmentInput: operation.attachmentInput } : {}),
        })));
    })();
    return attachmentOperations;
  };
  const loadSourceManifest = () => {
    if (!sourceManifest) sourceManifest = options.persistence.read().then((state) => {
      const execution = state.executions.find((candidate) => candidate.id === options.runId);
      if (!execution || execution.automationId !== options.automationId ||
          execution.definitionRevision !== options.definition.revision)
        throw new Error("automation_source_unavailable");
      return resolveAutomationSourceManifest({
        inputIds: execution.inputIds, state, definition: options.definition,
        attachments: options.attachments,
      });
    });
    return sourceManifest;
  };
  async function saveNodeOutput(nodeId: string, value: unknown) {
    const state = await options.persistence.read();
    const used = state.results.filter((item) => item.runId === options.runId)
      .reduce((sum, item) => sum + item.sizeBytes, 0);
    return options.results.save({
      runId: options.runId,
      nodeId,
      kind: "node_output",
      value,
      maxBytes: Math.min(options.definition.limits.maxStoredArtifactBytes - used,
        remainingAutomationResultBytes(state)),
    });
  }

  async function runTool(step: CompiledAutomationStep, signal: AbortSignal,
    context: StepBindingContext): Promise<AutomationStepCompletion> {
    if (step.node.kind !== "tool") throw new Error("automation_node_kind_invalid");
    const grant = await options.grants.get(options.automationId);
    if (!grant) return stepFailure(step, "automation_operation_unavailable");
    let controls: Record<string, CapabilityJsonValue>;
    let payload: string | undefined;
    let sourceAttachments: readonly ToolRequestAttachment[];
    try {
      controls = resolveValues(step.node.controls, context);
      sourceAttachments = sourceAttachmentsForNode({ node: step.node, ...context,
        operations: await loadAttachmentOperations() });
      if (step.node.payload) {
        const value = resolveValue(step.node.payload, context);
        payload = typeof value === "string" ? value : JSON.stringify(value);
      }
    } catch (error) {
      return stepFailure(step, error instanceof Error ? error.message : "automation_dependency_missing");
    }
    let completion: AutomationStepCompletion | undefined;
    const result = await executeAutomationToolStep({
      node: step.node,
      controls,
      sourceAttachments,
      ...(payload !== undefined ? { payload } : {}),
      registry: options.tools,
      environmentId: options.config.runtimeId,
      automationId: options.automationId,
      capturedGrant: grant,
      currentGrant: () => options.grants.get(options.automationId),
      workingDirectory: options.definition.workingDirectory ?? options.config.paths.agentWorkDir,
      requestId: `automation:${options.runId}:${step.id}`,
      abortSignal: signal,
      onUnderlyingSettlement: (invocationId, settled) =>
        options.toolLifetimes.observe(options.runId, invocationId, settled),
      invokeTool: (invoke) => options.toolLifetimes.runInvocation(options.runId, signal, invoke),
      holdEffectAdmission: () => options.toolLifetimes.holdEffectAdmission(options.runId, signal),
      beforeEffect: async (attempt) => {
        await options.transactions.recordAttempt({
          runId: options.runId,
          nodeId: step.id,
          invocationId: attempt.invocationId,
          fingerprint: attempt.fingerprint,
          maxToolCalls: options.definition.limits.maxToolCallsPerRun,
        });
      },
      afterEffect: async (attempt, outcome, notDispatched) => {
        const settledCompletion = normalizeAutomationStepInterruption(toolCompletion(step, outcome), signal);
        completion = settledCompletion;
        const stored = await saveNodeOutput(step.id, toolResultValue(outcome));
        await publishAutomationResult({ ...options, record: stored,
          publish: () => options.transactions.settleNode({
            runId: options.runId,
            nodeId: step.id,
            status: settledCompletion.status,
            attemptId: attempt.invocationId,
            notDispatched,
            result: stored,
            maxStoredArtifactBytes: options.definition.limits.maxStoredArtifactBytes,
            ...(settledCompletion.errorCode ? { errorCode: settledCompletion.errorCode } : {}),
            ...(settledCompletion.uncertain ? { uncertain: true } : {}),
          }),
        });
      },
    });
    return completion ?? normalizeAutomationStepInterruption(toolCompletion(step, result), signal);
  }

  async function run(step: CompiledAutomationStep, signal: AbortSignal): Promise<AutomationStepCompletion> {
    let context: StepBindingContext;
    try {
      context = await bindingContext({
        runId: options.runId, definition: options.definition, graph: options.graph,
        persistence: options.persistence, results: options.results,
        attachments: options.attachments,
        sourceManifest: loadSourceManifest,
      });
    } catch (error) {
      return stepFailure(step, error instanceof Error ? error.message : "automation_source_unavailable");
    }
    if (step.node.kind === "tool") return runTool(step, signal, context);
    if (!options.executeAgent) return stepFailure(step, "automation_agent_unavailable");
    let inputs: Record<string, CapabilityJsonValue>;
    let sourceAttachments: readonly ToolRequestAttachment[];
    try {
      inputs = resolveValues(step.node.inputs, context);
      sourceAttachments = sourceAttachmentsForNode({ node: step.node, ...context,
        operations: await loadAttachmentOperations() });
    } catch (error) {
      return stepFailure(step, error instanceof Error ? error.message : "automation_dependency_missing");
    }
    return options.executeAgent({ step, inputs, sourceAttachments, signal });
  }

  return { run, saveNodeOutput };
}

function toolCompletion(step: CompiledAutomationStep, result: AutomationToolStepOutcome): AutomationStepCompletion {
  if (result.kind === "uncertain") return stepFailure(step, result.code, true);
  if (result.kind === "rejected") return stepFailure(step, result.code);
  if (hasToolAbortReceipt(result.result)) return stepFailure(step, "request_aborted");
  return result.ok ? { status: "succeeded" } :
    stepFailure(step, result.errorCode ?? result.result.errorCode ?? "automation_tool_failed");
}

function toolResultValue(result: AutomationToolStepOutcome): unknown {
  if (result.kind !== "settled") return { kind: result.kind, code: result.code, message: result.message };
  return {
    text: result.result.output,
    ...(result.result.data !== undefined ? { data: result.result.data } : {}),
    receipt: {
      ok: result.ok,
      effect: result.effect,
      ...(result.result.interruption ? { interruption: result.result.interruption } : {}),
      completionActions: result.completionActions,
      ...((result.errorCode ?? result.result.errorCode)
        ? { errorCode: result.errorCode ?? result.result.errorCode } : {}),
    },
  };
}
