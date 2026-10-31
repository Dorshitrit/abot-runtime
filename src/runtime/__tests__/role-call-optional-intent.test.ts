import { afterEach, beforeEach, expect, test } from "vitest";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createRoleCallLedger, createRoleCallTransactions } from "../orchestration/role-calls/index.js";
import { captureRoleCallLedgerCheckpoint } from "../orchestration/role-calls/checkpoint.js";
import { decodeRoleCallCommand } from "../orchestration/role-calls/command-decoder.js";
import {
  createRoleCapabilitySelectionFingerprint,
  createRoleCapabilitySelectionProjection,
  normalizeRoleCapabilitySelectionProjection,
} from "../orchestration/role-calls/capability-selection-reconsideration.js";
import { ROLE_CAPABILITY_INVOCATION_INTENT_MAX_LENGTH } from "../orchestration/role-calls/contracts.js";
import { createRequestRoleCallPolicy } from "../request/role-call-policy.js";
import { EXECUTION_AGENT_V1_EXECUTION_POLICY } from "../request/role-executor-composition.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

const policy = createRequestRoleCallPolicy(EXECUTION_AGENT_V1_EXECUTION_POLICY);
const legacySelectionJson = '{"action":"invoke_capability","invocations":[{"capabilityId":"example.observe","intent":"Read the original target.","selectionControlsJson":"{\\"path\\":\\"input.txt\\"}"}],"workingDirectory":null,"activeCapabilityCatalogGroupIds":["files"]}';
const legacyFingerprint = 'sha256:50b3d9ef68f1a18523bdd65b687e7323441e085c77a2cac93a1dec7fdb16b8c1';

async function activeLedger() {
  const ledger = createRoleCallLedger({ requestId: "optional-intent", policy });
  const commands: unknown[] = [];
  const transactions = createRoleCallTransactions((input) => {
    commands.push(input.command);
    return ledger.apply(input);
  });
  expect(await transactions.createRoot({ expectedHead: ledger.current() })).toMatchObject({ ok: true });
  return { ledger, transactions, commands };
}

function singleCommand(intent?: unknown) {
  return {
    authority: "active_role", type: "begin_capability_execution",
    callId: "call-1", invocationAttempt: 1,
    capabilityId: "example.observe", declaredEffect: "observation",
    ...(intent !== undefined ? { intent } : {}), controlsJson: "{}",
  };
}

function batchCommand(intent?: unknown) {
  return {
    authority: "active_role", type: "begin_capability_batch",
    callId: "call-1", invocationAttempt: 1,
    entries: ["example.first", "example.second"].map((capabilityId) => ({
      capabilityId, declaredEffect: "observation",
      ...(intent !== undefined ? { intent } : {}), controlsJson: "{}",
    })),
  };
}

test.each([undefined, "Read the original target."])(
  "single transaction and checkpoint retain exact optional presentation: %s", async (intent) => {
    const { ledger, transactions, commands } = await activeLedger();
    const begun = await transactions.beginCapabilityExecution({
      expectedHead: ledger.current(), callId: "call-1", invocationAttempt: 1,
      capabilityId: "example.observe", declaredEffect: "observation", intent, controlsJson: "{}",
    });
    expect(begun).toMatchObject({ ok: true });
    expect(Object.hasOwn(commands.at(-1) as object, "intent")).toBe(intent !== undefined);
    const execution = ledger.current().state.capabilityExecutions[0]!;
    expect(execution.intent).toBe(intent);
    expect(Object.hasOwn(execution, "intent")).toBe(intent !== undefined);
    const checkpoint = JSON.parse(JSON.stringify(captureRoleCallLedgerCheckpoint(ledger)));
    const restored = createRoleCallLedger({ requestId: "optional-intent", policy, checkpoint });
    expect(JSON.stringify(captureRoleCallLedgerCheckpoint(restored))).toBe(JSON.stringify(checkpoint));
  },
);

