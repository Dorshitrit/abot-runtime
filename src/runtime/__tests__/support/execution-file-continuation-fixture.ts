import { vi } from "vitest";
import type { CapabilityAdapterResult, CapabilityDescriptor } from "../../orchestration/capability-adapters/index.js";
import { createRoleCallLedger, resolveRoleCallTransactions, type RoleCapabilityDeclaredEffect } from "../../orchestration/role-calls/index.js";
import { captureRoleCallLedgerCheckpoint } from "../../orchestration/role-calls/checkpoint.js";
import type { RequestApprovalContinuation } from "../../request/approval-continuation.js";
import { createRequestRoleCallPolicy } from "../../request/role-call-policy.js";
import { createRootExecutionFreshness } from "../../request/capability-execution-freshness.js";
import { FILE_PAYLOAD_TOOL_HANDOFF, FILE_PAYLOAD_TOOL_REQUESTED } from "../../capabilities/file-payload-tool-handoff.js";
import { filePayloadFixture } from "./execution-file-payload-fixture.js";
import { createTestRequestExecutionScopeWithCapabilities } from "./request-execution-scope.js";

/** Produces old handoff receipts through the canonical reducer, without replaying old model code. */
export async function fileContinuationFixture(auxiliaryEffect: RoleCapabilityDeclaredEffect = "observation") {
  const base = await filePayloadFixture();
  const capabilities: CapabilityDescriptor[] = [
    descriptor("document.write", "mutation", true), descriptor("dependency.operation", auxiliaryEffect),
    descriptor("dependency.second", "observation"),
  ];
  const execute = vi.fn(async () => ({ outcome: "succeeded" as const, observedEffect: "mutation" as const,
    summary: "Original write completed.", exactResult: exactSuccess() }));
  const restore = vi.fn(async (input: { controls: Record<string, unknown> }, snapshot: unknown) => ({
    acceptedControls: input.controls, actionFingerprint: (snapshot as { fingerprint: string }).fingerprint,
    execute,
  }));
  const adapters = capabilities.map((descriptor) => ({ descriptor, restore, execute }));
  const request = createTestRequestExecutionScopeWithCapabilities(base.request, () => ({
    getDescriptors: () => capabilities, getAdapters: () => adapters,
  }), { executionPolicy: base.request.executionPolicy });
  base.invoke.mockImplementation(async (input) => ({
    text: input.modelStep === "execution.response" ? "Done." : JSON.stringify({ decision: { action: "respond" } }), meta: {},
  }));
  const ledger = createRoleCallLedger({ requestId: request.requestId, policy: createRequestRoleCallPolicy(request.executionPolicy) });
  const transactions = resolveRoleCallTransactions(ledger);
  const created = await transactions.createRoot({ expectedHead: ledger.current() });
  if (!created.ok) throw new Error(created.issueCode);
  const call = () => ledger.current().state.calls[0]!;
  const scoped = await transactions.updateCapabilityScope({ expectedHead: ledger.current(), callId: call().callId,
    invocationAttempt: call().activationCount, mode: "open", catalogGroupIds: ["documents"] });
  if (!scoped.ok) throw new Error(scoped.issueCode);
  let sequence = 0;

  async function begin(capabilityId = "dependency.operation", path = "dependency.txt", effect?: RoleCapabilityDeclaredEffect) {
    const capability = capabilities.find((entry) => entry.capabilityId === capabilityId)!;
    const fingerprint = `sha256:${(++sequence).toString(16).padStart(64, "0")}`;
    const result = await transactions.beginCapabilityExecution({ expectedHead: ledger.current(), callId: call().callId,
      invocationAttempt: call().activationCount, capabilityId, declaredEffect: effect ?? capability.effect,
      controlsJson: JSON.stringify({ path }), actionFingerprint: fingerprint });
    if (!result.ok || result.commit.effect.type !== "capability_execution_begun") throw new Error("fixture_begin_failed");
    return result.commit.effect.executionId;
  }

  async function settle(executionId: string, exactResult: CapabilityAdapterResult = exactSuccess(), failed = false) {
    const execution = ledger.current().state.capabilityExecutions.find((entry) => entry.executionId === executionId)!;
    const result = await transactions.settleCapabilityExecution({ expectedHead: ledger.current(), callId: call().callId,
      executionId, outcome: failed ? "failed" : "succeeded", observedEffect: failed ? "none" :
        execution.declaredEffect === "observation" ? "observation" : "mutation",
      summary: failed ? "File author requested an auxiliary tool." : "Auxiliary operation settled.", exactResult });
    if (!result.ok) throw new Error(`fixture_settle_failed:${result.issueCode}`);
  }

  async function handoff(ids = ["dependency.operation"], path = "report.txt", steeringVersion = 0) {
    const attempt = call().activationCount;
    const selection = (capabilityId: string) => ({ capabilityId, selectionControls: { path: "dependency.txt" } });
    const decision = ids.length === 1 ? { action: "invoke_capability", ...selection(ids[0]!) }
      : { action: "invoke_capabilities", invocations: ids.map(selection) };
    const executionId = await begin("document.write", path);
    await settle(executionId, {
      kind: "generic_capability_result_v1", authority: "capability_adapter", status: "executed", ok: false,
      payload: { kind: "runtime_capability_rejection_v1", authority: "runtime", status: "rejected",
        stage: "before_external_execution", code: FILE_PAYLOAD_TOOL_REQUESTED,
        message: "File author requested an auxiliary capability.", fileAuthoringContinuation: {
          kind: FILE_PAYLOAD_TOOL_HANDOFF, invocationAttempt: attempt, steeringVersion,
          pending: { capabilityId: "document.write", controls: { path }, authoringObjective: "Write the accepted report." },
          toolDecision: JSON.stringify({ decision }),
        } },
    }, true);
    return executionId;
  }

  function checkpoint(): RequestApprovalContinuation {
    const running = ledger.current().state.capabilityExecutions.filter((entry) => entry.status === "running");
    return JSON.parse(JSON.stringify({ kind: "request_approval_continuation_v1",
      ledger: captureRoleCallLedgerCheckpoint(ledger), callers: [],
      root: { acknowledgementPublished: true, titlePublished: true },
      preparedGroup: { kind: "prepared_approval_group_v1", requestId: request.requestId, callId: call().callId,
        invocationAttempt: call().activationCount, batch: running.length > 1,
        executionFreshnessToken: createRootExecutionFreshness({ requestSteering: base.steering, steeringVersion: 0 }).token,
        entries: running.map((entry) => ({ executionId: entry.executionId, capabilityId: entry.capabilityId,
          declaredEffect: entry.declaredEffect, controls: JSON.parse(entry.controlsJson),
          actionFingerprint: entry.actionFingerprint, snapshot: { fingerprint: entry.actionFingerprint } })),
      },
    }));
  }

  return { ...base, request, ledger, call, capabilities, begin, settle, handoff, checkpoint, restore, execute };
}

function descriptor(capabilityId: string, effect: RoleCapabilityDeclaredEffect, preparedPayloadSource = false): CapabilityDescriptor {
  return { capabilityId, summary: capabilityId, effect, catalogGroups: ["documents"],
    ...(preparedPayloadSource ? { preparedPayloadSource: true as const } : {}),
    controls: { type: "object", additionalProperties: false,
      properties: { path: { type: "string", minLength: 1 } }, required: ["path"] } };
}

function exactSuccess(): CapabilityAdapterResult {
  return { kind: "generic_capability_result_v1", authority: "capability_adapter", status: "executed", ok: true,
    payload: { observation: "Retained canonical evidence." } };
}
