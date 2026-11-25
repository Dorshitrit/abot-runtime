import { afterEach, beforeEach, expect, test } from "vitest";
import { buildOpenAIResponsesPayload } from "../../model-gateway/providers/openai/payload.js";
import type { CapabilityDescriptor } from "../orchestration/capability-adapters/index.js";
import { createRoleCallLedger, type RoleCallLedger } from "../orchestration/role-calls/index.js";
import { captureRoleCallLedgerCheckpoint, restoreRoleCallLedgerCheckpoint } from "../orchestration/role-calls/checkpoint.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { RequestExecutionScope } from "../request/execution-scope.js";
import { validateJsonSchemaValue } from "../model/json-schema-value.js";
import { buildExecutionAgentInput } from "../steps/execution-agent/input.js";
import { createExecutionAgentDecisionFormat } from "../steps/execution-agent/format.js";
import { parseExecutionAgentDecisionOutput } from "../steps/execution-agent/decision-parsing.js";
import { parseStableExecutionAgentDecisionOutput } from "../steps/execution-agent/stable-decision-wire.js";
import { activeEvidenceCall, createControlsEvidenceFixture, evidenceDescriptor, runtimeCapsule } from "./support/execution-controls-evidence-fixture.js";
import { executionPrefixCachePolicy } from "./support/execution-prefix-cache-fixture.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";

const descriptors: readonly CapabilityDescriptor[] = [
  { ...evidenceDescriptor, capabilityId: "evidence.read", effect: "observation" },
  evidenceDescriptor,
  { capabilityId: "extra.inspect", summary: "Inspect the explicitly selected extra scope.",
    effect: "observation", catalogGroups: ["extra"],
    controls: { type: "object", properties: {}, required: [], additionalProperties: false } },
];
type Fixture = Awaited<ReturnType<typeof createControlsEvidenceFixture>>;
type Input = ReturnType<typeof buildExecutionAgentInput>;

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

function fixture(maxExecutions = 3, entries = descriptors) {
  return createControlsEvidenceFixture({ modelPolicy: executionPrefixCachePolicy,
    workerCapabilityProvider: { getDescriptors: () => entries, getAdapters: () => [] },
  }, maxExecutions);
}

async function changeScope(ledger: RoleCallLedger, mode: "open" | "extend", catalogGroupIds: string[]) {
  const head = ledger.current(), call = activeEvidenceCall(head);
  const result = await ledger.apply({ expectedHead: head, command: {
    authority: "active_role", type: "update_capability_scope", callId: call.callId,
    invocationAttempt: call.activationCount, mode, catalogGroupIds,
  } });
  if (!result.ok) throw new Error(`scoped_cache_fixture_${result.code}`);
}

async function freshLedger(f: Fixture, groups?: string[], requestId = f.request.requestId) {
  const ledger = createRoleCallLedger({ requestId, policy: f.ledger.current().policy });
  const created = await ledger.apply({ expectedHead: ledger.current(), command: { authority: "runtime", type: "create_root" } });
  if (!created.ok) throw new Error(`scoped_cache_fixture_${created.code}`);
  if (groups) await changeScope(ledger, "open", groups);
  return ledger;
}

function input(f: Fixture, ledger = f.ledger, request = f.request): Input {
  const head = ledger.current();
  return buildExecutionAgentInput(request, { head, call: activeEvidenceCall(head),
    steeringSnapshot: f.steering.snapshot(), includeAcknowledgement: false, includeTitle: false,
    allowPlanner: true, allowAuditor: true, observationGuidance: [],
  });
}

function payload(value: Input, request: RequestExecutionScope) {
  return buildOpenAIResponsesPayload({ modelPolicy: request.modelPolicy, agentMode: request.agentMode,
    modelStep: value.modelStep, messages: value.messages, format: value.format, promptCacheScope: request.sessionId,
    promptCacheBoundaryBeforeMessageIndex: value.messages.indexOf(value.promptCacheBoundaryBeforeMessage!),
  });
}

function schemaCapabilityIds(value: Input) {
  const ids = new Set<string>();
  function visit(node: unknown): void {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const capability = record.capabilityId as { enum?: string[] } | undefined;
    capability?.enum?.forEach((id) => ids.add(id));
    Object.values(record).forEach(visit);
  }
  visit(value.format.schema);
  return [...ids].sort();
}