test("batch transaction omits undefined metadata and preserves a legacy member unchanged", async () => {
  const { ledger, transactions, commands } = await activeLedger();
  const legacy = {
    capabilityId: "example.second", declaredEffect: "observation" as const,
    intent: "Read the original target.", controlsJson: "{}",
  };
  const result = await transactions.beginCapabilityBatch({
    expectedHead: ledger.current(), callId: "call-1", invocationAttempt: 1,
    entries: [
      { capabilityId: "example.first", declaredEffect: "observation", intent: undefined, controlsJson: "{}" },
      legacy,
    ],
  });
  expect(result).toMatchObject({ ok: true });
  const command = commands.at(-1) as { entries: object[] };
  expect(Object.hasOwn(command.entries[0]!, "intent")).toBe(false);
  expect(JSON.stringify(command.entries[1])).toBe(JSON.stringify(legacy));
  expect(ledger.current().state.capabilityExecutions.map((value) => value.intent))
    .toEqual([undefined, legacy.intent]);
  const checkpoint = JSON.parse(JSON.stringify(captureRoleCallLedgerCheckpoint(ledger)));
  const restored = createRoleCallLedger({ requestId: "optional-intent", policy, checkpoint });
  expect(JSON.stringify(captureRoleCallLedgerCheckpoint(restored))).toBe(JSON.stringify(checkpoint));
});

test.each([null, 42, true, "", " ", "x".repeat(ROLE_CAPABILITY_INVOCATION_INTENT_MAX_LENGTH + 1)])(
  "single and batch commands reject malformed supplied intent: case %#", (intent) => {
    expect(decodeRoleCallCommand(singleCommand(intent))).toEqual({ ok: false, code: "invalid_command" });
    expect(decodeRoleCallCommand(batchCommand(intent))).toEqual({ ok: false, code: "invalid_command" });
  },
);

test("legacy selection bytes and receipt fingerprint are unchanged", () => {
  const selection = normalizeRoleCapabilitySelectionProjection(JSON.parse(legacySelectionJson))!;
  expect(JSON.stringify(selection)).toBe(legacySelectionJson);
  expect(createRoleCapabilitySelectionFingerprint({ steeringVersion: 3, selection })).toBe(legacyFingerprint);
});

test.each([undefined, "Read the original target."])(
  "reconsideration survives checkpoint restore with optional metadata: %s", async (intent) => {
    const { ledger, transactions } = await activeLedger();
    expect(await transactions.updateCapabilityScope({
      expectedHead: ledger.current(), callId: "call-1", invocationAttempt: 1,
      mode: "open", catalogGroupIds: ["files"],
    })).toMatchObject({ ok: true });
    const selection = createRoleCapabilitySelectionProjection({
      action: "invoke_capability",
      invocations: [{ capabilityId: "example.observe", intent, selectionControls: { path: "input.txt" } }],
      workingDirectory: null, activeCapabilityCatalogGroupIds: ["files"],
    });
    expect(Object.hasOwn(selection.invocations[0]!, "intent")).toBe(intent !== undefined);
    expect(await transactions.reconsiderCapabilitySelection({
      expectedHead: ledger.current(), callId: "call-1",
      invocationAttempt: ledger.current().state.calls[0]!.activationCount, steeringVersion: 3, selection,
      cause: { kind: "refinement_declined", entries: [{ invocationIndex: 0, reason: "Controls need revision." }] },
    })).toMatchObject({ ok: true });
    expect(await transactions.beginCapabilityExecution({
      expectedHead: ledger.current(), callId: "call-1",
      invocationAttempt: ledger.current().state.calls[0]!.activationCount,
      capabilityId: "example.observe", declaredEffect: "observation", intent, controlsJson: "{}",
    })).toMatchObject({ ok: true });
    const checkpoint = JSON.parse(JSON.stringify(captureRoleCallLedgerCheckpoint(ledger)));
    const restored = createRoleCallLedger({ requestId: "optional-intent", policy, checkpoint });
    expect(JSON.stringify(captureRoleCallLedgerCheckpoint(restored))).toBe(JSON.stringify(checkpoint));
    const receipt = restored.current().state.calls[0]!.lastCapabilitySelectionReconsideration!;
    expect(receipt.fingerprint).toBe(createRoleCapabilitySelectionFingerprint({ steeringVersion: 3, selection }));
    if (intent !== undefined) expect(receipt.fingerprint).toBe(legacyFingerprint);
  },
);

test.each([null, 42, "", " ", " padded ", "x".repeat(ROLE_CAPABILITY_INVOCATION_INTENT_MAX_LENGTH + 1)])(
  "selection normalization rejects malformed or noncanonical supplied intent: case %#", (intent) => {
    const selection = JSON.parse(legacySelectionJson);
    selection.invocations[0].intent = intent;
    expect(normalizeRoleCapabilitySelectionProjection(selection)).toBeUndefined();
  },
);
