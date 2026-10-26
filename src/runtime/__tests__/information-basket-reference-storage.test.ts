import { afterEach, beforeEach, expect, test } from "vitest";
import { createKnowledgeSkillsCompactionFixture } from "./support/knowledge-skills-compaction-fixture.js";
import { captureRoleCallLedgerCheckpoint, restoreRoleCallLedgerCheckpoint } from "../orchestration/role-calls/checkpoint.js";
import { createRequestContextCompactionStore } from "../context/semantic-compaction/store.js";
import { assertSuperCompactionSourceIntegrity } from "../context/semantic-compaction/super-source-integrity.js";
import { buildBasketReferenceMessage } from "../information-basket/reference-context.js";
import { toBasketReferenceStorageMessage } from "../information-basket/reference-storage.js";
import { scanCompactionSources } from "../context/model-step-compaction-projection.js";
import { createSemanticCompactionSha256Fingerprint as hash } from "../context/semantic-compaction/contracts.js";
import { buildSupervisorDecisionInput } from "../steps/supervisor-decision/input.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

async function historicalFixture() {
  const f = await createKnowledgeSkillsCompactionFixture("supervisor-worker-v1");
  const commit = async (command: unknown) => {
    const result = await f.ledger.apply({ expectedHead: f.ledger.current(), command });
    if (!result.ok) throw new Error(result.code);
  };
  await commit({ authority: "active_role", type: "open_child", callerCallId: "call-1", roleId: "worker", objective: "Ordinary work" });
  const child = f.ledger.current().state.calls.at(-1)!;
  await commit({ authority: "active_role", type: "begin_capability_execution", callId: child.callId,
    invocationAttempt: child.activationCount, capabilityId: "fixture.save_report", declaredEffect: "mutation",
    intent: "Save a report", controlsJson: "{}", actionFingerprint: hash("pending-write"),
  });
  const checkpoint = captureRoleCallLedgerCheckpoint(f.ledger);
  const root = checkpoint.state.calls[0]!;
  const reference = {
    referenceId: "basket-reference-1", callId: root.callId,
    invocationAttempt: root.activationCount, steeringVersion: 0,
    selection: { action: "search_information_sources" as const, query: "historical query" },
    result: { outcome: "completed" as const, data: { status: "empty" as const, sources: [], omittedCount: 0 } },
  };
  const saved = { ...checkpoint, revision: checkpoint.revision + 1, state: {
    ...checkpoint.state, basketReferences: [reference],
    calls: [{ ...root, activationCount: root.activationCount + 1 }, ...checkpoint.state.calls.slice(1)],
  } };
  const ledger = restoreRoleCallLedgerCheckpoint(saved, { requestId: f.request.requestId, policy: saved.policy });
  const message = buildBasketReferenceMessage(f.request.requestId, reference);
  const source = scanCompactionSources([message], "historical", new Map())[0]!.source;
  return { ...f, ledger, saved, reference, message, source };
}

test("old SUPER basket receipts remain readable but are not projected or executable", async () => {
  const f = await historicalFixture();
  expect(captureRoleCallLedgerCheckpoint(f.ledger)).toEqual(f.saved);
  expect(f.source.content).toBe(JSON.stringify(toBasketReferenceStorageMessage(f.message)));
  const store = createRequestContextCompactionStore();
  store.registerSources([f.source]);
  expect(() => assertSuperCompactionSourceIntegrity({
    requestId: f.request.requestId, prompt: f.request.prompt, head: f.ledger.current(), store,
  })).not.toThrow();
  const input = buildSupervisorDecisionInput(f.request, { skillReadHead: f.ledger.current(), toolResults: { sourceRevision: f.ledger.current().revision, results: [] } });
  expect(JSON.stringify(input.context.messages)).not.toContain("historical query");
  expect(JSON.stringify(input.format)).not.toContain("information_source");
  const { referenceId: _, ...payload } = f.reference;
  const attempt = await f.ledger.apply({ expectedHead: f.ledger.current(), command: {
    authority: "runtime", type: "record_basket_reference", ...payload,
  } });
  expect(attempt.ok).toBe(false);
  expect(captureRoleCallLedgerCheckpoint(f.ledger)).toEqual(f.saved);
});

test("tampered historical receipt still fails source-integrity validation", async () => {
  const f = await historicalFixture();
  const content = f.source.content.replace("historical query", "forged query");
  const store = createRequestContextCompactionStore();
  store.registerSources([{ ...f.source, content, sourceFingerprint: hash(content) }]);
  expect(() => assertSuperCompactionSourceIntegrity({
    requestId: f.request.requestId, prompt: f.request.prompt, head: f.ledger.current(), store,
  })).toThrow("context_compaction_basket_reference_changed");
});
