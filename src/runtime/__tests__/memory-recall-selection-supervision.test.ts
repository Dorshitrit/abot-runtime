import { afterEach, beforeEach, expect, test } from "vitest";
import {
  createRoleCallLedger,
  type RoleCallLedger,
} from "../orchestration/role-calls/index.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { projectImmediateCapabilityReconsideration } from "../steps/execution-agent/reconsideration-context.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

async function createScopedRoot() {
  const ledger = createRoleCallLedger({
    requestId: "recall-supervision",
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
        maxDepth: 2,
        maxCalls: 8,
        maxCapabilityExecutions: 16,
        maxObjectiveChars: 8192,
        maxResultChars: 8192,
        maxResponseChars: 65536,
      },
    },
  });
  await ledger.transactions!.createRoot({ expectedHead: ledger.current() });
  const scope = await ledger.transactions!.updateCapabilityScope({
    expectedHead: ledger.current(),
    callId: "call-1",
    invocationAttempt: 1,
    mode: "open",
    catalogGroupIds: ["read"],
  });
  if (!scope.ok) throw new Error(scope.issueCode);
  return ledger;
}

function reconsider(ledger: RoleCallLedger) {
  return ledger.transactions!.reconsiderCapabilitySelection({
    expectedHead: ledger.current(),
    callId: "call-1",
    invocationAttempt: ledger.current().state.calls[0]!.activationCount,
    steeringVersion: 0,
    selection: {
      action: "invoke_capability",
      workingDirectory: null,
      activeCapabilityCatalogGroupIds: ["read"],
      invocations: [
        {
          capabilityId: "files.read",
          intent: "Read the file.",
          selectionControlsJson: '{"path":"file.txt"}',
        },
      ],
    },
    cause: {
      kind: "refinement_declined",
      entries: [{ invocationIndex: 0, reason: "Missing control." }],
    },
  });
}

async function recall(ledger: RoleCallLedger) {
  const binding = {
    callId: "call-1",
    invocationAttempt: ledger.current().state.calls[0]!.activationCount,
    steeringVersion: 0,
  };
  const begun = await ledger.transactions!.beginMemoryRecall({
    expectedHead: ledger.current(),
    ...binding,
    query: "saved file preference",
  });
  if (!begun.ok) throw new Error(begun.issueCode);
  const settled = await ledger.transactions!.settleMemoryRecall({
    expectedHead: begun.commit.head,
    ...binding,
    recallId: begun.commit.effect.recallId,
    result: { outcome: "empty", records: [], omittedRecordCount: 0 },
  });
  if (!settled.ok) throw new Error(settled.issueCode);
}

test("memory reads preserve pre-execution repeat supervision through the terminal bound", async () => {
  const ledger = await createScopedRoot();
  for (let index = 1; index <= 3; index += 1) {
    const result = await reconsider(ledger);
    expect(result.ok).toBe(true);
    const before = ledger.current().state.capabilitySelectionSupervision;
    await recall(ledger);
    expect(ledger.current().state.capabilitySelectionSupervision).toBe(before);
    expect(before.records.at(-1)?.identityCount).toBe(index);
  }
  const before = ledger.current();
  expect(await reconsider(ledger)).toMatchObject({
    ok: false,
    issueCode: "capability_selection_supervision_limit_exceeded",
  });
  expect(ledger.current()).toBe(before);
  expect(before.state.capabilityExecutions).toEqual([]);
});

test("the next decision retains its latest reconsideration warning across context-only recall", async () => {
  const ledger = await createScopedRoot();
  expect((await reconsider(ledger)).ok).toBe(true);
  expect((await reconsider(ledger)).ok).toBe(true);
  await recall(ledger);
  const head = ledger.current();
  expect(
    projectImmediateCapabilityReconsideration(head, head.state.calls[0]!, 0),
  ).toMatchObject({
    outcome: "reconsidered_before_execution",
    supervision: { stage: "warning", matchingSelectionCount: 2 },
  });
  expect(
    projectImmediateCapabilityReconsideration(head, head.state.calls[0]!, 1),
  ).toBeUndefined();
});
