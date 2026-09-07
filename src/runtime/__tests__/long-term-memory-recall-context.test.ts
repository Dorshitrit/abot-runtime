import { afterEach, beforeEach, expect, test } from "vitest";
import { validateModelGatewayMessages } from "../../model-gateway/message-contract.js";
import { buildOpenAIResponsesPayload } from "../../model-gateway/providers/openai.js";
import { buildOllamaPayload } from "../../model-gateway/providers/ollama.js";
import type { ChatMessage, ModelGatewayRequest } from "../../model-gateway/types.js";
import { projectRootMemoryRecallMessage } from "../long-term-memory/recall-context.js";
import { projectMemoryRecallContinuations } from "../long-term-memory/recall-continuation.js";
import { buildExecutionContinuationMessages } from "../steps/execution-agent/state-context.js";
import { boundMemoryRecallResult } from "../long-term-memory/recall-result.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import {
  createRoleCallLedger,
  SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
  type RoleCallLedger,
  type RoleMemoryRecallResult,
  type RoleCallLedgerHead,
} from "../orchestration/role-calls/index.js";
import { MEMORY_RECORD } from "./support/memory-recall-runner.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

async function rootedLedger() {
  const ledger = createRoleCallLedger({
    requestId: "bounded-recall",
    policy: {
      authority: SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
      limits: {
        maxCalls: 16,
        maxDepth: 4,
        maxCapabilityExecutions: 16,
        maxObjectiveChars: 8192,
        maxResultChars: 8192,
        maxResponseChars: 65536,
      },
    },
  });
  const created = await ledger.transactions!.createRoot({
    expectedHead: ledger.current(),
  });
  if (!created.ok) throw new Error(created.issueCode);
  return ledger;
}

async function recall(
  ledger: RoleCallLedger,
  result: RoleMemoryRecallResult,
  steeringVersion = 0,
  query = "saved preference",
) {
  const binding = {
    callId: "call-1",
    invocationAttempt: ledger.current().state.calls[0]!.activationCount,
    steeringVersion,
  };
  const begun = await ledger.transactions!.beginMemoryRecall({
    expectedHead: ledger.current(),
    ...binding,
    query,
  });
  if (!begun.ok) throw new Error(begun.issueCode);
  const settled = await ledger.transactions!.settleMemoryRecall({
    expectedHead: begun.commit.head,
    ...binding,
    recallId: begun.commit.effect.recallId,
    result,
  });
  if (!settled.ok) throw new Error(settled.issueCode);
}

function project(
  ledger: RoleCallLedger,
  steeringVersion = 0,
  callId = "call-1",
) {
  return projectRootMemoryRecallMessage({
    head: ledger.current(),
    callId,
    steeringVersion,
  });
}

test("returns no context without recall, for a child, or for another steering version", async () => {
  const ledger = await rootedLedger();
  expect(project(ledger)).toBeUndefined();
  await recall(
    ledger,
    boundMemoryRecallResult({ available: true, records: [MEMORY_RECORD] }),
  );
  expect(project(ledger, 1)).toBeUndefined();
  expect(project(ledger, 0, "call-2")).toBeUndefined();
  expect(project(ledger)?.role).toBe("system");
  expect(JSON.parse(project(ledger)!.content)).toMatchObject({
    authority: "passive_reference",
    callId: "call-1",
    steeringVersion: 0,
    recalls: [
      {
        query: "saved preference",
        outcome: "found",
        memories: [MEMORY_RECORD],
      },
    ],
  });
});

test("bounds whole records including escapes and reports unavailable if none fits", () => {
  const large = {
    ...MEMORY_RECORD,
    id: "oversized",
    content: '"\\\n'.repeat(2500),
  };
  const result = boundMemoryRecallResult({
    available: true,
    records: [large, MEMORY_RECORD],
  });
  expect(result).toMatchObject({
    outcome: "found",
    records: [MEMORY_RECORD],
    omittedRecordCount: 1,
  });
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(6000);
  expect(
    boundMemoryRecallResult({ available: true, records: [large] }),
  ).toMatchObject({
    outcome: "unavailable",
    records: [],
    omittedRecordCount: 1,
  });
});

