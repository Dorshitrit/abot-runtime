import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { MODEL_STEPS } from "../../shared/model-steps.js";
import {
  buildRequestToolResultsMessage,
  projectRequestToolResults,
} from "../context/request-tool-results.js";
import {
  createRoleCallLedger,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  type RoleCallLedger,
  type RoleCallLedgerHead,
} from "../orchestration/role-calls/index.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";

function createLedger(): RoleCallLedger {
  return createRoleCallLedger({
    requestId: "request-tool-results-test",
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
    command: withTestExactResult(command),
  });
  expect(result).toMatchObject({ ok: true, status: "committed" });
  if (!result.ok) throw new Error(result.code);
  return result.head;
}

function withTestExactResult(command: unknown): unknown {
  if (
    typeof command !== "object" ||
    command === null ||
    Array.isArray(command)
  ) {
    return command;
  }
  const record = command as Record<string, unknown>;
  if (record.type !== "settle_capability_execution") return command;
  return {
    ...record,
    exactResult: record.exactResult ?? {
      kind: "generic_capability_result_v1",
      authority: "capability_adapter",
      status: "executed",
      ok: record.outcome === "succeeded",
      payload: {
        outcome: record.outcome,
        observedEffect: record.observedEffect,
        summary: record.summary,
        ...(typeof record.referenceData === "string"
          ? { referenceData: record.referenceData }
          : {}),
      },
      ...(Array.isArray(record.references)
        ? { references: record.references }
        : {}),
    },
  };
}

beforeEach(() => {
  configureDebugLogger({ enabled: false });
});

afterEach(() => {
  resetDebugLoggerConfig();
});

