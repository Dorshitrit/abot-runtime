import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { SessionArtifactPath } from "../../sessions/types.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import {
  createRoleCallLedger,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  type RoleCallLedger,
  type RoleCallLedgerHead,
} from "../orchestration/role-calls/index.js";
import {
  collectSettledSessionArtifactPathInputs,
  persistSettledSessionArtifactPaths,
  snapshotSessionArtifactPathTargets,
} from "../request/session-artifact-path-persistence.js";

function testExactCapabilityResult(
  input: Readonly<{
    outcome: "succeeded" | "failed";
    observedEffect: "none" | "observation" | "mutation" | "indeterminate";
    summary: string;
  }>,
) {
  return Object.freeze({
    kind: "generic_capability_result_v1" as const,
    authority: "capability_adapter" as const,
    status: "executed" as const,
    ok: input.outcome === "succeeded",
    payload: Object.freeze({ ...input }),
  });
}

function createLedger(): RoleCallLedger {
  return createRoleCallLedger({
    requestId: "artifact-path-request",
    policy: {
      limits: {
        maxDepth: 4,
        maxCalls: 8,
        maxCapabilityExecutions: 8,
        maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
        maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
        maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
      },
    },
  });
}

async function commit(
  ledger: RoleCallLedger,
  command: unknown,
): Promise<RoleCallLedgerHead> {
  const result = await ledger.apply({
    expectedHead: ledger.current(),
    command,
  });
  expect(result).toMatchObject({ ok: true, status: "committed" });
  if (!result.ok) throw new Error(result.code);
  return result.head;
}

async function buildSettledLedger(): Promise<RoleCallLedger> {
  const ledger = createLedger();
  await commit(ledger, { authority: "runtime", type: "create_root" });
  await commit(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId: "worker",
    objective: "Exercise canonical artifact path collection.",
  });
  await commit(ledger, {
    authority: "active_role",
    type: "begin_capability_execution",
    callId: "call-2",
    invocationAttempt: 1,
    capabilityId: "example.first",
    declaredEffect: "mutation",
    intent: "Create the requested artifact targets.",
    controlsJson: "{}",
  });
  await commit(ledger, {
    authority: "runtime",
    type: "settle_capability_execution",
    callId: "call-2",
    executionId: "capability-execution-1",
    outcome: "succeeded",
    observedEffect: "mutation",
    summary: "Created two targets.",
    exactResult: testExactCapabilityResult({
      outcome: "succeeded",
      observedEffect: "mutation",
      summary: "Created two targets.",
    }),
    references: [
      { kind: "tool_target", target: "news/news.txt" },
      { kind: "tool_target", target: "notes/summary.txt" },
    ],
  });
  await commit(ledger, {
    authority: "active_role",
    type: "begin_capability_execution",
    callId: "call-2",
    invocationAttempt: 2,
    capabilityId: "example.failed",
    declaredEffect: "observation",
    intent: "Inspect the unavailable target.",
    controlsJson: "{}",
  });
  await commit(ledger, {
    authority: "runtime",
    type: "settle_capability_execution",
    callId: "call-2",
    executionId: "capability-execution-2",
    outcome: "failed",
    observedEffect: "none",
    summary: "Did not establish the failed target.",
    exactResult: testExactCapabilityResult({
      outcome: "failed",
      observedEffect: "none",
      summary: "Did not establish the failed target.",
    }),
    references: [{ kind: "tool_target", target: "ignored/failure.txt" }],
  });
  await commit(ledger, {
    authority: "active_role",
    type: "begin_capability_execution",
    callId: "call-2",
    invocationAttempt: 3,
    capabilityId: "example.refresh",
    declaredEffect: "observation",
    intent: "Refresh the established artifact target.",
    controlsJson: "{}",
  });
  await commit(ledger, {
    authority: "runtime",
    type: "settle_capability_execution",
    callId: "call-2",
    executionId: "capability-execution-3",
    outcome: "succeeded",
    observedEffect: "observation",
    summary: "Refreshed one target.",
    exactResult: testExactCapabilityResult({
      outcome: "succeeded",
      observedEffect: "observation",
      summary: "Refreshed one target.",
    }),
    references: [{ kind: "tool_target", target: "news/news.txt" }],
  });
  return ledger;
}

beforeEach(() => {
  configureDebugLogger({ enabled: false });
});

afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

describe("session artifact path persistence", () => {
  test("collects only successful settled targets with deterministic recency", async () => {
    const ledger = await buildSettledLedger();

    const inputs = collectSettledSessionArtifactPathInputs(ledger.current());

    expect(inputs).toEqual([
      {
        target: "notes/summary.txt",
        sourceRequestId: "artifact-path-request",
        sourceExecutionId: "capability-execution-1",
      },
      {
        target: "news/news.txt",
        sourceRequestId: "artifact-path-request",
        sourceExecutionId: "capability-execution-3",
      },
    ]);
    expect(Object.isFrozen(inputs)).toBe(true);
    expect(inputs.every(Object.isFrozen)).toBe(true);
  });

  test("does not let unavailable or failed persistence mask the request", async () => {
    const ledger = await buildSettledLedger();
    const persistArtifactPaths = vi.fn(async () => {
      throw new Error("sensitive target must not enter diagnostics");
    });

    await expect(
      persistSettledSessionArtifactPaths({
        head: ledger.current(),
        sessionId: "artifact-path-session",
        trigger: "root_failed",
      }),
    ).resolves.toBeUndefined();
    await expect(
      persistSettledSessionArtifactPaths({
        head: ledger.current(),
        sessionId: "artifact-path-session",
        trigger: "root_succeeded",
        persistArtifactPaths,
      }),
    ).resolves.toBeUndefined();
    expect(persistArtifactPaths).toHaveBeenCalledOnce();
  });

  test("freezes a newest-first target-only snapshot without mutating registry order", () => {
    const registry: SessionArtifactPath[] = [
      {
        target: "older/file.txt",
        sourceRequestId: "request-1",
        sourceExecutionId: "execution-1",
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
      {
        target: "newer/file.txt",
        sourceRequestId: "request-2",
        sourceExecutionId: "execution-2",
        createdAt: "2026-08-14T00:01:00.000Z",
        updatedAt: "2026-08-14T00:01:00.000Z",
      },
    ];

    const snapshot = snapshotSessionArtifactPathTargets(registry);

    expect(snapshot).toEqual(["newer/file.txt", "older/file.txt"]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(registry.map(({ target }) => target)).toEqual([
      "older/file.txt",
      "newer/file.txt",
    ]);
  });

  test("bounds a snapshot and omits entries outside the tool-target contract", () => {
    const registry = [
      ...Array.from({ length: 64 }, (_, index) => ({
        target: `valid-${index}.txt`,
        sourceRequestId: "request",
        sourceExecutionId: `execution-${index}`,
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
      })),
      {
        target: " ",
        sourceRequestId: "request",
        sourceExecutionId: "execution-invalid",
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
      {
        target: "valid-63.txt",
        sourceRequestId: "request",
        sourceExecutionId: "execution-refresh",
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:01:00.000Z",
      },
    ] satisfies SessionArtifactPath[];

    const snapshot = snapshotSessionArtifactPathTargets(registry);

    expect(snapshot).toHaveLength(64);
    expect(snapshot[0]).toBe("valid-63.txt");
    expect(new Set(snapshot).size).toBe(snapshot.length);
    expect(snapshot).not.toContain(" ");
  });
});
