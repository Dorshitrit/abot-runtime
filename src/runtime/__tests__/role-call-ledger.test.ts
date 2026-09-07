import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import {
  createRoleCallLedger,
  ROLE_CAPABILITY_EXECUTION_LIMIT_MAX,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  ROLE_CALL_WORKING_DIRECTORY_MAX_LENGTH,
  SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
  normalizeRoleCallWorkingDirectory,
  validateRoleCallCandidate,
  type RoleCallLedger,
  type RoleCallLedgerCommand,
  type RoleCallLedgerHead,
  type RoleCallPolicy,
  type RoleCallState,
} from "../orchestration/role-calls/index.js";

function policy(
  overrides: Partial<RoleCallPolicy["limits"]> = {},
): RoleCallPolicy {
  return {
    authority: SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
    limits: {
      maxDepth: 4,
      maxCalls: 8,
      maxCapabilityExecutions: 16,
      maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
      maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
      maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
      ...overrides,
    },
  };
}

function createLedger(
  overrides: Partial<RoleCallPolicy["limits"]> = {},
): RoleCallLedger {
  return createRoleCallLedger({
    requestId: "role-call-request-1",
    policy: policy(overrides),
  });
}

function createRootCapabilityLedger(): RoleCallLedger {
  return createRoleCallLedger({
    requestId: "role-call-request-1",
    policy: {
      authority: {
        id: "execution-agent-v1",
        version: 1,
        definitionHash: `sha256:${"a".repeat(64)}`,
        rootContractId: "execution_agent",
        availableSubordinateContractIds: ["worker"],
        capabilityAuthorities: ["root", "worker"],
      },
      limits: policy().limits,
    },
  });
}

async function commit(
  ledger: RoleCallLedger,
  command: unknown,
): Promise<RoleCallLedgerHead> {
  const result = await ledger.apply({
    expectedHead: ledger.current(),
    command: withTestCapabilityInvocation(command),
  });
  expect(result).toMatchObject({ ok: true, status: "committed" });
  if (!result.ok) {
    throw new Error(result.code);
  }
  return result.head;
}

function withTestCapabilityInvocation(command: unknown): unknown {
  if (
    typeof command !== "object" ||
    command === null ||
    Array.isArray(command)
  ) {
    return command;
  }
  const record = command as Record<string, unknown>;
  if (record.type === "settle_capability_execution") {
    return {
      ...record,
      exactResult:
        record.exactResult ?? createTestCapabilityResultEnvelope(record),
    };
  }
  if (
    record.type === "settle_capability_batch" &&
    Array.isArray(record.settlements)
  ) {
    return {
      ...record,
      settlements: record.settlements.map((result) =>
        typeof result === "object" && result !== null && !Array.isArray(result)
          ? {
              ...(result as Record<string, unknown>),
              exactResult:
                (result as Record<string, unknown>).exactResult ??
                createTestCapabilityResultEnvelope(
                  result as Record<string, unknown>,
                ),
            }
          : result,
      ),
    };
  }
  if (record.type === "begin_capability_execution") {
    return {
      ...record,
      intent: record.intent ?? "Exercise the exact test capability.",
      controlsJson: record.controlsJson ?? "{}",
    };
  }
  if (
    record.type === "begin_capability_batch" &&
    Array.isArray(record.entries)
  ) {
    return {
      ...record,
      entries: record.entries.map((entry) =>
        typeof entry === "object" && entry !== null && !Array.isArray(entry)
          ? {
              ...(entry as Record<string, unknown>),
              intent:
                (entry as Record<string, unknown>).intent ??
                "Exercise the exact test capability.",
              controlsJson:
                (entry as Record<string, unknown>).controlsJson ?? "{}",
            }
          : entry,
      ),
    };
  }
  return command;
}

function createTestCapabilityResultEnvelope(result: Record<string, unknown>) {
  return {
    kind: "generic_capability_result_v1" as const,
    authority: "capability_adapter" as const,
    status: "executed" as const,
    ok: result.outcome === "succeeded",
    payload: {
      outcome: result.outcome,
      observedEffect: result.observedEffect,
      summary: result.summary,
      ...(typeof result.referenceData === "string"
        ? { referenceData: result.referenceData }
        : {}),
    },
    ...(Array.isArray(result.references)
      ? { references: result.references }
      : {}),
  };
}

beforeEach(() => {
  configureDebugLogger({ enabled: false });
});

afterEach(() => {
  resetDebugLoggerConfig();
});