test("omits repeated IDs before the record limit and settles the unique records", async () => {
  const ledger = await rootedLedger();
  const otherRecord = { ...MEMORY_RECORD, id: "other-preference" };
  const result = boundMemoryRecallResult({
    available: true,
    records: [
      MEMORY_RECORD,
      ...Array.from({ length: 5 }, () => ({
        ...MEMORY_RECORD,
        content: "A lower-ranked duplicate must not replace the first record.",
      })),
      otherRecord,
    ],
  });
  await recall(ledger, result);
  expect(result).toEqual({
    outcome: "found",
    records: [MEMORY_RECORD, otherRecord],
    omittedRecordCount: 5,
  });
  expect(JSON.parse(project(ledger)!.content)).toMatchObject({
    recalls: [
      { memories: [MEMORY_RECORD, otherRecord], omittedRecordCount: 5 },
    ],
  });
});

test("keeps the aggregate capsule bounded and prefers newest values of a repeated memory id", async () => {
  const ledger = await rootedLedger();
  for (let index = 0; index < 9; index += 1) {
    const record = {
      ...MEMORY_RECORD,
      id: `memory-${index % 7}`,
      content: `revision-${index}: ` + "x".repeat(500),
    };
    await recall(
      ledger,
      boundMemoryRecallResult({ available: true, records: [record] }),
      0,
      `query-${index}`,
    );
  }
  const message = project(ledger)!;
  const capsule = JSON.parse(message.content);
  const memories = capsule.recalls.flatMap(
    (entry: { memories: unknown[] }) => entry.memories,
  );
  expect(message.content.length).toBeLessThanOrEqual(6000);
  expect(JSON.stringify(projectMemoryRecallContinuations(message)
    .flatMap(({ messages }) => messages)).length).toBeLessThanOrEqual(6000);
  expect(memories.length).toBeLessThanOrEqual(6);
  expect(new Set(memories.map((entry: { id: string }) => entry.id)).size).toBe(
    memories.length,
  );
  expect(memories).toContainEqual(
    expect.objectContaining({
      id: "memory-1",
      content: expect.stringContaining("revision-8:"),
    }),
  );
  expect(memories).not.toContainEqual(
    expect.objectContaining({
      content: expect.stringContaining("revision-1:"),
    }),
  );
  expect(capsule.omittedRecordCount).toBe(9 - memories.length);
});

test("declares omitted queries and removes superseded data", async () => {
  const ledger = await rootedLedger();
  for (let index = 0; index < 8; index += 1) {
    await recall(
      ledger,
      { outcome: "empty", records: [], omittedRecordCount: 0 },
      0,
      "q".repeat(1024),
    );
  }
  const message = project(ledger)!;
  expect(message.content.length).toBeLessThanOrEqual(6000);
  expect(JSON.stringify(projectMemoryRecallContinuations(message)
    .flatMap(({ messages }) => messages)).length).toBeLessThanOrEqual(6000);
  expect(JSON.parse(message.content).omittedRecallCount).toBeGreaterThan(0);
  await recall(
    ledger,
    { outcome: "superseded", records: [], omittedRecordCount: 0 },
    1,
  );
  expect(project(ledger, 1)).toBeUndefined();
});

test("retains empty versus unavailable and sanitizes provider failure text", async () => {
  const ledger = await rootedLedger();
  await recall(
    ledger,
    boundMemoryRecallResult({ available: true, records: [] }),
  );
  await recall(
    ledger,
    boundMemoryRecallResult({
      available: false,
      records: [],
      reason: "api_key=secret",
    }),
  );
  const message = project(ledger)!;
  expect(message.content).not.toContain("secret");
  expect(
    JSON.parse(message.content).recalls.map(
      (entry: { outcome: string }) => entry.outcome,
    ),
  ).toEqual(["empty", "unavailable"]);
});