function parse(value: Input, decision: Record<string, unknown>) {
  return parseStableExecutionAgentDecisionOutput(JSON.stringify({ decision: {
    ...decision,
  } }), value.contract, value.format);
}

function readSelection(path = "source.txt") {
  return { capabilityId: "evidence.read", selectionControls: { path, query: "Read the exact selected source." } };
}

function scopeSchemaIssue(value: Input, action: string, catalogGroupIds: string[]) {
  return validateJsonSchemaValue(value.format.schema, { decision: {
    action, catalogGroupIds,
  } });
}

test("discovery, explicit scope opening and extension change only the corresponding schema membership", async () => {
  const f = await fixture(), ledger = await freshLedger(f);
  const closed = input(f, ledger), original = JSON.stringify(ledger.current());
  expect(closed.stableDecisionWire).toBe(true);
  expect(schemaCapabilityIds(closed)).toEqual([]);
  expect(scopeSchemaIssue(closed, "open_capability_scope", ["evidence"])).toBeUndefined();
  expect(scopeSchemaIssue(closed, "extend_capability_scope", ["extra"])).toBeDefined();
  expect(parse(closed, { action: "open_capability_scope", catalogGroupIds: ["evidence"] })).toMatchObject({ ok: true });
  expect(parse(closed, { action: "open_capability_scope", catalogGroupIds: ["foreign"] })).toMatchObject({ ok: false });
  expect(parse(closed, { action: "invoke_capability", ...readSelection(), workingDirectory: null })).toMatchObject({ ok: false });
  expect(JSON.stringify(ledger.current())).toBe(original);

  await changeScope(ledger, "open", ["evidence"]);
  const opened = input(f, ledger);
  expect(schemaCapabilityIds(opened)).toEqual(["evidence.apply", "evidence.read"]);
  expect(input(f, ledger).format).toEqual(opened.format);
  expect(scopeSchemaIssue(opened, "open_capability_scope", ["extra"])).toBeDefined();
  expect(scopeSchemaIssue(opened, "extend_capability_scope", ["evidence"])).toBeDefined();
  expect(scopeSchemaIssue(opened, "extend_capability_scope", ["evidence", "extra"])).toBeDefined();
  expect(scopeSchemaIssue(opened, "extend_capability_scope", ["extra"])).toBeUndefined();
  expect(parse(opened, { action: "open_capability_scope", catalogGroupIds: ["extra"] })).toMatchObject({ ok: false });
  expect(parse(opened, { action: "extend_capability_scope", catalogGroupIds: ["extra"] })).toMatchObject({ ok: true });
  expect(parse(opened, { action: "extend_capability_scope", catalogGroupIds: ["evidence"] })).toMatchObject({ ok: false });
  expect(parse(opened, { action: "invoke_capability", capabilityId: "extra.inspect", workingDirectory: null })).toMatchObject({ ok: false });

  await changeScope(ledger, "extend", ["extra"]);
  const extended = input(f, ledger);
  expect(schemaCapabilityIds(extended)).toEqual(["evidence.apply", "evidence.read", "extra.inspect"]);
  expect(input(f, ledger).format).toEqual(extended.format);
  expect(scopeSchemaIssue(extended, "open_capability_scope", ["evidence"])).toBeDefined();
  expect(scopeSchemaIssue(extended, "extend_capability_scope", ["extra"])).toBeDefined();
  expect(parse(extended, { action: "invoke_capability", capabilityId: "extra.inspect", workingDirectory: null })).toMatchObject({ ok: true });
  expect(parse(extended, { action: "extend_capability_scope", catalogGroupIds: ["extra"] })).toMatchObject({ ok: false });
  const wires = [closed, opened, extended].map((value) => payload(value, f.request));
  expect(wires[0]!.tools).not.toEqual(wires[1]!.tools);
  expect(wires[1]!.tools).not.toEqual(wires[2]!.tools);
  expect(wires.map((wire) => wire.prompt_cache_key)).toEqual(Array(3).fill(wires[0]!.prompt_cache_key));
  expect(new Set([closed, opened, extended].map((value) => value.messages[0]!.content)).size).toBe(1);
  for (const value of [closed, opened, extended]) {
    expect(value.messages.filter((message) => message.role === "user" && message.content === f.request.prompt)).toHaveLength(1);
    expect(runtimeCapsule(value.messages, "runtime_execution_decision_contract_v1")).toMatchObject({
      authority: "runtime_state", presenceEffect: "no_new_user_intent_permission_work_or_completion_evidence",
    });
  }
  expect(f.request.toolPermissionMode).toBe("full_access");
  expect(f.invoke).not.toHaveBeenCalled();
});