describe("canonical role-call ledger", () => {
  test("freezes one serializable supervisor-worker-v1 authority snapshot", () => {
    const authority = createLedger().current().policy.authority;

    expect(authority).toEqual({
      id: "supervisor-worker-v1",
      version: 2,
      definitionHash:
        "sha256:2ee79cee6dbb27ffaeb59f84c4c838cf9d16a965ca4f07e7d638e8589868e036",
      rootContractId: "supervisor",
      availableSubordinateContractIds: ["planner", "worker", "reviewer"],
      capabilityAuthorities: ["worker"],
    });
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Object.isFrozen(authority.availableSubordinateContractIds)).toBe(
      true,
    );
    expect(Object.isFrozen(authority.capabilityAuthorities)).toBe(true);
    expect(JSON.parse(JSON.stringify(authority))).toEqual(authority);
  });

  test("rejects malformed execution authority before creating a canonical head", () => {
    expect(() =>
      createRoleCallLedger({
        requestId: "role-call-request-1",
        policy: {
          ...policy(),
          authority: {
            ...SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
            definitionHash: "not-a-definition-hash",
          },
        },
      }),
    ).toThrow("Cannot create a role-call ledger head");
  });

  test("keeps the canonical root frame separate from its model contract and updates authorized scope atomically", async () => {
    const ledger = createRootCapabilityLedger();
    const rooted = await commit(ledger, {
      authority: "runtime",
      type: "create_root",
    });

    expect(rooted.policy.authority.rootContractId).toBe("execution_agent");
    expect(rooted.state.calls[0]).toMatchObject({
      callId: "call-1",
      parentCallId: null,
      roleId: "supervisor",
      depth: 0,
      activationCount: 1,
    });
    expect(
      validateRoleCallCandidate({ state: rooted.state, policy: rooted.policy }),
    ).toEqual([]);

    const opened = await ledger.apply({
      expectedHead: rooted,
      command: {
        authority: "active_role",
        type: "update_capability_scope",
        callId: "call-1",
        invocationAttempt: 1,
        mode: "open",
        catalogGroupIds: ["read"],
      },
    });
    expect(opened).toMatchObject({
      ok: true,
      effect: {
        type: "capability_scope_updated",
        callId: "call-1",
        mode: "open",
        catalogGroupIds: ["read"],
      },
      head: {
        state: {
          calls: [
            {
              roleId: "supervisor",
              activationCount: 2,
              workerCapabilityScope: { catalogGroupIds: ["read"] },
            },
          ],
        },
      },
    });
    if (!opened.ok) throw new Error(opened.code);

    const beforeRepeatedOpen = opened.head;
    expect(
      await ledger.apply({
        expectedHead: beforeRepeatedOpen,
        command: {
          authority: "active_role",
          type: "update_capability_scope",
          callId: "call-1",
          invocationAttempt: 2,
          mode: "open",
          catalogGroupIds: ["write"],
        },
      }),
    ).toMatchObject({
      ok: false,
      code: "capability_scope_update_invalid",
      head: beforeRepeatedOpen,
    });
    expect(ledger.current()).toBe(beforeRepeatedOpen);

    const extended = await ledger.apply({
      expectedHead: beforeRepeatedOpen,
      command: {
        authority: "active_role",
        type: "update_capability_scope",
        callId: "call-1",
        invocationAttempt: 2,
        mode: "extend",
        catalogGroupIds: ["write"],
      },
    });
    expect(extended).toMatchObject({
      ok: true,
      effect: {
        type: "capability_scope_updated",
        callId: "call-1",
        mode: "extend",
        catalogGroupIds: ["read", "write"],
      },
      head: {
        state: {
          calls: [
            {
              activationCount: 3,
              workerCapabilityScope: {
                catalogGroupIds: ["read", "write"],
              },
            },
          ],
        },
      },
    });
    if (!extended.ok) throw new Error(extended.code);

    const beforeOverlappingExtend = extended.head;
    expect(
      await ledger.apply({
        expectedHead: beforeOverlappingExtend,
        command: {
          authority: "active_role",
          type: "update_capability_scope",
          callId: "call-1",
          invocationAttempt: 3,
          mode: "extend",
          catalogGroupIds: ["read"],
        },
      }),
    ).toMatchObject({
      ok: false,
      code: "capability_scope_update_invalid",
      head: beforeOverlappingExtend,
    });
    expect(ledger.current()).toBe(beforeOverlappingExtend);
  });

  test("records one canonical capability-selection reconsideration and resumes through a new activation", async () => {
    const ledger = createRootCapabilityLedger();
    await commit(ledger, { authority: "runtime", type: "create_root" });
    await commit(ledger, {
      authority: "active_role",
      type: "update_capability_scope",
      callId: "call-1",
      invocationAttempt: 1,
      mode: "open",
      catalogGroupIds: ["read"],
    });
    const before = ledger.current();
    const selection = {
      action: "invoke_capability" as const,
      invocations: [
        {
          capabilityId: "files.read",
          intent: "Read the requested file.",
          selectionControlsJson: '{"path":"news.txt"}',
        },
      ],
      workingDirectory: "project",
      activeCapabilityCatalogGroupIds: ["read"],
    };
    const cause = {
      kind: "refinement_declined" as const,
      entries: [
        {
          invocationIndex: 0,
          reason: "The capability guidance does not match the request.",
        },
      ],
    };

    const reconsidered = await ledger.apply({
      expectedHead: before,
      command: {
        authority: "active_role",
        type: "reconsider_capability_selection",
        callId: "call-1",
        invocationAttempt: 2,
        steeringVersion: 0,
        selection,
        cause,
      },
    });

    expect(reconsidered).toMatchObject({
      ok: true,
      effect: {
        type: "capability_selection_reconsidered",
        callId: "call-1",
        invocationAttempt: 2,
        fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
      head: {
        state: {
          calls: [
            {
              callId: "call-1",
              activationCount: 3,
              lastCapabilitySelectionReconsideration: {
                invocationAttempt: 2,
                steeringVersion: 0,
                fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
                selection,
                cause,
              },
            },
          ],
          capabilityExecutions: [],
        },
      },
    });
    if (!reconsidered.ok) throw new Error(reconsidered.code);
    expect(
      validateRoleCallCandidate({
        state: reconsidered.head.state,
        policy: reconsidered.head.policy,
      }),
    ).toEqual([]);
    expect(
      Object.isFrozen(
        reconsidered.head.state.calls[0]?.lastCapabilitySelectionReconsideration
          ?.selection.invocations,
      ),
    ).toBe(true);

    expect(
      await ledger.apply({
        expectedHead: reconsidered.head,
        command: {
          authority: "active_role",
          type: "reconsider_capability_selection",
          callId: "call-1",
          invocationAttempt: 2,
          steeringVersion: 0,
          selection,
          cause,
        },
      }),
    ).toMatchObject({
      ok: false,
      code: "capability_selection_reconsideration_invalid",
    });

    const defaultLedger = createLedger();
    await commit(defaultLedger, { authority: "runtime", type: "create_root" });
    expect(
      await defaultLedger.apply({
        expectedHead: defaultLedger.current(),
        command: {
          authority: "active_role",
          type: "reconsider_capability_selection",
          callId: "call-1",
          invocationAttempt: 1,
          steeringVersion: 0,
          selection,
          cause,
        },
      }),
    ).toMatchObject({
      ok: false,
      code: "capability_selection_reconsideration_invalid",
    });
  });

  test("establishes one strict immutable root working directory without consuming an activation", async () => {
    const legacyLedger = createLedger();
    const legacyRooted = await commit(legacyLedger, {
      authority: "runtime",
      type: "create_root",
    });
    expect(
      await legacyLedger.apply({
        expectedHead: legacyRooted,
        command: {
          authority: "active_role",
          type: "establish_working_directory",
          callId: "call-1",
          invocationAttempt: 1,
          workingDirectory: "project/site",
        },
      }),
    ).toMatchObject({
      ok: false,
      code: "working_directory_establishment_invalid",
      head: legacyRooted,
    });

    const ledger = createRootCapabilityLedger();
    const rooted = await commit(ledger, {
      authority: "runtime",
      type: "create_root",
    });

    expect(
      await ledger.apply({
        expectedHead: rooted,
        command: {
          authority: "active_role",
          type: "establish_working_directory",
          callId: "call-1",
          invocationAttempt: 2,
          workingDirectory: "project/site",
        },
      }),
    ).toMatchObject({
      ok: false,
      code: "working_directory_establishment_invalid",
      head: rooted,
    });

    expect(
      await ledger.apply({
        expectedHead: rooted,
        command: {
          authority: "active_role",
          type: "establish_working_directory",
          callId: "call-1",
          invocationAttempt: 1,
          workingDirectory: "project;echo-invalid",
        },
      }),
    ).toMatchObject({ ok: false, code: "invalid_command", head: rooted });

    const established = await ledger.apply({
      expectedHead: rooted,
      command: {
        authority: "active_role",
        type: "establish_working_directory",
        callId: "call-1",
        invocationAttempt: 1,
        workingDirectory: "./project/site",
      },
    });
    expect(established).toMatchObject({
      ok: true,
      effect: { type: "working_directory_established", callId: "call-1" },
      head: {
        state: {
          calls: [
            {
              roleId: "supervisor",
              activationCount: 1,
              workingDirectory: "project/site",
            },
          ],
        },
      },
    });
    if (!established.ok) throw new Error(established.code);

    expect(
      await ledger.apply({
        expectedHead: established.head,
        command: {
          authority: "active_role",
          type: "establish_working_directory",
          callId: "call-1",
          invocationAttempt: 1,
          workingDirectory: "other",
        },
      }),
    ).toMatchObject({
      ok: false,
      code: "working_directory_establishment_invalid",
      head: established.head,
    });

    const candidate = structuredClone(established.head.state);
    const mutableCandidateCalls = candidate.calls as unknown as Array<{
      workingDirectory?: string;
    }>;
    mutableCandidateCalls[0]!.workingDirectory = "project && invalid";
    expect(
      validateRoleCallCandidate({
        state: candidate,
        policy: established.head.policy,
      }),
    ).toContainEqual({
      code: "invalid_role_call_frame",
      path: "state.calls.call-1",
    });
  });

  test("keeps normalized terminal text as the default and preserves exact policy text", async () => {
    const normalizedLedger = createLedger();
    await commit(normalizedLedger, {
      authority: "runtime",
      type: "create_root",
    });
    const normalized = await commit(normalizedLedger, {
      authority: "supervisor",
      type: "complete_root_response",
      callId: "call-1",
      response: "  normalized response\n\t",
    });
    expect(normalized.state.rootResponse).toBe("normalized response");
    expect(normalized.policy.authority).not.toHaveProperty("terminalTextMode");

    const exactLedger = createRoleCallLedger({
      requestId: "exact-terminal-text-request",
      policy: {
        authority: {
          ...createRootCapabilityLedger().current().policy.authority,
          terminalTextMode: "exact",
        },
        limits: policy().limits,
      },
    });
    await commit(exactLedger, {
      authority: "runtime",
      type: "create_root",
    });
    const raw = "  exact response\n\t";
    const exact = await commit(exactLedger, {
      authority: "supervisor",
      type: "complete_root_response",
      callId: "call-1",
      response: raw,
    });
    expect(exact.state.rootResponse).toBe(raw);

    const blankLedger = createRoleCallLedger({
      requestId: "blank-exact-terminal-text-request",
      policy: {
        authority: exact.policy.authority,
        limits: policy().limits,
      },
    });
    await commit(blankLedger, {
      authority: "runtime",
      type: "create_root",
    });
    expect(
      await blankLedger.apply({
        expectedHead: blankLedger.current(),
        command: {
          authority: "supervisor",
          type: "complete_root_response",
          callId: "call-1",
          response: " \n\t ",
        },
      }),
    ).toMatchObject({ ok: false, code: "invalid_command" });
  });

  test("applies the same capability-scope transition contract to an authorized Worker", async () => {
    const ledger = createLedger();
    await commit(ledger, { authority: "runtime", type: "create_root" });
    const workerHead = await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: "Observe one bounded value.",
    });

    const scoped = await ledger.apply({
      expectedHead: workerHead,
      command: {
        authority: "active_role",
        type: "update_capability_scope",
        callId: "call-2",
        invocationAttempt: 1,
        mode: "open",
        catalogGroupIds: ["read"],
      },
    });
    expect(scoped).toMatchObject({
      ok: true,
      effect: {
        type: "capability_scope_updated",
        callId: "call-2",
        mode: "open",
        catalogGroupIds: ["read"],
      },
      head: {
        state: {
          calls: [
            {},
            {
              roleId: "worker",
              activationCount: 2,
              workerCapabilityScope: { catalogGroupIds: ["read"] },
            },
          ],
        },
      },
    });
  });

  test("rejects unauthorized child and capability transitions atomically", async () => {
    const childLedger = createLedger();
    await commit(childLedger, { authority: "runtime", type: "create_root" });
    const beforeChild = childLedger.current();
    expect(
      await childLedger.apply({
        expectedHead: beforeChild,
        command: {
          authority: "active_role",
          type: "open_child",
          callerCallId: "call-1",
          roleId: "researcher",
          objective: "Attempt an unavailable policy contract.",
        },
      }),
    ).toMatchObject({
      ok: false,
      code: "child_role_not_authorized",
      head: beforeChild,
    });
    expect(childLedger.current()).toBe(beforeChild);

    const rootCapabilityHead = childLedger.current();
    expect(
      await childLedger.apply({
        expectedHead: rootCapabilityHead,
        command: {
          authority: "active_role",
          type: "begin_capability_execution",
          callId: "call-1",
          invocationAttempt: 1,
          capabilityId: "example.observe",
          declaredEffect: "observation",
          intent: "Attempt the unauthorized root capability.",
          controlsJson: "{}",
        },
      }),
    ).toMatchObject({
      ok: false,
      code: "capability_caller_invalid",
      head: rootCapabilityHead,
    });
    expect(childLedger.current()).toBe(rootCapabilityHead);

    await commit(childLedger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "planner",
      objective: "Plan without capability ownership.",
    });
    const plannerCapabilityHead = childLedger.current();
    expect(
      await childLedger.apply({
        expectedHead: plannerCapabilityHead,
        command: {
          authority: "active_role",
          type: "begin_capability_execution",
          callId: "call-2",
          invocationAttempt: 1,
          capabilityId: "example.observe",
          declaredEffect: "observation",
          intent: "Attempt the unauthorized Planner capability.",
          controlsJson: "{}",
        },
      }),
    ).toMatchObject({
      ok: false,
      code: "capability_caller_invalid",
      head: plannerCapabilityHead,
    });
    expect(childLedger.current()).toBe(plannerCapabilityHead);
  });

  test("keeps root terminal authority exclusive and atomic", async () => {
    const ledger = createLedger();
    await commit(ledger, { authority: "runtime", type: "create_root" });
    const rootHead = ledger.current();
    expect(
      await ledger.apply({
        expectedHead: rootHead,
        command: {
          authority: "active_role",
          type: "complete_root_response",
          callId: "call-1",
          response: "Unauthorized terminal output.",
        } as unknown as RoleCallLedgerCommand,
      }),
    ).toMatchObject({ ok: false, code: "invalid_command", head: rootHead });
    expect(ledger.current()).toBe(rootHead);

    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: "Perform one bounded child task.",
    });
    const childHead = ledger.current();
    expect(
      await ledger.apply({
        expectedHead: childHead,
        command: {
          authority: "supervisor",
          type: "complete_root_response",
          callId: "call-1",
          response: "Premature terminal output.",
        },
      }),
    ).toMatchObject({
      ok: false,
      code: "root_response_not_allowed",
      head: childHead,
    });
    expect(ledger.current()).toBe(childHead);
  });

  test("candidate validation enforces child and capability authority", async () => {
    const childLedger = createLedger();
    await commit(childLedger, { authority: "runtime", type: "create_root" });
    await commit(childLedger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "reviewer",
      objective: "Review the bounded result.",
    });
    const childHead = childLedger.current();
    const unauthorizedChildState = structuredClone(childHead.state);
    const mutableChildCalls = unauthorizedChildState.calls as unknown as Array<{
      roleId: string;
    }>;
    mutableChildCalls[1]!.roleId = "researcher";
    expect(
      validateRoleCallCandidate({
        state: unauthorizedChildState,
        policy: childHead.policy,
      }),
    ).toContainEqual({
      code: "unauthorized_role_call_contract",
      path: "state.calls.call-2.roleId",
    });

    const capabilityLedger = createLedger();
    await commit(capabilityLedger, {
      authority: "runtime",
      type: "create_root",
    });
    await commit(capabilityLedger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: "Observe one bounded value.",
    });
    await commit(capabilityLedger, {
      authority: "active_role",
      type: "begin_capability_execution",
      callId: "call-2",
      invocationAttempt: 1,
      capabilityId: "example.observe",
      declaredEffect: "observation",
      intent: "  Read the exact current value.  ",
      controlsJson: '{"path":"project/a.txt","depth":2}',
    });
    const capabilityHead = capabilityLedger.current();
    const unauthorizedCapabilityState = structuredClone(capabilityHead.state);
    const mutableCapabilityCalls =
      unauthorizedCapabilityState.calls as unknown as Array<{
        roleId: string;
      }>;
    mutableCapabilityCalls[1]!.roleId = "reviewer";
    expect(
      validateRoleCallCandidate({
        state: unauthorizedCapabilityState,
        policy: capabilityHead.policy,
      }),
    ).toContainEqual({
      code: "invalid_role_capability_execution",
      path: "state.capabilityExecutions.capability-execution-1",
    });
  });

  test("rejects an unbounded capability-execution policy", () => {
    expect(() =>
      createRoleCallLedger({
        requestId: "role-call-request-1",
        policy: policy({
          maxCapabilityExecutions: ROLE_CAPABILITY_EXECUTION_LIMIT_MAX + 1,
        }),
      }),
    ).toThrow("Cannot create a role-call ledger head");
  });

  test("creates one immutable Supervisor root and commits its response", async () => {
    const ledger = createLedger();
    const initial = ledger.current();
    const rooted = await commit(ledger, {
      authority: "runtime",
      type: "create_root",
    });

    expect(initial.revision).toBe(0);
    expect(rooted).toMatchObject({
      revision: 1,
      state: {
        requestId: "role-call-request-1",
        phase: "running",
        rootCallId: "call-1",
        activeCallId: "call-1",
        rootResponse: null,
        calls: [
          {
            callId: "call-1",
            parentCallId: null,
            roleId: "supervisor",
            depth: 0,
            objective: null,
            dependencyResultRefs: [],
            status: "active",
            childCallIds: [],
            activationCount: 1,
            resultRef: null,
          },
        ],
      },
    });
    expect(Object.isFrozen(rooted)).toBe(true);
    expect(Object.isFrozen(rooted.state)).toBe(true);
    expect(Object.isFrozen(rooted.state.calls)).toBe(true);
    expect(Object.isFrozen(rooted.state.calls[0])).toBe(true);

    const completed = await commit(ledger, {
      authority: "supervisor",
      type: "complete_root_response",
      callId: "call-1",
      response: "The final answer.",
    });
    expect(completed).toMatchObject({
      revision: 2,
      state: {
        phase: "completed",
        activeCallId: null,
        rootResponse: "The final answer.",
        calls: [{ status: "completed" }],
      },
    });
  });

  test("returns nested repeated-role results to the exact caller", async () => {
    const ledger = createLedger();
    await commit(ledger, { authority: "runtime", type: "create_root" });
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "planner",
      objective: "Coordinate the requested outcome.",
    });
    const nested = await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-2",
      roleId: "planner",
      objective: "Plan one bounded sub-process.",
      plannerPlan: {
        mode: "declare",
        plan: {
          summary: "Coordinate the requested outcome.",
          items: [
            {
              title: "Plan bounded sub-process",
              objective: "Plan one bounded sub-process.",
            },
          ],
        },
        selectedItemIndexes: [0],
      },
    });

    expect(nested.state).toMatchObject({
      activeCallId: "call-3",
      calls: [
        { callId: "call-1", status: "waiting_for_child" },
        { callId: "call-2", status: "waiting_for_child" },
        {
          callId: "call-3",
          parentCallId: "call-2",
          roleId: "planner",
          depth: 2,
          status: "active",
        },
      ],
    });

    const firstReturn = await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-2",
      childCallId: "call-3",
      outcome: "completed",
      summary: "Nested planning completed.",
    });
    expect(firstReturn.state).toMatchObject({
      activeCallId: "call-2",
      calls: [
        {},
        { callId: "call-2", status: "active", activationCount: 2 },
        { callId: "call-3", status: "completed", resultRef: "result-1" },
      ],
      results: [
        {
          resultRef: "result-1",
          producerCallId: "call-3",
          roleId: "planner",
          outcome: "completed",
        },
      ],
    });

    const rootReturn = await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-1",
      childCallId: "call-2",
      outcome: "completed",
      summary: "The coordinated process completed.",
    });
    expect(rootReturn.state).toMatchObject({
      activeCallId: "call-1",
      calls: [
        { callId: "call-1", status: "active", activationCount: 2 },
        { callId: "call-2", status: "completed", resultRef: "result-2" },
        { callId: "call-3", status: "completed", resultRef: "result-1" },
      ],
      results: [{ resultRef: "result-1" }, { resultRef: "result-2" }],
    });
  });

  test("stores only canonical direct-child result dependencies on a new child", async () => {
    const ledger = createLedger();
    await commit(ledger, { authority: "runtime", type: "create_root" });
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "planner",
      objective: "Coordinate one observed fact and one mutation.",
    });
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-2",
      roleId: "worker",
      objective: "Establish the required current fact.",
      plannerPlan: {
        mode: "declare",
        plan: {
          summary: "Coordinate one observed fact and one mutation.",
          items: [
            {
              title: "Establish current fact",
              objective: "Establish the required current fact.",
            },
            {
              title: "Apply remaining mutation",
              objective: "Apply the remaining mutation.",
            },
          ],
        },
        selectedItemIndexes: [0],
      },
    });
    await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-2",
      childCallId: "call-3",
      outcome: "completed",
      summary: "The current fact was observed and established.",
    });

    const beforeInvalid = ledger.current();
    const invalid = await ledger.apply({
      expectedHead: beforeInvalid,
      command: {
        authority: "active_role",
        type: "open_child",
        callerCallId: "call-2",
        roleId: "worker",
        objective: "Apply the remaining mutation.",
        dependencyResultRefs: ["result-999"],
        plannerPlan: {
          mode: "select",
          itemIds: ["plan-call-2-item-2"],
        },
      },
    });
    expect(invalid).toMatchObject({
      ok: false,
      status: "rejected",
      code: "child_dependency_invalid",
    });
    expect(ledger.current()).toBe(beforeInvalid);

    const opened = await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-2",
      roleId: "worker",
      objective: "Apply the remaining mutation.",
      dependencyResultRefs: ["result-1"],
      plannerPlan: {
        mode: "select",
        itemIds: ["plan-call-2-item-2"],
      },
    });
    expect(
      opened.state.calls.find(({ callId }) => callId === "call-4"),
    ).toEqual(
      expect.objectContaining({
        parentCallId: "call-2",
        roleId: "worker",
        dependencyResultRefs: ["result-1"],
      }),
    );
  });

  test("rejects stale and structurally cloned heads without changing revision", async () => {
    const ledger = createLedger();
    const initial = ledger.current();
    const rooted = await commit(ledger, {
      authority: "runtime",
      type: "create_root",
    });

    const stale = await ledger.apply({
      expectedHead: initial,
      command: {
        authority: "supervisor",
        type: "complete_root_response",
        callId: "call-1",
        response: "No.",
      },
    });
    const clone = await ledger.apply({
      expectedHead: structuredClone(rooted),
      command: {
        authority: "supervisor",
        type: "complete_root_response",
        callId: "call-1",
        response: "No.",
      },
    });

    expect(stale).toMatchObject({
      ok: false,
      code: "stale_head",
      head: { revision: 1 },
    });
    expect(clone).toMatchObject({
      ok: false,
      code: "invalid_expected_head",
      head: { revision: 1 },
    });
    expect(ledger.current()).toBe(rooted);
  });

  test("rejects invalid ownership and command shapes at the same head", async () => {
    const ledger = createLedger();
    await commit(ledger, { authority: "runtime", type: "create_root" });
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: "Perform the bounded work.",
    });
    const head = ledger.current();

    const inactiveCaller = await ledger.apply({
      expectedHead: head,
      command: {
        authority: "active_role",
        type: "open_child",
        callerCallId: "call-1",
        roleId: "reviewer",
        objective: "Review the result.",
      },
    });
    const mismatchedReturn = await ledger.apply({
      expectedHead: head,
      command: {
        authority: "runtime",
        type: "return_child",
        callerCallId: "call-other",
        childCallId: "call-2",
        outcome: "completed",
        summary: "Done.",
      },
    });
    const supervisorChild = await ledger.apply({
      expectedHead: head,
      command: {
        authority: "active_role",
        type: "open_child",
        callerCallId: "call-2",
        roleId: "supervisor",
        objective: "Re-enter the root.",
      },
    });
    const extraField = await ledger.apply({
      expectedHead: head,
      command: {
        authority: "runtime",
        type: "return_child",
        callerCallId: "call-1",
        childCallId: "call-2",
        outcome: "completed",
        summary: "Done.",
        response: "Not allowed.",
      },
    });

    expect(inactiveCaller).toMatchObject({
      ok: false,
      code: "caller_not_active",
    });
    expect(mismatchedReturn).toMatchObject({
      ok: false,
      code: "child_return_mismatch",
    });
    expect(supervisorChild).toMatchObject({
      ok: false,
      code: "supervisor_child_forbidden",
    });
    expect(extraField).toMatchObject({
      ok: false,
      code: "invalid_command",
    });
    expect(ledger.current()).toBe(head);
  });

  test("enforces depth and call-count limits without semantic routing", async () => {
    const depthLedger = createLedger({ maxDepth: 1, maxCalls: 4 });
    await commit(depthLedger, { authority: "runtime", type: "create_root" });
    await commit(depthLedger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "planner",
      objective: "Coordinate the request.",
    });
    expect(
      await depthLedger.apply({
        expectedHead: depthLedger.current(),
        command: {
          authority: "active_role",
          type: "open_child",
          callerCallId: "call-2",
          roleId: "worker",
          objective: "Perform a nested task.",
        },
      }),
    ).toMatchObject({ ok: false, code: "depth_limit_exceeded" });

    const callLedger = createLedger({ maxDepth: 4, maxCalls: 2 });
    await commit(callLedger, { authority: "runtime", type: "create_root" });
    await commit(callLedger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "planner",
      objective: "Coordinate the request.",
    });
    expect(
      await callLedger.apply({
        expectedHead: callLedger.current(),
        command: {
          authority: "active_role",
          type: "open_child",
          callerCallId: "call-2",
          roleId: "worker",
          objective: "Perform a nested task.",
        },
      }),
    ).toMatchObject({ ok: false, code: "call_limit_exceeded" });
  });

  test("publishes the exact transition only after its canonical head advances", async () => {
    const ledger = createLedger();
    const observations: unknown[] = [];
    const observer = vi.fn((committed) => {
      observations.push(committed, ledger.current());
    });
    ledger.commits.subscribe(observer);

    const result = await ledger.apply({
      expectedHead: ledger.current(),
      command: { authority: "runtime", type: "create_root" },
    });

    expect(result).toMatchObject({
      ok: true,
      status: "committed",
      previousHead: { revision: 0 },
      head: { revision: 1 },
      effect: { type: "root_created", callId: "call-1" },
    });
    if (!result.ok) {
      throw new Error(result.code);
    }
    expect(observer).toHaveBeenCalledTimes(1);
    expect(observations).toEqual([
      expect.objectContaining({
        ok: true,
        status: "committed",
        previousHead: result.previousHead,
        head: result.head,
        effect: result.effect,
      }),
      result.head,
    ]);
    expect(Object.isFrozen(result.effect)).toBe(true);
  });

  test("reports synchronous-observer faults after commit and still notifies later observers", async () => {
    const ledger = createLedger();
    const initial = ledger.current();
    const faultingObserver = vi.fn(() =>
      Promise.reject(new Error("private observer failure")),
    );
    const continuingObserver = vi.fn();
    ledger.commits.subscribe(faultingObserver);
    ledger.commits.subscribe(continuingObserver);

    const result = await ledger.apply({
      expectedHead: initial,
      command: { authority: "runtime", type: "create_root" },
    });

    expect(result).toMatchObject({
      ok: false,
      status: "committed_with_fault",
      code: "after_commit_fault",
      previousHead: initial,
      head: { revision: 1 },
      effect: { type: "root_created", callId: "call-1" },
    });
    expect(ledger.current()).toBe(result.head);
    expect(faultingObserver).toHaveBeenCalledTimes(1);
    expect(continuingObserver).toHaveBeenCalledTimes(1);
    expect(
      await ledger.apply({
        expectedHead: initial,
        command: {
          authority: "supervisor",
          type: "complete_root_response",
          callId: "call-1",
          response: "Not admitted from the stale head.",
        },
      }),
    ).toMatchObject({
      ok: false,
      status: "rejected",
      code: "stale_head",
      head: result.head,
    });
    expect(faultingObserver).toHaveBeenCalledTimes(1);
    expect(continuingObserver).toHaveBeenCalledTimes(1);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

  test("returns a failed child to its caller and lets the caller decide next", async () => {
    const ledger = createLedger();
    await commit(ledger, { authority: "runtime", type: "create_root" });
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "reviewer",
      objective: "Analyze the supplied context.",
    });
    const returned = await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-1",
      childCallId: "call-2",
      outcome: "failed",
      summary: "The role could not produce a grounded result.",
    });

    expect(returned.state).toMatchObject({
      phase: "running",
      activeCallId: "call-1",
      calls: [
        { callId: "call-1", status: "active", activationCount: 2 },
        { callId: "call-2", status: "completed", resultRef: "result-1" },
      ],
      results: [{ outcome: "failed" }],
      rootResponse: null,
    });
  });

  test("normalizes only bounded agent-work-directory-relative working directories", () => {
    expect(normalizeRoleCallWorkingDirectory(".")).toBe(".");
    expect(
      normalizeRoleCallWorkingDirectory("  ./project\\site//assets/.  "),
    ).toBe("project/site/assets");
    expect(normalizeRoleCallWorkingDirectory("project")).toBe("project");

    for (const invalid of [
      "",
      "   ",
      "/absolute",
      "C:\\absolute",
      ".\\C:\\absolute",
      "\\\\server\\share",
      "..",
      "project/../other",
      `project/${"x".repeat(ROLE_CALL_WORKING_DIRECTORY_MAX_LENGTH)}`,
    ]) {
      expect(normalizeRoleCallWorkingDirectory(invalid)).toBeUndefined();
    }
  });

  test("stores immutable Worker scope and working directory across capability activation", async () => {
    const ledger = createLedger();
    await commit(ledger, { authority: "runtime", type: "create_root" });
    const opened = await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: "Observe one bounded value.",
      workerCapabilityScope: {
        catalogGroupIds: ["read", "system"],
      },
      workingDirectory: " ./project\\site//. ",
    });
    const openedWorker = opened.state.calls[1]!;

    expect(opened.state.contractVersion).toBe(18);
    expect(openedWorker.workerCapabilityScope).toEqual({
      catalogGroupIds: ["read", "system"],
    });
    expect(Object.isFrozen(openedWorker.workerCapabilityScope)).toBe(true);
    expect(
      Object.isFrozen(openedWorker.workerCapabilityScope?.catalogGroupIds),
    ).toBe(true);
    expect(openedWorker.workingDirectory).toBe("project/site");
    expect(Object.isFrozen(openedWorker)).toBe(true);

    const begun = await commit(ledger, {
      authority: "active_role",
      type: "begin_capability_execution",
      callId: "call-2",
      invocationAttempt: 1,
      capabilityId: "example.observe",
      declaredEffect: "observation",
    });
    expect(begun.state.calls[1]?.workerCapabilityScope).toEqual(
      openedWorker.workerCapabilityScope,
    );
    expect(begun.state.calls[1]?.workingDirectory).toBe("project/site");

    const settled = await commit(ledger, {
      authority: "runtime",
      type: "settle_capability_execution",
      callId: "call-2",
      executionId: "capability-execution-1",
      outcome: "succeeded",
      observedEffect: "observation",
      summary: "Observed.",
    });
    expect(settled.state.calls[1]).toMatchObject({
      callId: "call-2",
      activationCount: 2,
      status: "active",
      workerCapabilityScope: {
        catalogGroupIds: ["read", "system"],
      },
      workingDirectory: "project/site",
    });
    expect(
      Object.isFrozen(
        settled.state.calls[1]?.workerCapabilityScope?.catalogGroupIds,
      ),
    ).toBe(true);
  });

  test("stores and preserves one immutable Planner working directory across child resume", async () => {
    const ledger = createLedger();
    await commit(ledger, { authority: "runtime", type: "create_root" });
    const openedPlannerHead = await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "planner",
      objective: "Coordinate one bounded project outcome.",
      workingDirectory: " ./project\\site//. ",
    });
    const openedPlanner = openedPlannerHead.state.calls[1]!;

    expect(openedPlanner).toMatchObject({
      callId: "call-2",
      roleId: "planner",
      workingDirectory: "project/site",
      status: "active",
      activationCount: 1,
    });
    expect(Object.isFrozen(openedPlanner)).toBe(true);

    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-2",
      roleId: "worker",
      objective: "Produce the bounded project artifact.",
      workingDirectory: openedPlanner.workingDirectory,
      plannerPlan: {
        mode: "declare",
        plan: {
          summary: "Produce the bounded project artifact.",
          items: [
            {
              title: "Produce project artifact",
              objective: "Produce the bounded project artifact.",
            },
          ],
        },
        selectedItemIndexes: [0],
      },
    });
    const resumed = await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-2",
      childCallId: "call-3",
      outcome: "completed",
      summary: "The bounded artifact was produced.",
    });

    expect(resumed.state.calls[1]).toMatchObject({
      callId: "call-2",
      roleId: "planner",
      workingDirectory: "project/site",
      status: "active",
      activationCount: 2,
    });
    expect(resumed.state.calls[2]).toMatchObject({
      callId: "call-3",
      roleId: "worker",
      workingDirectory: "project/site",
      status: "completed",
    });
  });

  test("rejects malformed Worker metadata and working directories on unsupported child roles", async () => {
    const ledger = createLedger();
    const rooted = await commit(ledger, {
      authority: "runtime",
      type: "create_root",
    });
    const invalidCommands = [
      {
        authority: "active_role",
        type: "open_child",
        callerCallId: "call-1",
        roleId: "researcher",
        objective: "Analyze supplied context.",
        workerCapabilityScope: { catalogGroupIds: ["read"] },
      },
      {
        authority: "active_role",
        type: "open_child",
        callerCallId: "call-1",
        roleId: "researcher",
        objective: "Analyze supplied context.",
        workingDirectory: "project/site",
      },
      {
        authority: "active_role",
        type: "open_child",
        callerCallId: "call-1",
        roleId: "reviewer",
        objective: "Review supplied work.",
        workingDirectory: "project/site",
      },
      {
        authority: "active_role",
        type: "open_child",
        callerCallId: "call-1",
        roleId: "worker",
        objective: "Observe one bounded value.",
        workingDirectory: "project/../other",
      },
      {
        authority: "active_role",
        type: "open_child",
        callerCallId: "call-1",
        roleId: "worker",
        objective: "Observe one bounded value.",
        workerCapabilityScope: { catalogGroupIds: [] },
      },
      {
        authority: "active_role",
        type: "open_child",
        callerCallId: "call-1",
        roleId: "worker",
        objective: "Observe one bounded value.",
        workerCapabilityScope: { catalogGroupIds: ["read", "read"] },
      },
      {
        authority: "active_role",
        type: "open_child",
        callerCallId: "call-1",
        roleId: "worker",
        objective: "Observe one bounded value.",
        workerCapabilityScope: { catalogGroupIds: ["Invalid Group"] },
      },
    ];

    for (const command of invalidCommands) {
      await expect(
        ledger.apply({ expectedHead: rooted, command }),
      ).resolves.toMatchObject({ ok: false, code: "invalid_command" });
      expect(ledger.current()).toBe(rooted);
    }
  });

  test("canonically begins and settles one exact Worker capability activation", async () => {
    const ledger = createLedger();
    await commit(ledger, { authority: "runtime", type: "create_root" });
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: "Observe one bounded value.",
    });

    const begun = await commit(ledger, {
      authority: "active_role",
      type: "begin_capability_execution",
      callId: "call-2",
      invocationAttempt: 1,
      capabilityId: "example.observe",
      declaredEffect: "observation",
      intent: "  Read the exact current value.  ",
      controlsJson: '{"path":"project/a.txt","depth":2}',
    });
    expect(begun).toMatchObject({
      revision: 3,
      state: {
        activeCallId: "call-2",
        capabilityExecutionSequence: 1,
        calls: [
          {},
          {
            callId: "call-2",
            status: "waiting_for_capability",
            activationCount: 1,
          },
        ],
        capabilityExecutions: [
          {
            executionId: "capability-execution-1",
            callId: "call-2",
            invocationAttempt: 1,
            capabilityId: "example.observe",
            declaredEffect: "observation",
            intent: "Read the exact current value.",
            controlsJson: '{"path":"project/a.txt","depth":2}',
            status: "running",
            outcome: null,
            observedEffect: null,
            summary: null,
          },
        ],
      },
    });
    expect(Object.isFrozen(begun.state.capabilityExecutions)).toBe(true);
    expect(Object.isFrozen(begun.state.capabilityExecutions[0])).toBe(true);

    const settled = await commit(ledger, {
      authority: "runtime",
      type: "settle_capability_execution",
      callId: "call-2",
      executionId: "capability-execution-1",
      outcome: "succeeded",
      observedEffect: "observation",
      summary: "  One bounded observation was captured.  ",
      references: [{ kind: "tool_target", target: "project/index.html" }],
    });
    expect(settled.state).toMatchObject({
      activeCallId: "call-2",
      calls: [{}, { callId: "call-2", status: "active", activationCount: 2 }],
      capabilityExecutions: [
        {
          executionId: "capability-execution-1",
          status: "settled",
          outcome: "succeeded",
          observedEffect: "observation",
          summary: "One bounded observation was captured.",
          references: [{ kind: "tool_target", target: "project/index.html" }],
        },
      ],
    });
    expect(
      Object.isFrozen(settled.state.capabilityExecutions[0]?.references),
    ).toBe(true);
  });

  test("requires canonical exact results for both root and Worker capability executions", async () => {
    const rootLedger = createRootCapabilityLedger();
    await commit(rootLedger, { authority: "runtime", type: "create_root" });
    const begun = await commit(rootLedger, {
      authority: "active_role",
      type: "begin_capability_execution",
      callId: "call-1",
      invocationAttempt: 1,
      capabilityId: "example.observe",
      declaredEffect: "observation",
    });
    const settlement = {
      authority: "runtime",
      type: "settle_capability_execution",
      callId: "call-1",
      executionId: "capability-execution-1",
      outcome: "succeeded",
      observedEffect: "observation",
      summary: "Observed.",
    } as const;

    await expect(
      rootLedger.apply({ expectedHead: begun, command: settlement }),
    ).resolves.toMatchObject({
      ok: false,
      code: "invalid_command",
    });
    expect(rootLedger.current()).toBe(begun);

    const exactResult = {
      kind: "generic_capability_result_v1",
      authority: "capability_adapter",
      status: "executed",
      ok: true,
      payload: { value: "  exact plugin value  " },
    } as const;
    const settled = await commit(rootLedger, {
      ...settlement,
      exactResult,
    });
    expect(settled.state.capabilityExecutions[0]?.exactResult).toEqual(
      exactResult,
    );

    const workerLedger = createLedger();
    await commit(workerLedger, { authority: "runtime", type: "create_root" });
    await commit(workerLedger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: "Observe one bounded value.",
    });
    const workerBegun = await commit(workerLedger, {
      authority: "active_role",
      type: "begin_capability_execution",
      callId: "call-2",
      invocationAttempt: 1,
      capabilityId: "example.observe",
      declaredEffect: "observation",
    });
    await expect(
      workerLedger.apply({
        expectedHead: workerBegun,
        command: { ...settlement, callId: "call-2" },
      }),
    ).resolves.toMatchObject({ ok: false, code: "invalid_command" });
    expect(workerLedger.current()).toBe(workerBegun);

    const workerSettled = await commit(workerLedger, {
      ...settlement,
      callId: "call-2",
      exactResult,
    });
    expect(workerSettled.state.capabilityExecutions[0]?.exactResult).toEqual(
      exactResult,
    );
  });

  test("atomically begins and settles one observation-only capability batch", async () => {
    const ledger = createLedger();
    await commit(ledger, { authority: "runtime", type: "create_root" });
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: "Read two independent sources.",
    });

    const begun = await commit(ledger, {
      authority: "active_role",
      type: "begin_capability_batch",
      callId: "call-2",
      invocationAttempt: 1,
      entries: [
        {
          capabilityId: "example.read",
          declaredEffect: "observation",
          intent: "Read the first independent source.",
          controlsJson: '{"path":"project/a.txt"}',
        },
        {
          capabilityId: "example.read",
          declaredEffect: "observation",
          intent: "Read the second independent source.",
          controlsJson: '{"path":"project/b.txt"}',
        },
      ],
    });
    expect(begun).toMatchObject({
      revision: 3,
      state: {
        capabilityExecutionSequence: 2,
        calls: [
          {},
          {
            callId: "call-2",
            status: "waiting_for_capability",
            activationCount: 1,
          },
        ],
        capabilityExecutions: [
          {
            executionId: "capability-execution-1",
            invocationAttempt: 1,
            declaredEffect: "observation",
            intent: "Read the first independent source.",
            controlsJson: '{"path":"project/a.txt"}',
            status: "running",
          },
          {
            executionId: "capability-execution-2",
            invocationAttempt: 1,
            declaredEffect: "observation",
            intent: "Read the second independent source.",
            controlsJson: '{"path":"project/b.txt"}',
            status: "running",
          },
        ],
      },
    });

    expect(
      await ledger.apply({
        expectedHead: begun,
        command: withTestCapabilityInvocation({
          authority: "runtime",
          type: "settle_capability_execution",
          callId: "call-2",
          executionId: "capability-execution-1",
          outcome: "succeeded",
          observedEffect: "observation",
          summary: "First source.",
        }),
      }),
    ).toMatchObject({ ok: false, code: "capability_execution_mismatch" });
    expect(ledger.current()).toBe(begun);

    const settled = await commit(ledger, {
      authority: "runtime",
      type: "settle_capability_batch",
      callId: "call-2",
      settlements: [
        {
          executionId: "capability-execution-1",
          outcome: "succeeded",
          observedEffect: "observation",
          summary: "First source.",
        },
        {
          executionId: "capability-execution-2",
          outcome: "failed",
          observedEffect: "none",
          summary: "Second source was unavailable.",
        },
      ],
    });
    expect(settled).toMatchObject({
      revision: 4,
      state: {
        calls: [{}, { callId: "call-2", status: "active", activationCount: 2 }],
        capabilityExecutions: [
          { status: "settled", outcome: "succeeded" },
          { status: "settled", outcome: "failed" },
        ],
      },
    });
  });

  test("rejects non-observation, partial, reordered, and over-budget batches atomically", async () => {
    const ledger = createLedger({ maxCapabilityExecutions: 2 });
    await commit(ledger, { authority: "runtime", type: "create_root" });
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: "Read independent sources.",
    });
    const before = ledger.current();
    expect(
      await ledger.apply({
        expectedHead: before,
        command: {
          authority: "active_role",
          type: "begin_capability_batch",
          callId: "call-2",
          invocationAttempt: 1,
          entries: [
            {
              capabilityId: "example.read",
              declaredEffect: "observation",
              intent: "Read source A.",
              controlsJson: "{}",
            },
            {
              capabilityId: "example.write",
              declaredEffect: "mutation",
              intent: "Write source B.",
              controlsJson: "{}",
            },
          ],
        },
      }),
    ).toMatchObject({ ok: false, code: "invalid_command" });
    expect(ledger.current()).toBe(before);
    expect(
      await ledger.apply({
        expectedHead: before,
        command: {
          authority: "active_role",
          type: "begin_capability_batch",
          callId: "call-2",
          invocationAttempt: 1,
          entries: [
            {
              capabilityId: "example.a",
              declaredEffect: "observation",
              intent: "Read source A.",
              controlsJson: "{}",
            },
            {
              capabilityId: "example.b",
              declaredEffect: "observation",
              intent: "Read source B.",
              controlsJson: "{}",
            },
            {
              capabilityId: "example.c",
              declaredEffect: "observation",
              intent: "Read source C.",
              controlsJson: "{}",
            },
          ],
        },
      }),
    ).toMatchObject({
      ok: false,
      code: "capability_execution_limit_exceeded",
    });
    expect(ledger.current()).toBe(before);

    const begun = await commit(ledger, {
      authority: "active_role",
      type: "begin_capability_batch",
      callId: "call-2",
      invocationAttempt: 1,
      entries: [
        { capabilityId: "example.a", declaredEffect: "observation" },
        { capabilityId: "example.b", declaredEffect: "observation" },
      ],
    });
    expect(
      await ledger.apply({
        expectedHead: begun,
        command: withTestCapabilityInvocation({
          authority: "runtime",
          type: "settle_capability_batch",
          callId: "call-2",
          settlements: [
            {
              executionId: "capability-execution-1",
              outcome: "succeeded",
              observedEffect: "observation",
              summary: "First.",
            },
          ],
        }),
      }),
    ).toMatchObject({ ok: false, code: "invalid_command" });
    expect(ledger.current()).toBe(begun);
    expect(
      await ledger.apply({
        expectedHead: begun,
        command: withTestCapabilityInvocation({
          authority: "runtime",
          type: "settle_capability_batch",
          callId: "call-2",
          settlements: [
            {
              executionId: "capability-execution-2",
              outcome: "succeeded",
              observedEffect: "observation",
              summary: "Second.",
            },
            {
              executionId: "capability-execution-1",
              outcome: "succeeded",
              observedEffect: "observation",
              summary: "First.",
            },
          ],
        }),
      }),
    ).toMatchObject({ ok: false, code: "capability_execution_mismatch" });
    expect(ledger.current()).toBe(begun);
  });

  test.each(["observation", "mutation"] as const)(
    "settles a mixed declaration with its concrete successful %s effect",
    async (observedEffect) => {
      const ledger = createLedger();
      await commit(ledger, { authority: "runtime", type: "create_root" });
      await commit(ledger, {
        authority: "active_role",
        type: "open_child",
        callerCallId: "call-1",
        roleId: "worker",
        objective: "Execute one bounded mixed capability.",
      });
      await commit(ledger, {
        authority: "active_role",
        type: "begin_capability_execution",
        callId: "call-2",
        invocationAttempt: 1,
        capabilityId: "example.mixed",
        declaredEffect: "mixed",
      });
      const settled = await commit(ledger, {
        authority: "runtime",
        type: "settle_capability_execution",
        callId: "call-2",
        executionId: "capability-execution-1",
        outcome: "succeeded",
        observedEffect,
        summary: `The mixed capability produced a concrete ${observedEffect}.`,
      });

      expect(settled.state.capabilityExecutions[0]).toMatchObject({
        declaredEffect: "mixed",
        outcome: "succeeded",
        observedEffect,
      });
    },
  );

  test("records failed outcome independently from an observed mutation", async () => {
    const ledger = createLedger();
    await commit(ledger, { authority: "runtime", type: "create_root" });
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: "Attempt one bounded mutation.",
    });
    await commit(ledger, {
      authority: "active_role",
      type: "begin_capability_execution",
      callId: "call-2",
      invocationAttempt: 1,
      capabilityId: "example.mutate",
      declaredEffect: "mutation",
    });
    const settled = await commit(ledger, {
      authority: "runtime",
      type: "settle_capability_execution",
      callId: "call-2",
      executionId: "capability-execution-1",
      outcome: "failed",
      observedEffect: "mutation",
      summary: "The operation failed after a mutation was observed.",
    });

    expect(settled.state).toMatchObject({
      calls: [{}, { callId: "call-2", status: "active", activationCount: 2 }],
      capabilityExecutions: [
        {
          status: "settled",
          outcome: "failed",
          observedEffect: "mutation",
        },
      ],
    });
  });

  test("rejects stale, replayed, mismatched, and over-limit capability turns", async () => {
    const ledger = createLedger();
    await commit(ledger, { authority: "runtime", type: "create_root" });
    const workerHead = await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: "Observe one bounded value.",
    });
    const begun = await commit(ledger, {
      authority: "active_role",
      type: "begin_capability_execution",
      callId: "call-2",
      invocationAttempt: 1,
      capabilityId: "example.observe",
      declaredEffect: "observation",
    });

    expect(
      await ledger.apply({
        expectedHead: workerHead,
        command: withTestCapabilityInvocation({
          authority: "runtime",
          type: "settle_capability_execution",
          callId: "call-2",
          executionId: "capability-execution-1",
          outcome: "succeeded",
          observedEffect: "observation",
          summary: "Stale.",
        }),
      }),
    ).toMatchObject({ ok: false, code: "stale_head" });
    expect(
      await ledger.apply({
        expectedHead: ledger.current(),
        command: {
          authority: "active_role",
          type: "begin_capability_execution",
          callId: "call-2",
          invocationAttempt: 1,
          capabilityId: "example.observe",
          declaredEffect: "observation",
          intent: "Repeat the observation.",
          controlsJson: "{}",
        },
      }),
    ).toMatchObject({ ok: false, code: "capability_caller_invalid" });
    expect(
      await ledger.apply({
        expectedHead: ledger.current(),
        command: withTestCapabilityInvocation({
          authority: "runtime",
          type: "settle_capability_execution",
          callId: "call-2",
          executionId: "capability-execution-1",
          outcome: "succeeded",
          observedEffect: "mutation",
          summary: "Wrong effect.",
        }),
      }),
    ).toMatchObject({
      ok: false,
      code: "capability_execution_mismatch",
    });
    expect(ledger.current()).toBe(begun);

    await commit(ledger, {
      authority: "runtime",
      type: "settle_capability_execution",
      callId: "call-2",
      executionId: "capability-execution-1",
      outcome: "succeeded",
      observedEffect: "observation",
      summary: "Observed.",
    });
    const settled = ledger.current();
    expect(
      await ledger.apply({
        expectedHead: settled,
        command: withTestCapabilityInvocation({
          authority: "runtime",
          type: "settle_capability_execution",
          callId: "call-2",
          executionId: "capability-execution-1",
          outcome: "succeeded",
          observedEffect: "observation",
          summary: "Replay.",
        }),
      }),
    ).toMatchObject({
      ok: false,
      code: "capability_execution_mismatch",
    });
    expect(
      await ledger.apply({
        expectedHead: settled,
        command: {
          authority: "active_role",
          type: "begin_capability_execution",
          callId: "call-2",
          invocationAttempt: 1,
          capabilityId: "example.observe",
          declaredEffect: "observation",
          intent: "Repeat the observation.",
          controlsJson: "{}",
        },
      }),
    ).toMatchObject({
      ok: false,
      code: "capability_invocation_mismatch",
    });
    expect(
      await ledger.apply({
        expectedHead: settled,
        command: {
          authority: "active_role",
          type: "begin_capability_execution",
          callId: "call-2",
          invocationAttempt: 2,
          capabilityId: "example.observe",
          declaredEffect: "observation",
          intent: "Repeat the observation.",
          controlsJson: "{}",
          retry: true,
        },
      }),
    ).toMatchObject({ ok: false, code: "invalid_command" });

    const nonWorker = createLedger();
    await commit(nonWorker, { authority: "runtime", type: "create_root" });
    await commit(nonWorker, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "reviewer",
      objective: "Research without direct capability ownership.",
    });
    expect(
      await nonWorker.apply({
        expectedHead: nonWorker.current(),
        command: {
          authority: "active_role",
          type: "begin_capability_execution",
          callId: "call-2",
          invocationAttempt: 1,
          capabilityId: "example.observe",
          declaredEffect: "observation",
          intent: "Attempt the unauthorized observation.",
          controlsJson: "{}",
        },
      }),
    ).toMatchObject({ ok: false, code: "capability_caller_invalid" });

    const limited = createLedger({ maxCapabilityExecutions: 1 });
    await commit(limited, { authority: "runtime", type: "create_root" });
    await commit(limited, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: "Observe bounded values.",
    });
    await commit(limited, {
      authority: "active_role",
      type: "begin_capability_execution",
      callId: "call-2",
      invocationAttempt: 1,
      capabilityId: "example.observe",
      declaredEffect: "observation",
    });
    await commit(limited, {
      authority: "runtime",
      type: "settle_capability_execution",
      callId: "call-2",
      executionId: "capability-execution-1",
      outcome: "succeeded",
      observedEffect: "observation",
      summary: "Observed.",
    });
    expect(
      await limited.apply({
        expectedHead: limited.current(),
        command: {
          authority: "active_role",
          type: "begin_capability_execution",
          callId: "call-2",
          invocationAttempt: 2,
          capabilityId: "example.observe",
          declaredEffect: "observation",
          intent: "Read one more bounded value.",
          controlsJson: "{}",
        },
      }),
    ).toMatchObject({
      ok: false,
      code: "capability_execution_limit_exceeded",
    });
  });

  test("logs commits and rejections without raw role content", async () => {
    configureDebugLogger({ enabled: true });
    const objective = "OBJECTIVE_SECRET_SHOULD_NOT_BE_LOGGED";
    const summary = "SUMMARY_SECRET_SHOULD_NOT_BE_LOGGED";
    const capabilitySummary = "CAPABILITY_SUMMARY_SECRET_SHOULD_NOT_BE_LOGGED";
    const capabilityIntent = "CAPABILITY_INTENT_SECRET_SHOULD_NOT_BE_LOGGED";
    const capabilityControls =
      '{"path":"CAPABILITY_PATH_SECRET_SHOULD_NOT_BE_LOGGED"}';
    const actionFingerprint = `sha256:${"f".repeat(64)}`;
    const mutationFingerprint = `sha256:${"e".repeat(64)}`;
    const response = "RESPONSE_SECRET_SHOULD_NOT_BE_LOGGED";
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    let logs: Record<string, unknown>[] = [];
    try {
      const ledger = createLedger();
      await commit(ledger, { authority: "runtime", type: "create_root" });
      await commit(ledger, {
        authority: "active_role",
        type: "open_child",
        callerCallId: "call-1",
        roleId: "worker",
        objective,
      });
      await commit(ledger, {
        authority: "active_role",
        type: "begin_capability_execution",
        callId: "call-2",
        invocationAttempt: 1,
        capabilityId: "example.observe",
        declaredEffect: "observation",
        intent: capabilityIntent,
        controlsJson: capabilityControls,
        actionFingerprint,
      });
      await ledger.apply({
        expectedHead: ledger.current(),
        command: withTestCapabilityInvocation({
          authority: "runtime",
          type: "settle_capability_execution",
          callId: "call-2",
          executionId: "capability-execution-1",
          outcome: "succeeded",
          observedEffect: "mutation",
          summary: capabilitySummary,
        }),
      });
      await commit(ledger, {
        authority: "runtime",
        type: "settle_capability_execution",
        callId: "call-2",
        executionId: "capability-execution-1",
        outcome: "succeeded",
        outcomeFingerprint: "succeeded",
        observedEffect: "observation",
        summary: capabilitySummary,
      });
      await commit(ledger, {
        authority: "active_role",
        type: "begin_capability_execution",
        callId: "call-2",
        invocationAttempt: 2,
        capabilityId: "example.observe",
        declaredEffect: "observation",
        intent: capabilityIntent,
        controlsJson: capabilityControls,
        actionFingerprint,
      });
      await commit(ledger, {
        authority: "runtime",
        type: "settle_capability_execution",
        callId: "call-2",
        executionId: "capability-execution-2",
        outcome: "succeeded",
        outcomeFingerprint: "succeeded",
        observedEffect: "observation",
        summary: capabilitySummary,
      });
      await commit(ledger, {
        authority: "active_role",
        type: "begin_capability_execution",
        callId: "call-2",
        invocationAttempt: 3,
        capabilityId: "example.observe",
        declaredEffect: "observation",
        intent: capabilityIntent,
        controlsJson: capabilityControls,
        actionFingerprint,
      });
      await ledger.apply({
        expectedHead: ledger.current(),
        command: {
          authority: "active_role",
          type: "begin_capability_execution",
          callId: "call-2",
          invocationAttempt: 4,
          capabilityId: "example.observe",
          declaredEffect: "observation",
          intent: capabilityIntent,
          controlsJson: capabilityControls,
          actionFingerprint,
        },
      });
      await commit(ledger, {
        authority: "active_role",
        type: "begin_capability_execution",
        callId: "call-2",
        invocationAttempt: 4,
        capabilityId: "example.mutate",
        declaredEffect: "mutation",
        intent: capabilityIntent,
        controlsJson: capabilityControls,
        actionFingerprint: mutationFingerprint,
      });
      await commit(ledger, {
        authority: "runtime",
        type: "settle_capability_execution",
        callId: "call-2",
        executionId: "capability-execution-3",
        outcome: "succeeded",
        outcomeFingerprint: "succeeded",
        observedEffect: "mutation",
        summary: capabilitySummary,
      });
      await commit(ledger, {
        authority: "active_role",
        type: "begin_capability_execution",
        callId: "call-2",
        invocationAttempt: 5,
        capabilityId: "example.mutate",
        declaredEffect: "mutation",
        intent: capabilityIntent,
        controlsJson: capabilityControls,
        actionFingerprint: mutationFingerprint,
      });
      await commit(ledger, {
        authority: "runtime",
        type: "settle_capability_execution",
        callId: "call-2",
        executionId: "capability-execution-4",
        outcome: "succeeded",
        outcomeFingerprint: "succeeded",
        observedEffect: "mutation",
        summary: capabilitySummary,
      });
      await commit(ledger, {
        authority: "runtime",
        type: "return_child",
        callerCallId: "call-1",
        childCallId: "call-2",
        outcome: "completed",
        summary,
      });
      await commit(ledger, {
        authority: "supervisor",
        type: "complete_root_response",
        callId: "call-1",
        response,
      });
      await ledger.apply({
        expectedHead: ledger.current(),
        command: { authority: "runtime", type: "create_root" },
      });
      logs = consoleLog.mock.calls.map(
        ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
      );
    } finally {
      consoleLog.mockRestore();
    }

    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.role_calls",
          event: "root.created",
          callId: "call-1",
          roleId: "supervisor",
          depth: 0,
          activationCount: 1,
        }),
        expect.objectContaining({
          scope: "runtime.role_calls",
          event: "child.opened",
          callId: "call-2",
          parentCallId: "call-1",
          roleId: "worker",
          objectiveLength: objective.length,
        }),
        expect.objectContaining({
          scope: "runtime.role_calls",
          event: "child.returned",
          resultRef: "result-1",
          summaryLength: summary.length,
        }),
        expect.objectContaining({
          scope: "runtime.role_calls",
          event: "caller.resumed",
          callId: "call-1",
          activationCount: 2,
        }),
        expect.objectContaining({
          scope: "runtime.role_calls",
          event: "capability.execution_begun",
          callId: "call-2",
          executionId: "capability-execution-1",
          invocationAttempt: 1,
          capabilityId: "example.observe",
          declaredEffect: "observation",
          actionFingerprint,
        }),
        expect.objectContaining({
          scope: "runtime.role_calls",
          event: "capability.execution_settled",
          callId: "call-2",
          executionId: "capability-execution-1",
          actionFingerprint,
          outcome: "succeeded",
          observedEffect: "observation",
          summaryLength: capabilitySummary.length,
        }),
        expect.objectContaining({
          scope: "runtime.role_calls",
          event: "operation.supervision_reset",
          callId: "call-2",
          executionId: "capability-execution-3",
          invocationAttempt: 4,
          capabilityId: "example.mutate",
          actionFingerprint: mutationFingerprint,
          cause: "successful_observed_mutation",
          clearedEntryCount: 1,
          clearedInterventionCount: 1,
        }),
        expect.objectContaining({
          scope: "runtime.role_calls",
          event: "transition.rejected",
          commandType: "begin_capability_execution",
          rejectionCode: "operation_supervision_limit_exceeded",
          attemptedCallId: "call-2",
          attemptedInvocationAttempt: 4,
          attemptedCapabilityId: "example.observe",
          attemptedActionFingerprint: actionFingerprint,
          attemptedDeclaredEffect: "observation",
        }),
        expect.objectContaining({
          scope: "runtime.role_calls",
          event: "transition.rejected",
          commandType: "settle_capability_execution",
          rejectionCode: "capability_execution_mismatch",
          attemptedCallId: "call-2",
          attemptedExecutionId: "capability-execution-1",
          attemptedOutcome: "succeeded",
          attemptedObservedEffect: "mutation",
          capabilityId: "example.observe",
          declaredEffect: "observation",
          invocationAttempt: 1,
        }),
        expect.objectContaining({
          scope: "runtime.role_calls",
          event: "root.response_committed",
          responseLength: response.length,
        }),
        expect.objectContaining({
          scope: "runtime.role_calls",
          event: "transition.rejected",
          commandType: "create_root",
          rejectionCode: "root_already_created",
        }),
      ]),
    );
    expect(
      logs.filter((entry) => entry.event === "operation.supervision_reset"),
    ).toHaveLength(1);
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(objective);
    expect(serialized).not.toContain(summary);
    expect(serialized).not.toContain(capabilitySummary);
    expect(serialized).not.toContain(capabilityIntent);
    expect(serialized).not.toContain(capabilityControls);
    expect(serialized).not.toContain(
      "CAPABILITY_PATH_SECRET_SHOULD_NOT_BE_LOGGED",
    );
    expect(serialized).not.toContain(response);
  });
});