describe("request tool results", () => {
  test("projects every settled result in canonical order across calls", async () => {
    const ledger = createLedger();
    await commit(ledger, { authority: "runtime", type: "create_root" });
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: "Capture the first observation.",
    });
    await commit(ledger, {
      authority: "active_role",
      type: "begin_capability_execution",
      callId: "call-2",
      invocationAttempt: 1,
      capabilityId: "example.first",
      declaredEffect: "observation",
      intent: "Capture the first observation.",
      controlsJson: "{}",
    });
    await commit(ledger, {
      authority: "runtime",
      type: "settle_capability_execution",
      callId: "call-2",
      executionId: "capability-execution-1",
      outcome: "succeeded",
      observedEffect: "observation",
      summary: "The first observation.",
      references: [{ kind: "tool_target", target: "sandbox/result.txt" }],
    });
    await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-1",
      childCallId: "call-2",
      outcome: "completed",
      summary: "The first observation was captured.",
    });
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: "Attempt the second observation.",
    });
    await commit(ledger, {
      authority: "active_role",
      type: "begin_capability_execution",
      callId: "call-3",
      invocationAttempt: 1,
      capabilityId: "example.second",
      declaredEffect: "observation",
      intent: "Capture the second observation.",
      controlsJson: "{}",
    });

    const whileRunning = projectRequestToolResults({
      ledger,
      head: ledger.current(),
      modelStep: MODEL_STEPS.WORKER_DECISION,
      callId: "call-3",
    });
    expect(whileRunning.results.map(({ executionId }) => executionId)).toEqual([
      "capability-execution-1",
    ]);

    await commit(ledger, {
      authority: "runtime",
      type: "settle_capability_execution",
      callId: "call-3",
      executionId: "capability-execution-2",
      outcome: "failed",
      observedEffect: "none",
      summary: "The second observation failed.",
    });
    const view = projectRequestToolResults({
      ledger,
      head: ledger.current(),
      modelStep: MODEL_STEPS.WORKER_DECISION,
      callId: "call-3",
    });

    expect(view).toEqual({
      sourceRevision: ledger.current().revision,
      results: [
        {
          executionId: "capability-execution-1",
          callId: "call-2",
          invocationAttempt: 1,
          capabilityId: "example.first",
          declaredEffect: "observation",
          outcome: "succeeded",
          observedEffect: "observation",
          summary: "The first observation.",
          references: [{ kind: "tool_target", target: "sandbox/result.txt" }],
        },
        {
          executionId: "capability-execution-2",
          callId: "call-3",
          invocationAttempt: 1,
          capabilityId: "example.second",
          declaredEffect: "observation",
          outcome: "failed",
          observedEffect: "none",
          summary: "The second observation failed.",
          adapterResult: {
            kind: "generic_capability_result_v1",
            authority: "capability_adapter",
            status: "executed",
            ok: false,
            payload: {
              outcome: "failed",
              observedEffect: "none",
              summary: "The second observation failed.",
            },
          },
        },
      ],
    });
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.results)).toBe(true);
    expect(view.results.every(Object.isFrozen)).toBe(true);

    const message = buildRequestToolResultsMessage(view);
    expect(Object.isFrozen(message)).toBe(true);
    expect(message.role).toBe("user");
    expect(JSON.parse(message.content)).toEqual({
      kind: "runtime_request_tool_results_v1",
      authority: "reference_data",
      sourceRevision: view.sourceRevision,
      results: view.results,
    });
  });

  test("projects complete reference data and exact structured evidence only to its producing Worker", async () => {
    const ledger = createLedger();
    await commit(ledger, { authority: "runtime", type: "create_root" });
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: "Capture one large observation.",
    });
    await commit(ledger, {
      authority: "active_role",
      type: "begin_capability_execution",
      callId: "call-2",
      invocationAttempt: 1,
      capabilityId: "example.large",
      declaredEffect: "observation",
      intent: "Capture the complete large observation.",
      controlsJson: "{}",
    });
    await commit(ledger, {
      authority: "runtime",
      type: "settle_capability_execution",
      callId: "call-2",
      executionId: "capability-execution-1",
      outcome: "succeeded",
      observedEffect: "observation",
      summary: "The complete result was supplied to its producing Worker.",
      referenceData: "complete external result",
      exactResult: {
        kind: "registered_tool_execution_result_v1",
        authority: "registered_plugin",
        status: "executed",
        result: {
          ok: true,
          tool: "example.large",
          output: "complete external result",
          producedNewInformation: true,
          data: { records: [{ id: "record-1", visible: true }] },
        },
      },
    });

    const ownerView = projectRequestToolResults({
      ledger,
      head: ledger.current(),
      modelStep: MODEL_STEPS.WORKER_DECISION,
      callId: "call-2",
    });
    expect(ownerView.results[0]?.referenceData).toBe(
      "complete external result",
    );
    expect(ownerView.results[0]?.adapterResult).toEqual({
      kind: "registered_tool_execution_result_v1",
      authority: "registered_plugin",
      status: "executed",
      result: {
        ok: true,
        tool: "example.large",
        output: "complete external result",
        producedNewInformation: true,
        data: { records: [{ id: "record-1", visible: true }] },
      },
    });
    const ownerMessage = JSON.parse(
      buildRequestToolResultsMessage(ownerView).content,
    ) as { results: readonly Record<string, unknown>[] };
    expect(ownerMessage.results[0]).not.toHaveProperty("referenceData");
    expect(ownerMessage.results[0]?.adapterResult).toEqual(
      ownerView.results[0]?.adapterResult,
    );

    await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-1",
      childCallId: "call-2",
      outcome: "completed",
      summary: "The large observation was summarized for its caller.",
    });
    const callerView = projectRequestToolResults({
      ledger,
      head: ledger.current(),
      modelStep: MODEL_STEPS.SUPERVISOR_DECISION,
      callId: "call-1",
    });
    expect(callerView.results[0]).not.toHaveProperty("referenceData");
    expect(callerView.results[0]).not.toHaveProperty("adapterResult");
    expect(callerView.results[0]?.summary).toBe(
      "The complete result was supplied to its producing Worker.",
    );
  });

  test("retains reference data when the exact adapter envelope does not contain the identical string", async () => {
    const ledger = createLedger();
    await commit(ledger, { authority: "runtime", type: "create_root" });
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: "Capture one independently projected observation.",
    });
    await commit(ledger, {
      authority: "active_role",
      type: "begin_capability_execution",
      callId: "call-2",
      invocationAttempt: 1,
      capabilityId: "example.independent",
      declaredEffect: "observation",
      intent: "Capture the independent observation.",
      controlsJson: "{}",
    });
    await commit(ledger, {
      authority: "runtime",
      type: "settle_capability_execution",
      callId: "call-2",
      executionId: "capability-execution-1",
      outcome: "succeeded",
      observedEffect: "observation",
      summary: "The observation completed.",
      referenceData: "independent reference body",
      exactResult: {
        kind: "registered_tool_execution_result_v1",
        authority: "registered_plugin",
        status: "executed",
        result: {
          ok: true,
          tool: "example.independent",
          output: "different exact body",
          producedNewInformation: true,
        },
      },
    });

    const view = projectRequestToolResults({
      ledger,
      head: ledger.current(),
      modelStep: MODEL_STEPS.WORKER_DECISION,
      callId: "call-2",
    });
    const message = JSON.parse(
      buildRequestToolResultsMessage(view).content,
    ) as {
      results: readonly Record<string, unknown>[];
    };

    expect(message.results[0]?.referenceData).toBe(
      "independent reference body",
    );
    expect(message.results[0]?.adapterResult).toEqual(
      view.results[0]?.adapterResult,
    );
  });

  test("replaces observations made stale by a later mutation", async () => {
    const ledger = createLedger();
    await commit(ledger, { authority: "runtime", type: "create_root" });
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: "Update one existing artifact from current evidence.",
    });

    const settle = async (params: {
      capabilityId: string;
      declaredEffect: "observation" | "mutation";
      observedEffect: "observation" | "mutation";
      summary: string;
      target: string;
    }) => {
      const begun = await commit(ledger, {
        authority: "active_role",
        type: "begin_capability_execution",
        callId: "call-2",
        invocationAttempt:
          ledger.current().state.capabilityExecutions.length + 1,
        capabilityId: params.capabilityId,
        declaredEffect: params.declaredEffect,
        intent: params.summary,
        controlsJson: "{}",
      });
      const execution = begun.state.capabilityExecutions.at(-1)!;
      await commit(ledger, {
        authority: "runtime",
        type: "settle_capability_execution",
        callId: "call-2",
        executionId: execution.executionId,
        outcome: "succeeded",
        observedEffect: params.observedEffect,
        summary: params.summary,
        references: [{ kind: "tool_target", target: params.target }],
      });
      return execution.executionId;
    };

    const oldRead = await settle({
      capabilityId: "inspect_target",
      declaredEffect: "observation",
      observedEffect: "observation",
      summary: "old file body".repeat(100),
      target: "project/app.js",
    });
    const mutation = await settle({
      capabilityId: "edit_existing_file",
      declaredEffect: "mutation",
      observedEffect: "mutation",
      summary: "The requested edit completed.",
      target: "project/app.js",
    });
    const currentRead = await settle({
      capabilityId: "inspect_target",
      declaredEffect: "observation",
      observedEffect: "observation",
      summary: "current file body".repeat(100),
      target: "project/app.js",
    });
    const otherRead = await settle({
      capabilityId: "inspect_target",
      declaredEffect: "observation",
      observedEffect: "observation",
      summary: "other current file body",
      target: "project/style.css",
    });

    const view = projectRequestToolResults({
      ledger,
      head: ledger.current(),
      modelStep: MODEL_STEPS.WORKER_DECISION,
      callId: "call-2",
    });

    expect(view.results.map(({ executionId }) => executionId)).toEqual([
      oldRead,
      mutation,
      currentRead,
      otherRead,
    ]);
    expect(view.results[0]).toMatchObject({
      executionId: oldRead,
      summaryProjection: "superseded_target_evidence",
      supersededByExecutionIds: [mutation],
    });
    expect(view.results[0]).not.toHaveProperty("adapterResult");
    expect(view.results[1]!.summary).toBe("The requested edit completed.");
    expect(view.results[2]!.summary).toContain("current file body");
    expect(view.results[3]!.summary).toBe("other current file body");
  });

  test("retains complementary observations and supersedes exact duplicates", async () => {
    const ledger = createLedger();
    await commit(ledger, { authority: "runtime", type: "create_root" });
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: "Inspect complementary regions of one artifact.",
    });

    const settleObservation = async (summary: string) => {
      const begun = await commit(ledger, {
        authority: "active_role",
        type: "begin_capability_execution",
        callId: "call-2",
        invocationAttempt:
          ledger.current().state.capabilityExecutions.length + 1,
        capabilityId: "inspect_target",
        declaredEffect: "observation",
        intent: summary,
        controlsJson: "{}",
      });
      const execution = begun.state.capabilityExecutions.at(-1)!;
      await commit(ledger, {
        authority: "runtime",
        type: "settle_capability_execution",
        callId: "call-2",
        executionId: execution.executionId,
        outcome: "succeeded",
        observedEffect: "observation",
        summary,
        references: [{ kind: "tool_target", target: "project/index.html" }],
      });
      return execution.executionId;
    };

    const firstRegion = "Range: lines 1-120 of 124\nfirst region";
    const secondRegion = "Range: lines 121-124 of 124\nsecond region";
    const firstExecution = await settleObservation(firstRegion);
    const secondExecution = await settleObservation(secondRegion);

    const complementaryView = projectRequestToolResults({
      ledger,
      head: ledger.current(),
      modelStep: MODEL_STEPS.WORKER_DECISION,
      callId: "call-2",
    });
    expect(complementaryView.results).toMatchObject([
      { executionId: firstExecution, summary: firstRegion },
      { executionId: secondExecution, summary: secondRegion },
    ]);
    expect(
      complementaryView.results.some(({ summaryProjection }) =>
        Boolean(summaryProjection),
      ),
    ).toBe(false);

    const duplicateExecution = await settleObservation(firstRegion);
    const duplicateView = projectRequestToolResults({
      ledger,
      head: ledger.current(),
      modelStep: MODEL_STEPS.WORKER_DECISION,
      callId: "call-2",
    });
    expect(duplicateView.results[0]).toMatchObject({
      executionId: firstExecution,
      summaryProjection: "superseded_target_evidence",
      supersededByExecutionIds: [duplicateExecution],
    });
    expect(duplicateView.results[1]).toMatchObject({
      executionId: secondExecution,
      summary: secondRegion,
    });
    expect(duplicateView.results[2]).toMatchObject({
      executionId: duplicateExecution,
      summary: firstRegion,
    });
    expect(duplicateView.results[2]!.summaryProjection).toBeUndefined();
  });

  test("rejects a stale ledger head", async () => {
    const ledger = createLedger();
    const rooted = await commit(ledger, {
      authority: "runtime",
      type: "create_root",
    });
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: "Capture one observation.",
    });

    expect(() =>
      projectRequestToolResults({
        ledger,
        head: rooted,
        modelStep: MODEL_STEPS.SUPERVISOR_DECISION,
        callId: "call-1",
      }),
    ).toThrow("request_tool_results_head_stale");
  });
});