test("scope and registry order plus serialized canonical-scope restoration preserve identical provider tools", async () => {
  const f = await fixture(), reversed = await fixture(3, [...descriptors].reverse());
  const first = await freshLedger(f, ["evidence", "extra"]);
  const otherOrder = await freshLedger(reversed, ["extra", "evidence"]);
  const beforeParking = input(f, first), call = activeEvidenceCall(first.current());
  expect(payload(input(reversed, otherOrder), reversed.request).tools)
    .toEqual(payload(beforeParking, f.request).tools);
  expect(await first.apply({ expectedHead: first.current(), command: {
    authority: "active_role", type: "begin_capability_execution", callId: call.callId,
    invocationAttempt: call.activationCount, capabilityId: "evidence.read", declaredEffect: "observation",
    intent: "Read the selected source.", controlsJson: JSON.stringify(readSelection().selectionControls),
  } })).toMatchObject({ ok: true });
  const checkpoint = JSON.parse(JSON.stringify(captureRoleCallLedgerCheckpoint(first)));
  const before = JSON.stringify(checkpoint);
  const restored = restoreRoleCallLedgerCheckpoint(checkpoint, {
    requestId: f.request.requestId, policy: first.current().policy,
  });
  expect(restored.current().state).toEqual(first.current().state);
  const result = { outcome: "succeeded", observedEffect: "observation", summary: "Read the selected source." };
  for (const ledger of [first, restored]) {
    expect(await ledger.apply({ expectedHead: ledger.current(), command: {
      authority: "runtime", type: "settle_capability_execution", callId: call.callId,
      executionId: ledger.current().state.capabilityExecutions[0]!.executionId, ...result,
      exactResult: { kind: "generic_capability_result_v1", authority: "capability_adapter",
        status: "executed", ok: true, payload: result },
    } })).toMatchObject({ ok: true });
  }
  const values = [input(f, first), input(f, restored)];
  const tools = values.map((value) => JSON.stringify(payload(value, f.request).tools));
  expect(new Set(tools).size).toBe(1);
  expect(values[1]!.contract).toEqual(values[0]!.contract);
  expect(values.map(schemaCapabilityIds)).toEqual(Array(2).fill(["evidence.apply", "evidence.read", "extra.inspect"]));
  expect(JSON.stringify(checkpoint)).toBe(before);
  expect(activeEvidenceCall(restored.current()).workerCapabilityScope).toEqual(call.workerCapabilityScope);
});

test("budget 2 to 1 to 0 preserves the schema at unchanged field availability and retains exact live acceptance", async () => {
  const f = await fixture(3);
  await f.addResult("Initial settled evidence establishes post-execution field availability.");
  const first = input(f);
  const executionId = await f.addResult("First exact source.");
  const oneLeft = input(f);
  const write = { action: "invoke_capability", capabilityId: "evidence.apply", selectionControls: { path: "target.txt" },
    operationObjective: "Apply the exact requested update.", controlsEvidenceExecutionIds: [executionId], workingDirectory: null };
  expect(parse(oneLeft, write)).toMatchObject({ ok: true });
  for (const evidence of [["foreign"], [executionId, executionId], [executionId, "foreign"]])
    expect(parse(oneLeft, { ...write, controlsEvidenceExecutionIds: evidence })).toMatchObject({ ok: false });
  const batch = { action: "invoke_capabilities", workingDirectory: null,
    invocations: [readSelection("one.txt"), readSelection("two.txt")] };
  expect(parse(first, batch)).toMatchObject({ ok: true });
  expect(parse(oneLeft, batch)).toMatchObject({ ok: false });
  await f.addResult("Second settled source failure.", { failed: true });
  const exhausted = input(f);
  expect([first, oneLeft, exhausted].map((value) => value.contract.maxBatchCapabilityExecutions)).toEqual([2, 1, 0]);
  expect([first, oneLeft, exhausted].map((value) => value.contract.eligibleControlsEvidenceExecutionIds?.length)).toEqual([1, 2, 3]);
  for (const value of [first, oneLeft, exhausted]) {
    expect(value.contract.directResponseMaxLength).toBeUndefined();
    expect(value.contract.allowAuditor).toBe(true);
    expect(value.contract.includeWorkingDirectory).toBe(true);
  }
  expect(exhausted.contract.capabilities).toEqual([]);
  expect(schemaCapabilityIds(exhausted)).toEqual(["evidence.apply", "evidence.read"]);
  const wires = [first, oneLeft, exhausted].map((value) => payload(value, f.request));
  expect(new Set(wires.map((wire) => JSON.stringify(wire.tools))).size).toBe(1);
  expect(wires[2]!.prompt_cache_key).toBe(wires[0]!.prompt_cache_key);
  const before = JSON.stringify(f.ledger.current());
  expect(parse(exhausted, write)).toMatchObject({ ok: false });
  expect(parse(exhausted, batch)).toMatchObject({ ok: false });
  expect(scopeSchemaIssue(exhausted, "extend_capability_scope", ["extra"])).toBeUndefined();
  expect(parse(exhausted, { action: "extend_capability_scope", catalogGroupIds: ["extra"] })).toMatchObject({ ok: true });
  expect(JSON.stringify(f.ledger.current())).toBe(before);
  expect(f.invoke).not.toHaveBeenCalled();
});

