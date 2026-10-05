import { randomUUID } from "node:crypto";
import { hasToolAbortReceipt } from "../../capabilities/tool-interruption.js";
import type WebSocket from "ws";
import type { ToolRequestAttachment, ToolUnderlyingSettlement } from "../../capabilities/tool-types.js";
import type { RegisteredToolNormalInvocationResult } from "../adapters/registered-tool-normal-invocations/shared/contracts.js";
import type { CapabilityJsonValue } from "../orchestration/capability-adapters/result.js";
import type {
  ModelGatewayClient, RuntimeConfig, SessionStore, ToolRegistry,
} from "../ports.js";
import type { RuntimeAttachmentStore } from "../attachments/store.js";
import { getRequestFinalState } from "../../sessions/record/projection.js";
import { createInMemoryLongTermMemoryRepository } from "../adapters/long-term-memory/in-memory-repository.js";
import { createLongTermMemoryService } from "../long-term-memory/service.js";
import { handleRunRequestWithOutcome } from "../request/handler.js";
import { validateJsonSchemaValue } from "../model/json-schema-value.js";
import { resolveModelSelection } from "../model/model-selection.js";
import type { AgentNode, AutomationRevision, OperationRef } from "./definition-contracts.js";
import type { AutomationStepCompletion } from "./graph-executor.js";
import type { AutomationNodeTransactions } from "./node-transactions.js";
import type { AutomationPersistence } from "./persistence.js";
import type { AutomationGrantManager } from "./permission-grants.js";
import { permitsAutomationOperation, sameOperation } from "./permission-grants.js";
import { readAutomationCatalog } from "./catalog.js";
import type { AutomationResultStore } from "./result-store.js";
import { remainingAutomationResultBytes } from "./result-capacity.js";
import type { AutomationModelCapacity } from "./model-capacity.js";
import type { AutomationToolLifetimes } from "./tool-lifetimes.js";
import { scopeToolRegistry } from "./agent-tool-scope.js";
import { withAutomationAgentSession } from "./agent-session-lifetime.js";
import { createAutomationAgentAssignment } from "./agent-assignment.js";
import { automationAgentRequestFailureCode } from "./agent-request-failure.js";
import { retainAutomationEffectAdmission } from "./effect-admission-lifetime.js";
import { publishAutomationResult } from "./result-publication.js";

const disabledMemory = createLongTermMemoryService({
  repository: createInMemoryLongTermMemoryRepository(),
  enabled: false,
  emitClientEvents: false,
});

function parseAgentOutput(node: AgentNode, text: string): { text: string; data?: CapabilityJsonValue } {
  if (node.result.kind === "text") return { text };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("automation_agent_output_invalid_json");
  }
  if (validateJsonSchemaValue(node.result.schema as Readonly<Record<string, unknown>>, data))
    throw new Error("automation_agent_output_invalid_schema");
  return { text, data: data as CapabilityJsonValue };
}

function acceptedOutput(node: AgentNode, output: { data?: CapabilityJsonValue }): boolean {
  if (!node.acceptance?.length) return true;
  if (!output.data || typeof output.data !== "object" || Array.isArray(output.data)) return false;
  const data = output.data as Record<string, unknown>;
  return node.acceptance.every((test) => data[test.field] === test.equals);
}

