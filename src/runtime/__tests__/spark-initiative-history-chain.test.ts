import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { appendSparkInitiativeRecord } from "../../sessions/assistant-initiative-append.js";
import { SPARK_SESSION_ID } from "../../sessions/spark-session.js";
import type { ModelGatewayClient } from "../ports.js";
import { createRequestSessionMemory } from "../context/session-memory/controller.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { runRequestRunner } from "../request/runner.js";
import { createRequestWorkerCapabilityProvider } from "../request/worker-capability-composition.js";
import { resolveRequestExecutionPolicy } from "../request/role-executor-composition.js";
import { createTestRequestExecutionScopeWithCapabilities } from "./support/request-execution-scope.js";
import { createTargetHandoffFixture, finalDispatchReport } from "./support/system-target-handoff-fixture.js";
import { createTargetEaScript, targetEaSeed } from "./support/system-target-ea-script.js";
import type { HandoffModelInput } from "./support/system-target-handoff-script.js";
import { supervisorFormatName, withSupervisorPreparation } from "./support/supervisor-model-phases.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { resetDebugLoggerConfig(); vi.restoreAllMocks(); });

function isExecutionConversationTurn(input: HandoffModelInput): boolean {
  return input.modelStep === "execution.response" || input.modelStep === "execution.decision";
}

function initiativeReferences(messages: readonly ChatMessage[]) {
  return messages.flatMap(({ content }) => {
    try {
      const value = JSON.parse(content);
      return value.kind === "runtime_spark_initiative_reference_v1" ? [value] : [];
    } catch { return []; }
  });
}

test.each([true, false])("ordinary initiative history preserves the complete EA SYSTEM request (SPARK: %s)", async (markedSpark) => {
  const parent = join(process.cwd(), ".codex/artifacts/spark-initiative-history-chain-tests");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "fixture-"));
  try {
    const fixture = createTargetHandoffFixture(directory);
    await mkdir(fixture.config.paths.agentWorkDir);
    const session = appendSparkInitiativeRecord(null, SPARK_SESSION_ID, {
      title: "A saved idea", content: "I can help inspect an application.",
      initiative: { kind: "proactive_proposal_v1", proposalId: "chain-initiative",
        reason: "Saved historical interest in installed applications.",
        handoffBrief: "Historical background for the saved idea; no action has been authorized.",
        sources: [{ kind: "candidate", id: "interest", version: "1" }] },
    }, new Date("2026-10-02T09:00:00Z"));
    const sessionMemory = createRequestSessionMemory({ sessionId: session.id, session,
      repository: { compareAndSwapSessionMemoryCheckpoint: async () => { throw new Error("unexpected_checkpoint_write"); } },
      compactor: { compact: async () => { throw new Error("unexpected_compaction"); } } });
    const executionPolicy = resolveRequestExecutionPolicy("execution-agent-v1");
    const script = createTargetEaScript();
    const rootSteps: string[] = []; const childSteps: string[] = []; const excludedContexts: (readonly ChatMessage[])[] = [];
    let index = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(withSupervisorPreparation(async (input) => {
      const call = script[index++]; expect(input.modelStep).toBe(call?.step);
      const messages = input.messages as readonly ChatMessage[];
      const references = initiativeReferences(messages);
      if (isExecutionConversationTurn(input)) {
        rootSteps.push(input.modelStep!);
        expect(messages.filter(({ role, content }) => role === "user" && content === seed.prompt)).toHaveLength(1);
        expect(messages.filter(({ role, content }) => role === "assistant" && content === session.messages[0]!.content))
          .toEqual([{ role: "assistant", content: session.messages[0]!.content }]);
      } else {
        childSteps.push(input.modelStep!);
        excludedContexts.push([...messages]);
        expect(messages.some(({ content }) => content === session.messages[0]!.content)).toBe(false);
      }
      expect(references).toEqual([]);
      expect(JSON.stringify(messages)).not.toContain(session.messages[0]!.initiative!.reason);
      expect(JSON.stringify(messages)).not.toContain(session.messages[0]!.initiative!.handoffBrief);
      return { text: typeof call!.output === "string" ? call!.output : call!.output(input), meta: {} };
    }, { classifyProcedure: () => ({ requiresProcedure: true }) }));
    const seed = { ...targetEaSeed(invoke, "ask"), sessionId: session.id, sessionMemory,
      historyMessages: sessionMemory.project().historyMessages, ...(markedSpark ? { sessionKind: "spark" as const } : {}) };
    const registry = await fixture.registry.prepareRequest!({ requestId: seed.requestId,
      executionPolicy: executionPolicy.authority.id, rootContractId: executionPolicy.rootContract.contractId });
    const request = createTestRequestExecutionScopeWithCapabilities(seed, (view) => {
      expect(view).not.toHaveProperty("sessionKind");
      return createRequestWorkerCapabilityProvider({ request: view, executionPolicyAuthority: executionPolicy.authority,
        runtimeConfig: fixture.config, toolRegistryOverride: registry });
    }, { executionPolicy });
    await expect(runRequestRunner(request)).resolves.toMatchObject({ output: finalDispatchReport, outputTextMode: "exact" });
    expect(index).toBe(script.length);
    const preparation = invoke.mock.calls.filter(([input]) => ["supervisor_presentation", "supervisor_skill_selection"].includes(supervisorFormatName(input) ?? ""));
    expect(preparation).toEqual([]);
    for (const [input] of preparation) {
      const messages = input.messages as readonly ChatMessage[];
      expect(messages.filter(({ role, content }) => role === "user" && content === seed.prompt)).toHaveLength(1);
      expect(messages.some(({ content }) => content === session.messages[0]!.content)).toBe(false);
      expect(initiativeReferences(messages)).toEqual([]);
      expect(JSON.stringify(messages)).not.toContain(session.messages[0]!.initiative!.handoffBrief);
    }
    for (const messages of excludedContexts) {
      expect(initiativeReferences(messages)).toEqual([]);
      expect(JSON.stringify(messages)).not.toContain(session.messages[0]!.initiative!.handoffBrief);
    }
    expect(rootSteps).toEqual(["execution.decision", "execution.decision", "execution.decision", "execution.decision", "execution.response"]);
    expect(childSteps).toEqual(["capability.controls"]);
    expect(fixture.executeHostOperation).toHaveBeenCalledTimes(2);
    expect(seed.toolApprovalController!.requestToolApproval).toHaveBeenCalledTimes(2);
    expect(seed.onAnswerToken).toHaveBeenCalledExactlyOnceWith(finalDispatchReport);
    expect(fixture.run).not.toHaveBeenCalled();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
