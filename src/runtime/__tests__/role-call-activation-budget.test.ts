import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import {
  createRoleCallLedger,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
  type RoleCallLedger,
  type RoleCallPolicy,
} from "../orchestration/role-calls/index.js";

const MINIMUM_LIMITS: RoleCallPolicy["limits"] = Object.freeze({
  maxDepth: 2,
  maxCalls: 2,
  maxCapabilityExecutions: 1,
  maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
  maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
});

beforeEach(() => {
  configureDebugLogger({ enabled: false });
});

afterEach(() => {
  resetDebugLoggerConfig();
});

describe("canonical role activation budget", () => {
  test("rejects the same over-budget transition for root and delegated calls", async () => {
    const rootLedger = createRootCapabilityLedger();
    await commit(rootLedger, { authority: "runtime", type: "create_root" });
    await commit(rootLedger, {
      authority: "active_role",
      type: "update_capability_scope",
      callId: "call-1",
      invocationAttempt: 1,
      mode: "open",
      catalogGroupIds: ["read"],
    });
    await commit(rootLedger, createRootReconsiderationCommand(2));
    const rootAtLimit = rootLedger.current();
    expect(
      await rootLedger.apply({
        expectedHead: rootAtLimit,
        command: createRootReconsiderationCommand(3),
      }),
    ).toMatchObject({
      ok: false,
      code: "role_activation_limit_exceeded",
      head: rootAtLimit,
      issues: [
        {
          code: "role_activation_limit_exceeded",
          path: "state.calls.call-1.activationCount",
        },
      ],
    });
    expect(rootLedger.current()).toBe(rootAtLimit);

    const delegatedLedger = createDelegatedLedger();
    await commit(delegatedLedger, {
      authority: "runtime",
      type: "create_root",
    });
    await commit(delegatedLedger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: "Perform the bounded task.",
      workerCapabilityScope: { catalogGroupIds: ["read"] },
    });
    await commit(delegatedLedger, createScopeExtensionCommand(1, "system"));
    await commit(delegatedLedger, createScopeExtensionCommand(2, "write"));
    await commit(delegatedLedger, createScopeExtensionCommand(3, "execute"));
    const delegatedAtLimit = delegatedLedger.current();
    expect(
      await delegatedLedger.apply({
        expectedHead: delegatedAtLimit,
        command: createScopeExtensionCommand(4, "network"),
      }),
    ).toMatchObject({
      ok: false,
      code: "role_activation_limit_exceeded",
      head: delegatedAtLimit,
    });
    expect(delegatedLedger.current()).toBe(delegatedAtLimit);
  });

  test("reserves capacity before tool work and always commits its settlement", async () => {
    const ledger = createRootCapabilityLedger(2);
    await commit(ledger, { authority: "runtime", type: "create_root" });
    await commit(ledger, {
      authority: "active_role",
      type: "update_capability_scope",
      callId: "call-1",
      invocationAttempt: 1,
      mode: "open",
      catalogGroupIds: ["read"],
    });
    await commit(ledger, {
      authority: "active_role",
      type: "begin_capability_execution",
      callId: "call-1",
      invocationAttempt: 2,
      capabilityId: "files.read",
      declaredEffect: "observation",
      intent: "Read one bounded file.",
      controlsJson: '{"path":"news.txt"}',
    });
    await commit(ledger, {
      authority: "runtime",
      type: "settle_capability_execution",
      callId: "call-1",
      executionId: "capability-execution-1",
      outcome: "succeeded",
      observedEffect: "observation",
      summary: "Read the file.",
      exactResult: {
        kind: "generic_capability_result_v1",
        authority: "capability_adapter",
        status: "executed",
        ok: true,
        payload: {
          outcome: "succeeded",
          observedEffect: "observation",
          summary: "Read the file.",
        },
      },
    });

    const settled = ledger.current();
    expect(settled.state.calls[0]).toMatchObject({
      activationCount: 3,
      status: "active",
    });
    expect(settled.state.capabilityExecutions[0]).toMatchObject({
      status: "settled",
      summary: "Read the file.",
    });
    await commit(ledger, createRootReconsiderationCommand(3));
    const atLimit = ledger.current();
    expect(atLimit.state.calls[0]?.activationCount).toBe(4);

    expect(
      await ledger.apply({
        expectedHead: atLimit,
        command: {
          authority: "active_role",
          type: "begin_capability_execution",
          callId: "call-1",
          invocationAttempt: 4,
          capabilityId: "files.read",
          declaredEffect: "observation",
          intent: "Read another bounded file.",
          controlsJson: '{"path":"other.txt"}',
        },
      }),
    ).toMatchObject({
      ok: false,
      code: "role_activation_limit_exceeded",
      head: atLimit,
    });
    expect(ledger.current()).toBe(atLimit);

    expect(
      await ledger.apply({
        expectedHead: atLimit,
        command: {
          authority: "active_role",
          type: "begin_capability_execution",
          callId: "missing-call",
          invocationAttempt: 4,
          capabilityId: "files.read",
          declaredEffect: "observation",
          intent: "Invalid owner must remain the primary rejection.",
          controlsJson: '{"path":"other.txt"}',
        },
      }),
    ).toMatchObject({
      ok: false,
      code: "capability_caller_invalid",
      head: atLimit,
    });
  });
});

function createRootCapabilityLedger(
  maxCapabilityExecutions = 1,
): RoleCallLedger {
  return createRoleCallLedger({
    requestId: "root-activation-budget-request",
    policy: {
      authority: {
        id: "execution-agent-v1",
        version: 1,
        definitionHash: `sha256:${"a".repeat(64)}`,
        rootContractId: "execution_agent",
        availableSubordinateContractIds: ["worker"],
        capabilityAuthorities: ["root", "worker"],
      },
      limits: {
        ...MINIMUM_LIMITS,
        maxCalls: 1,
        maxCapabilityExecutions,
      },
    },
  });
}

function createDelegatedLedger(): RoleCallLedger {
  return createRoleCallLedger({
    requestId: "delegated-activation-budget-request",
    policy: {
      authority: SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
      limits: MINIMUM_LIMITS,
    },
  });
}

function createRootReconsiderationCommand(invocationAttempt: number) {
  return {
    authority: "active_role" as const,
    type: "reconsider_capability_selection" as const,
    callId: "call-1",
    invocationAttempt,
    steeringVersion: 0,
    selection: {
      action: "invoke_capability" as const,
      invocations: [
        {
          capabilityId: "files.read",
          intent: "Read the requested file.",
          selectionControlsJson: '{"path":"news.txt"}',
        },
      ],
      workingDirectory: null,
      activeCapabilityCatalogGroupIds: ["read"],
    },
    cause: {
      kind: "refinement_declined" as const,
      entries: [{ invocationIndex: 0, reason: "Guidance mismatch." }],
    },
  };
}

function createScopeExtensionCommand(
  invocationAttempt: number,
  catalogGroupId: string,
) {
  return {
    authority: "active_role" as const,
    type: "update_capability_scope" as const,
    callId: "call-2",
    invocationAttempt,
    mode: "extend" as const,
    catalogGroupIds: [catalogGroupId],
  };
}

async function commit(ledger: RoleCallLedger, command: unknown): Promise<void> {
  const result = await ledger.apply({
    expectedHead: ledger.current(),
    command,
  });
  expect(result).toMatchObject({ ok: true, status: "committed" });
  if (!result.ok) throw new Error(result.code);
}
