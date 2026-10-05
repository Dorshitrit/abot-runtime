import { expect, test } from "vitest";
import { createAutomationNodeTransactions } from "../automations/node-transactions.js";
import type { AutomationPersistence } from "../automations/persistence.js";
import { MAX_AUTOMATION_RESULT_BYTES } from "../automations/result-capacity.js";
import {
  emptyAutomationJournalState, parseAutomationJournalState,
  type AutomationResultRecord,
} from "../automations/storage-records.js";

function fixture(path: "tool" | "agent") {
  let state = emptyAutomationJournalState();
  state.executions.push({ id: "run", automationId: "automation", definitionRevision: 1,
    revision: 4, inputIds: [], reportRef: "derived:run", terminalAt: "2026-09-30T10:00:00Z",
    nodes: [{ nodeId: "node", status: "interrupted", errorCode: "automation_effect_uncertain",
      ...(path === "tool" ? { attemptId: "attempt" } : {}) }] });
  state.attempts.push({ id: "attempt", runId: "run", nodeId: "node", invocationId: "attempt",
    fingerprint: "fingerprint", state: "uncertain", startedAt: "2026-09-30T09:59:00Z" });
  const persistence: AutomationPersistence = {
    read: async () => structuredClone(state),
    update: async (mutate) => {
      const candidate = structuredClone(state);
      const result = mutate(candidate);
      state = candidate;
      return result;
    },
    updateWithScheduler: async () => { throw new Error("unexpected_scheduler_mutation"); },
  };
  const transactions = createAutomationNodeTransactions({ persistence });
  const result: AutomationResultRecord = {
    id: "receipt", runId: "run", nodeId: "node",
    kind: path === "tool" ? "node_output" : "effect_receipt",
    storageRef: "run/receipt.json", digest: "digest", sizeBytes: 10,
    createdAt: "2026-09-30T10:00:01Z",
  };
  const settle = (patch: { notDispatched?: boolean; maxStoredArtifactBytes?: number;
    result?: AutomationResultRecord } = {}) => {
    const common = { runId: "run", nodeId: "node", result, notDispatched: true,
      maxStoredArtifactBytes: 100, ...patch };
    if (path === "tool") return transactions.settleNode({ ...common,
      attemptId: "attempt", status: "cancelled", errorCode: "automation_run_stopped" });
    return transactions.settleAgentAttempt({ ...common, invocationId: "attempt", uncertain: false });
  };
  return { persistence, result, settle };
}

for (const path of ["tool", "agent"] as const) {
  test(`${path} cannot settle a terminal uncertain effect without proof that dispatch never began`, async () => {
    const f = fixture(path);
    const before = await f.persistence.read();
    await expect(f.settle({ notDispatched: false })).rejects.toThrow();
    expect(await f.persistence.read()).toEqual(before);
    await f.settle();
    const after = await f.persistence.read();
    expect(after.attempts[0]).toMatchObject({ state: "settled", settlementRef: "receipt" });
    expect(after.executions[0]).toEqual({ ...before.executions[0], revision: 5 });
    expect(parseAutomationJournalState(after)).toEqual(after);
  });

  test.each(["run", "environment"] as const)(`${path} terminal receipt keeps the %s artifact budget`, async (budget) => {
    const f = fixture(path);
    if (budget === "environment") await f.persistence.update((state) => {
      state.results.push({ ...f.result, id: "other", runId: "other-run",
        sizeBytes: MAX_AUTOMATION_RESULT_BYTES });
    });
    const before = await f.persistence.read();
    await expect(f.settle({ maxStoredArtifactBytes: budget === "run" ? 9 : 100 }))
      .rejects.toThrow("automation_artifact_budget_exhausted");
    expect(await f.persistence.read()).toEqual(before);
  });

  test(`${path} terminal receipt cannot attach another node's evidence`, async () => {
    const f = fixture(path);
    const before = await f.persistence.read();
    await expect(f.settle({ result: { ...f.result, nodeId: "other" } }))
      .rejects.toThrow("automation_result_ref_invalid");
    expect(await f.persistence.read()).toEqual(before);
  });

  test(`${path} cannot rewrite an effect that already has underlying settlement evidence`, async () => {
    const f = fixture(path);
    await f.persistence.update((state) => {
      state.attempts[0] = { ...state.attempts[0]!, lateSettlement: {
        revision: 4, observedAt: "2026-09-30T10:00:01Z", status: "succeeded",
      } };
    });
    const before = await f.persistence.read();
    await expect(f.settle()).rejects.toThrow("automation_attempt_mismatch");
    expect(await f.persistence.read()).toEqual(before);
  });
}