test("cache-disabled OpenAI retains the legacy format and removes exhausted capabilities from its schema", async () => {
  const f = await fixture(1);
  const { options: _options, ...profile } = f.request.modelPolicy!.profiles!.test!;
  const request = deriveTestRequestExecutionScope(f.request, {
    modelPolicy: { ...f.request.modelPolicy, profiles: { test: profile } },
  });
  const first = input(f, f.ledger, request);
  expect(schemaCapabilityIds(first)).toEqual(["evidence.apply", "evidence.read"]);
  await f.addResult("The permitted source read settled.");
  const exhausted = input(f, f.ledger, request);
  for (const value of [first, exhausted]) {
    expect(value.stableDecisionWire).toBeUndefined();
    expect(value.promptCacheBoundaryBeforeMessage).toBeUndefined();
    expect(value.format).toEqual(createExecutionAgentDecisionFormat(value.contract));
  }
  expect(exhausted.contract.maxBatchCapabilityExecutions).toBe(0);
  expect(exhausted.contract.capabilities).toEqual([]);
  expect(schemaCapabilityIds(exhausted)).toEqual([]);
  expect(scopeSchemaIssue(exhausted, "extend_capability_scope", ["extra"])).toBeUndefined();
  expect(parseExecutionAgentDecisionOutput(JSON.stringify({ decision: {
    action: "extend_capability_scope", catalogGroupIds: ["extra"],
  } }), exhausted.contract)).toMatchObject({ ok: true });
  expect(f.invoke).not.toHaveBeenCalled();
});

test("the same explicit scope across user turns preserves tools without rewriting history or current intent", async () => {
  const f = await fixture();
  const first = input(f);
  const history = [
    { id: "prior-user", role: "user" as const, content: f.request.prompt, createdAt: "2026-11-22T08:00:00Z" },
    { id: "prior-assistant", role: "assistant" as const, content: "The first bounded task is complete.", createdAt: "2026-11-22T08:00:01Z" },
  ];
  const originalHistory = JSON.stringify(history);
  const request = deriveTestRequestExecutionScope(f.request, { requestId: "next-scoped-request", requestSteering: undefined,
    prompt: "Inspect the separately named next target.", historyMessages: history,
    temporalContext: { currentDateTime: "2026-11-22 08:01:00 GMT", timeZone: "UTC" },
  });
  const ledger = await freshLedger(f, ["evidence"], request.requestId);
  const second = input(f, ledger, request);
  const before = JSON.stringify(ledger.current());
  const a = payload(first, f.request), b = payload(second, request);
  expect(b.tools).toEqual(a.tools);
  expect(b.prompt_cache_key).toBe(a.prompt_cache_key);
  expect(second.messages.slice(0, 2)).toEqual(first.messages.slice(0, 2));
  expect(second.messages.filter((message) => message.role === "user" && message.content === request.prompt)).toHaveLength(1);
  expect(second.messages.filter((message) => message.role === "user" && message.content === f.request.prompt)).toHaveLength(1);
  expect(second.messages.find((message) => message.content === history[1]!.content)?.role).toBe("assistant");
  expect(JSON.stringify(history)).toBe(originalHistory);
  expect(f.request.historyMessages).toEqual([]);
  expect(JSON.stringify(ledger.current())).toBe(before);
  expect(request.toolPermissionMode).toBe(f.request.toolPermissionMode);
});
