import type WebSocket from "ws";
import { isDeepStrictEqual } from "node:util";
import type { RuntimeEnvironmentServices } from "../../composition.js";
import type { EventSink, ModelGatewayClient } from "../../ports.js";
import type { SessionRequestLifecycleSnapshot } from "../../../sessions/request-lifecycle/contracts.js";
import { RequestToolResources } from "../../capabilities/request-tool-resources.js";
import { RequestLifecycle } from "../../orchestration/lifecycle/request-lifecycle.js";
import { assertExecutionBudgets } from "../../orchestration/lifecycle/execution-budgets.js";
import { createRoleCallLedger } from "../../orchestration/role-calls/index.js";
import { restoreCapabilityApprovalGroup } from "../../orchestration/worker-capabilities/index.js";
import { captureRequestTemporalContext } from "../../context/request-temporal-context.js";
import { validateRequestApprovalContinuation } from "../approval-continuation.js";
import { restoreApprovalExecutionFreshness } from "../capability-execution-freshness.js";
import { createRequestSteeringInbox } from "../request-steering.js";
import { resolveRequestDependencies } from "../dependencies.js";
import { prepareRequestExecution } from "../prepared-execution.js";
import { createRequestRoleCallPolicy } from "../role-call-policy.js";
import type { RequestHandlerOptions } from "../contracts.js";
import {
  REQUEST_APPROVAL_SNAPSHOT,
  type RequestApprovalSnapshot,
} from "./snapshot.js";

/** Compatibility preflight only. It cannot publish, persist an event, or dispatch. */
export async function validateApprovalResume(
  services: RuntimeEnvironmentServices,
  snapshot: RequestApprovalSnapshot,
  current: SessionRequestLifecycleSnapshot,
): Promise<void> {
  assertEnvelope(snapshot, current);
  assertExecutionBudgets(snapshot.budgets);
  const resources = new RequestToolResources();
  const lifecycle = new RequestLifecycle({
    requestId: current.requestId,
    requestTimeoutMs: 0,
    inactivityTimeoutMs: 0,
  });
  const steering = createRequestSteeringInbox({ requestId: current.requestId });
  const events = forbiddenEvents();
  const models: ModelGatewayClient = {
    invoke: async () => {
      throw new Error("approval_preflight_model_forbidden");
    },
    invokeRaw: async () => {
      throw new Error("approval_preflight_model_forbidden");
    },
  };
  try {
    if (!Array.isArray(snapshot.steering?.updates))
      throw new Error("approval_snapshot_steering_invalid");
    for (const update of snapshot.steering.updates) {
      const result = steering.append(update);
      if (
        !result.ok ||
        result.duplicate ||
        !isDeepStrictEqual(result.update, update)
      )
        throw new Error("approval_snapshot_steering_invalid");
    }
    if (!isDeepStrictEqual(steering.snapshot(), snapshot.steering))
      throw new Error("approval_snapshot_steering_invalid");
    const options: RequestHandlerOptions = {
      runtimeConfig: services.config,
      sessionStore: services.sessions,
      attachmentStore: services.attachments,
      toolRegistry: services.tools,
      modelGatewayClient: models,
      eventSinkFactory: { create: () => events },
      sessionMemoryCompactor: services.sessionMemoryCompactor,
      longTermMemory: services.longTermMemory,
      approvalExecution: {
        activation: current.activation!,
        resume: { snapshot, current, decisions: [] },
      },
    };
    const prepared = await prepareRequestExecution({
      ws: { send: forbidden } as unknown as WebSocket,
      options,
      resources,
      lifecycle,
      steering,
      initialEvents: events,
      dependencies: resolveRequestDependencies(options),
      input: {
        requestId: current.requestId,
        sessionId: current.sessionId,
        prompt: snapshot.originalPrompt,
        rawAttachments: [],
        rawAgentMode: snapshot.seed.agentMode,
        rawModelPreference: snapshot.seed.modelPreference,
        toolPermissionMode: snapshot.seed.toolPermissionMode,
      },
      temporalContext:
        snapshot.seed.temporalContext ?? captureRequestTemporalContext(),
      onEventsReady: () => {},
    });
    resources.assertRestoredStateClaimed();
    const ledger = createRoleCallLedger({
      requestId: current.requestId,
      policy: createRequestRoleCallPolicy(prepared.request.executionPolicy),
      checkpoint: snapshot.runner.ledger,
    });
    validateRequestApprovalContinuation(
      snapshot.runner,
      ledger,
      prepared.request.workerCapabilities.provider.getDescriptors(),
    );
    const executionFreshness = restoreApprovalExecutionFreshness(
      snapshot.runner.preparedGroup.executionFreshnessToken,
      steering,
    );
    await restoreCapabilityApprovalGroup({
      ledger,
      context: prepared.request.workerCapabilities.executionContext,
      adapters: prepared.request.workerCapabilities.provider.getAdapters(),
      group: snapshot.runner.preparedGroup,
      ...(executionFreshness ? { executionFreshness } : {}),
    });
    if (resources.hasActiveWork())
      throw new Error("approval_preflight_created_active_work");
    prepared.events.dispose();
  } finally {
    lifecycle.dispose();
    await steering.close();
    await resources.dispose();
    events.dispose();
  }
}

function assertEnvelope(
  snapshot: RequestApprovalSnapshot,
  current: SessionRequestLifecycleSnapshot,
): void {
  const validIdentity =
    snapshot?.kind === REQUEST_APPROVAL_SNAPSHOT &&
    current.schemaVersion === 1 &&
    current.status === "awaiting_approval" &&
    current.wait &&
    current.activation &&
    snapshot.seed?.sessionId === current.sessionId &&
    snapshot.seed.requestId === current.requestId &&
    snapshot.runner?.preparedGroup?.requestId === current.requestId;
  if (!validIdentity) throw new Error("approval_snapshot_identity_mismatch");
  if (
    typeof snapshot.originalPrompt !== "string" ||
    typeof snapshot.seed.prompt !== "string" ||
    typeof snapshot.requestWorkingDirectory !== "string" ||
    !Array.isArray(snapshot.toolAttachments)
  )
    throw new Error("approval_snapshot_envelope_invalid");
  const pending = snapshot.runner.preparedGroup.entries
    .filter((entry) => entry.approvalRequest)
    .map((entry) => ({
      approvalId: entry.approvalRequest!.approvalId,
      actionFingerprint: entry.actionFingerprint,
    }))
    .sort((a, b) => a.approvalId.localeCompare(b.approvalId));
  const described = current
    .wait!.approvals.map((entry) => ({
      approvalId: entry.approvalId,
      actionFingerprint: entry.actionFingerprint,
    }))
    .sort((a, b) => a.approvalId.localeCompare(b.approvalId));
  if (!pending.length || !isDeepStrictEqual(pending, described))
    throw new Error("approval_snapshot_disclosure_mismatch");
}
function forbidden(): never {
  throw new Error("approval_preflight_event_forbidden");
}
function forbiddenEvents(): EventSink {
  return {
    publish: forbidden,
    event: forbidden,
    runtimeState: forbidden,
    token: forbidden,
    legacyToken: forbidden,
    thinkingDelta: forbidden,
    completed: forbidden,
    failed: forbidden,
    drain: async () => {},
    dispose: () => {},
  };
}