test("links each bounded recall to its exact query and preserves provenance without duplicate records", async () => {
  const ledger = await rootedLedger();
  expect(projectMemoryRecallContinuations(project(ledger))).toEqual([]);
  for (const query of ["first query", 'second query with "quotes"']) {
    await recall(ledger, boundMemoryRecallResult({
      available: true, records: [MEMORY_RECORD],
    }), 0, query);
  }
  const groups = projectMemoryRecallContinuations(project(ledger));
  expect(groups.map(({ invocationAttempt }) => invocationAttempt)).toEqual([1, 2]);
  const messages = groups.flatMap(({ messages }) => messages);
  expect(() => validateModelGatewayMessages(messages)).not.toThrow();
  const records = [];
  for (const [index, group] of groups.entries()) {
    const [action, result] = group.messages;
    expect(action).toMatchObject({
      role: "assistant", toolCalls: [{ name: "recall_memory", callId: `recall-${index + 1}` }],
    });
    expect(result).toMatchObject({
      role: "tool", toolName: "recall_memory", toolCallId: `recall-${index + 1}`,
    });
    const capsule = JSON.parse(result.content);
    expect(capsule).toMatchObject({
      authority: "passive_reference", requestId: "bounded-recall", callId: "call-1", steeringVersion: 0,
    });
    expect(capsule.recalls).toHaveLength(1);
    const call = action.toolCalls![0];
    expect(JSON.parse(call.arguments)).toEqual({
      action: "recall_memory", query: capsule.recalls[0].query,
    });
    records.push(...capsule.recalls[0].memories);
  }
  expect(records).toEqual([MEMORY_RECORD]);
  expect(projectMemoryRecallContinuations(project(ledger, 1))).toEqual([]);
  expect(projectMemoryRecallContinuations(project(ledger, 0, "call-2"))).toEqual([]);
});

test.each(["openai", "ollama"] as const)("projects recall through the existing %s native tool lane", async (provider) => {
  const ledger = await rootedLedger();
  await recall(ledger, boundMemoryRecallResult({ available: true, records: [MEMORY_RECORD] }));
  const messages: ChatMessage[] = [
    { role: "user", content: "Exact current request" },
    ...projectMemoryRecallContinuations(project(ledger)).flatMap(({ messages }) => messages),
  ];
  const request: ModelGatewayRequest = {
    modelStep: "execution.decision", messages,
    modelPolicy: {
      providers: { [provider]: { type: provider } },
      profiles: { selected: { provider, model: "test-model", contextWindowTokens: 32768 } },
      defaults: { profileId: "selected" },
    },
  };
  if (provider === "openai") {
    expect(buildOpenAIResponsesPayload(request).input).toEqual([
      messages[0],
      { type: "function_call", call_id: "recall-1", name: "recall_memory", arguments: JSON.stringify({ action: "recall_memory", query: "saved preference" }) },
      { type: "function_call_output", call_id: "recall-1", output: messages[2].content },
    ]);
    return;
  }
  expect(buildOllamaPayload(request).messages).toMatchObject([
    messages[0],
    { role: "assistant", tool_calls: [{ function: { name: "recall_memory", arguments: { action: "recall_memory", query: "saved preference" } } }] },
    { role: "tool", tool_name: "recall_memory", content: messages[2].content },
  ]);
});

test("interleaves recall and capability pairs by activation while preserving capability-only callers", async () => {
  const ledger = await rootedLedger();
  for (let index = 0; index < 3; index++) {
    await recall(ledger, { outcome: "empty", records: [], omittedRecordCount: 0 });
  }
  const head: RoleCallLedgerHead = {
    ...ledger.current(),
    state: {
      ...ledger.current().state,
      capabilityExecutions: [{
        executionId: "execution-1", callId: "call-1", invocationAttempt: 2,
        capabilityId: "test.observation", declaredEffect: "observation",
        intent: "Observe", controlsJson: "{}", status: "settled", outcome: "succeeded",
        outcomeFingerprint: null, observedEffect: "observation", summary: "Observed",
        exactResult: { kind: "generic_capability_result_v1", authority: "capability_adapter", status: "executed", ok: true, payload: "Observed" },
      }],
    },
  };
  const recalls = projectMemoryRecallContinuations(project(ledger))
    .filter(({ invocationAttempt }) => invocationAttempt !== 2);
  const messages = buildExecutionContinuationMessages(head, head.state.calls[0], recalls);
  expect(() => validateModelGatewayMessages(messages)).not.toThrow();
  expect(messages.filter((message) => message.role === "tool")
    .map((message) => message.toolCallId)).toEqual(["recall-1", "execution-1", "recall-3"]);
  expect(buildExecutionContinuationMessages(head)).toEqual(messages.slice(2, 4));
});