export function createAutomationAgentStepExecutor(options: {
  config: RuntimeConfig;
  sessions: SessionStore;
  attachments: RuntimeAttachmentStore;
  models: ModelGatewayClient;
  modelCapacity: AutomationModelCapacity;
  toolLifetimes: AutomationToolLifetimes;
  tools: ToolRegistry;
  persistence: AutomationPersistence;
  results: AutomationResultStore;
  transactions: AutomationNodeTransactions;
  grants: Pick<AutomationGrantManager, "get">;
  automationId: string;
  runId: string;
  definition: AutomationRevision;
}) {
  async function execute(input: {
    node: AgentNode;
    inputs: Readonly<Record<string, CapabilityJsonValue>>;
    sourceAttachments: readonly ToolRequestAttachment[];
    signal: AbortSignal;
  }): Promise<AutomationStepCompletion> {
    const { node } = input;
    if (input.signal.aborted) return { status: "cancelled", errorCode: "automation_run_stopped" };
    const selection = resolveModelSelection({
      agentMode: node.agentMode,
      modelPreference: { profileId: node.modelProfileId, scope: "all" },
      modelPolicy: options.config.models,
      modelExecutionPolicies: options.config.modelExecutionPolicies,
    });
    if (selection.execution.primaryProfileId !== node.modelProfileId)
      return { status: "failed", errorCode: "automation_model_unavailable" };
    const capturedGrant = await options.grants.get(options.automationId);
    const catalog = await readAutomationCatalog({
      automationId: options.automationId,
      environmentId: options.config.runtimeId,
      config: options.config,
      tools: options.tools,
      persistence: options.persistence,
    });
    const selected = node.tools.map((item) => item.operation);
    if (selected.some((operation) => !catalog.operations.some((candidate) =>
      sameOperation(operation, candidate))))
      return { status: "failed", errorCode: "automation_operation_unavailable" };
    if (selected.length > 0 && !capturedGrant)
      return { status: "failed", errorCode: "automation_operation_unavailable" };
    const effectAdmissions = new WeakMap<object, string>();
    const durableAttemptIds = new Map<string, string>();
    const admittedOperations = new Map<string, OperationRef>();
    const observeUnderlying = (invocationId: string, settled: Promise<ToolUnderlyingSettlement>) =>
      options.toolLifetimes.observe(options.runId, invocationId, settled);
    const invokeTool = <T>(invoke: () => Promise<T>) =>
      options.toolLifetimes.runInvocation(options.runId, input.signal, invoke);
    const registry: ToolRegistry = {
      ...scopeToolRegistry(options.tools, selected, effectAdmissions, admittedOperations, observeUnderlying, invokeTool),
      prepareRequest: async (context) => {
        const prepared = await options.tools.prepareRequest?.(context) ?? options.tools;
        return scopeToolRegistry(prepared, selected, effectAdmissions, admittedOperations, observeUnderlying, invokeTool);
      },
    };
    const sessionId = randomUUID();
    const requestId = randomUUID();
    const attemptId = randomUUID();
    const origin = {
      kind: "automation_node_v1" as const,
      automationId: options.automationId,
      runId: options.runId,
      nodeId: node.id,
      attemptId,
    };
    const receipts: { operation: OperationRef; ok: boolean }[] = [];
    const budgetedModels: ModelGatewayClient = {
      ...options.models,
      invoke: (params) => options.modelCapacity.withInvocation(params, options.config.models,
        async () => {
          await options.transactions.recordModelCall(
            options.runId, node.id, options.definition.limits.maxModelCallsPerRun);
          params.abortSignal.throwIfAborted();
          return options.models.invoke(params);
        }),
      invokeRaw: (params) => options.modelCapacity.withInvocation(params, options.config.models,
        async () => {
          await options.transactions.recordModelCall(
            options.runId, node.id, options.definition.limits.maxModelCallsPerRun);
          params.abortSignal.throwIfAborted();
          return options.models.invokeRaw(params);
        }),
    };
    const durableEffects = {
      beforeEffect: async (effect: {
        executionId: string;
        actionFingerprint: string;
        source: OperationRef;
        target: OperationRef;
        effect: string;
      }) => {
        input.signal.throwIfAborted();
        const allowed = node.tools.some((item) => sameOperation(item.operation, effect.source)) &&
          node.tools.some((item) => sameOperation(item.operation, effect.target));
        const latest = await options.grants.get(options.automationId);
        const available = await readAutomationCatalog({
          automationId: options.automationId,
          environmentId: options.config.runtimeId,
          config: options.config,
          tools: options.tools,
          persistence: options.persistence,
        });
        const source = available.operations.find((operation) =>
          sameOperation(operation, effect.source));
        const target = available.operations.find((operation) =>
          sameOperation(operation, effect.target));
        if (!allowed || !source || !target || !capturedGrant || !latest ||
            latest.grantRevision !== capturedGrant.grantRevision ||
            !permitsAutomationOperation(latest, options.config.runtimeId,
              options.automationId, effect.target, target.permissionMode))
          throw new Error("automation_operation_unavailable");
        if (durableAttemptIds.has(effect.executionId))
          throw new Error("automation_attempt_duplicate");
        const durableAttemptId = randomUUID();
        durableAttemptIds.set(effect.executionId, durableAttemptId);
        try {
          await options.transactions.recordAgentAttempt({
            runId: options.runId,
            nodeId: node.id,
            invocationId: durableAttemptId,
            fingerprint: effect.actionFingerprint,
            maxToolCalls: options.definition.limits.maxToolCallsPerRun,
          });
        } catch (error) {
          durableAttemptIds.delete(effect.executionId);
          throw error;
        }
        admittedOperations.set(durableAttemptId, effect.target);
        const admission = Object.freeze({});
        effectAdmissions.set(admission, durableAttemptId);
        return admission;
      },
      afterEffect: async (effect: {
        executionId: string;
        outcome: RegisteredToolNormalInvocationResult | Readonly<{ status: "uncertain"; error: string }>;
      }) => {
        const durableAttemptId = durableAttemptIds.get(effect.executionId);
        const operation = durableAttemptId && admittedOperations.get(durableAttemptId);
        if (!operation) throw new Error("automation_attempt_mismatch");
        const state = await options.persistence.read();
        const used = state.results.filter((item) => item.runId === options.runId)
          .reduce((sum, item) => sum + item.sizeBytes, 0);
        const abortedMutatingEffect = effect.outcome.status === "executed" &&
          effect.outcome.effect !== "read_only" &&
          hasToolAbortReceipt(effect.outcome.result);
        const uncertain = effect.outcome.status === "uncertain" || abortedMutatingEffect;
        const record = await options.results.save({
          runId: options.runId,
          nodeId: node.id,
          kind: "effect_receipt",
          value: { operation, outcome: effect.outcome },
          maxBytes: Math.min(options.definition.limits.maxStoredArtifactBytes - used,
            remainingAutomationResultBytes(state)),
        });
        await publishAutomationResult({ ...options, record,
          publish: () => options.transactions.settleAgentAttempt({
            runId: options.runId,
            nodeId: node.id,
            invocationId: durableAttemptId,
            result: record,
            uncertain,
            // After admission, prepared-execution only rejects on its exact
            // aborted-before-dispatch branch; Tool results are "executed".
            notDispatched: effect.outcome.status === "rejected",
            maxStoredArtifactBytes: options.definition.limits.maxStoredArtifactBytes,
          }),
        });
        receipts.push({ operation, ok: !uncertain && effect.outcome.status === "executed" &&
          effect.outcome.result?.ok === true });
      },
    };
    const effectPersistence = retainAutomationEffectAdmission({
      runId: options.runId, signal: input.signal, lifetimes: options.toolLifetimes,
      persistence: durableEffects,
    });
    const ws = { send: (_data: string) => undefined } as WebSocket;
    const prompt = createAutomationAgentAssignment({ definition: options.definition, node, inputs: input.inputs });
    const scopedConfig: RuntimeConfig = {
      ...options.config,
      paths: {
        ...options.config.paths,
        agentWorkDir: options.definition.workingDirectory ?? options.config.paths.agentWorkDir,
      },
    };
    const completion = await withAutomationAgentSession({
      sessions: options.sessions, attachments: options.attachments, sessionId, origin,
    }, async (sessions) => {
      await sessions.updateSessionTitle(sessionId, node.title);
      const outcome = await handleRunRequestWithOutcome(ws, {
        type: "run_request", requestId, sessionId, text: prompt,
        agentMode: node.agentMode,
        modelPreference: { profileId: node.modelProfileId, scope: "all" },
        toolPermissionMode: capturedGrant?.mode ?? "full_access",
      }, {
        runtimeConfig: scopedConfig,
        modelGatewayClient: budgetedModels,
        sessionStore: sessions,
        attachmentStore: options.attachments,
        automationInputAttachments: input.sourceAttachments,
        toolRegistry: registry,
        longTermMemory: disabledMemory,
        effectPersistence,
        ...(node.result.kind === "json"
          ? { automationOutputContract: node.result.schema }
          : {}),
        abortSignal: input.signal,
        toolApprovalController: {
          requestToolApproval: async () => ({ approved: false,
            reason: "automation_approval_required" }),
        },
      });
      const isBlockedRequest = outcome?.kind === "completed" && outcome.disposition === "blocked";
      if (isBlockedRequest) return { kind: "blocked" as const };
      const session = await sessions.getSessionById(sessionId);
      const request = session?.requests?.find((item) => item.requestId === requestId);
      const final = request ? getRequestFinalState(request) : null;
      if (final?.status !== "completed")
        throw new Error(automationAgentRequestFailureCode(final?.error));
      const message = session?.messages.find((item) => item.role === "assistant" &&
        item.requestId === requestId);
      if (!message) throw new Error("automation_agent_result_missing");
      for (const required of node.tools.filter((item) => item.usage === "required")) {
        if (!receipts.some((item) => item.ok && sameOperation(item.operation, required.operation)))
          throw new Error("automation_required_operation_missing");
      }
      const output = parseAgentOutput(node, message.content);
      return { kind: "result" as const, output };
    });
    const isBlockedStep = completion.kind === "blocked";
    const rejectedByAcceptance = !isBlockedStep && !acceptedOutput(node, completion.output);
    const hasUnsettledRejectedEffect = (isBlockedStep || rejectedByAcceptance) &&
      await options.transactions.hasUnsettledEffect(options.runId, node.id);
    if (hasUnsettledRejectedEffect)
      return { status: "failed", errorCode: "automation_effect_uncertain", uncertain: true };
    if (isBlockedStep) return { status: "failed", errorCode: "automation_agent_blocked" };
    const output = completion.output;
    const rejectedStatus = node.onFailure === "skip" ? "skipped" : "failed";
    const stepCompletion: AutomationStepCompletion = rejectedByAcceptance
      ? { status: rejectedStatus, errorCode: "automation_agent_acceptance_failed" }
      : { status: "succeeded" };
    const state = await options.persistence.read();
    const used = state.results.filter((item) => item.runId === options.runId)
      .reduce((sum, item) => sum + item.sizeBytes, 0);
    const record = await options.results.save({
      runId: options.runId,
      nodeId: node.id,
      kind: "node_output",
      value: output,
      maxBytes: Math.min(options.definition.limits.maxStoredArtifactBytes - used,
        remainingAutomationResultBytes(state)),
    });
    await publishAutomationResult({ ...options, record,
      publish: () => options.transactions.settleNode({
        runId: options.runId,
        nodeId: node.id,
        ...stepCompletion,
        result: record,
        maxStoredArtifactBytes: options.definition.limits.maxStoredArtifactBytes,
      }),
    });
    return stepCompletion;
  }
  return { execute };
}
