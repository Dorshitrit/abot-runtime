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
import { SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT } from "../orchestration/role-calls/index.js";
import { createTestRequestExecutionScopeWithCapabilities } from "./support/request-execution-scope.js";
import { createTargetHandoffFixture, finalDispatchReport, targetHandoffSeed } from "./support/system-target-handoff-fixture.js";
import { createTargetHandoffScript, type HandoffModelInput } from "./support/system-target-handoff-script.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { resetDebugLoggerConfig(); vi.restoreAllMocks(); });

function isSupervisorConversationTurn(input: HandoffModelInput): boolean {
  if (input.modelStep === "supervisor.response") return true;
  if (input.modelStep !== "supervisor.decision") return false;
  if (typeof input.format !== "object") return true;
  return input.format?.name !== "supervisor_working_directory";
}

function initiativeReferences(messages: readonly ChatMessage[]) {
  return messages.flatMap(({ content }) => {
    try {
      const value = JSON.parse(content);
      return value.kind === "runtime_spark_initiative_reference_v1" ? [value] : [];
    } catch { return []; }
  });
}

test.each([true, false])("ordinary initiative history preserves the complete delegated chain (SPARK: %s)", async (markedSpark) => {
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
    const script = createTargetHandoffScript(() => {});
    const rootSteps: string[] = []; const childSteps: string[] = []; const excludedContexts: (readonly ChatMessage[])[] = [];
    let index = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      const call = script[index++]; expect(input.modelStep).toBe(call?.step);
      const messages = input.messages as readonly ChatMessage[];
      const references = initiativeReferences(messages);
      if (isSupervisorConversationTurn(input)) {
        rootSteps.push(input.modelStep!);
        expect(messages.filter(({ role, content }) => role === "user" && content === seed.prompt)).toHaveLength(1);
        expect(messages.filter(({ role, content }) => role === "assistant" && content === session.messages[0]!.content))
          .toEqual([{ role: "assistant", content: session.messages[0]!.content }]);
      } else {
        childSteps.push(input.modelStep!);
        excludedContexts.push([...messages]);
        if (input.modelStep !== "supervisor.decision")
          expect(messages.some(({ content }) => content === session.messages[0]!.content)).toBe(false);
      }
      expect(references).toEqual([]);
      expect(JSON.stringify(messages)).not.toContain(session.messages[0]!.initiative!.reason);
      expect(JSON.stringify(messages)).not.toContain(session.messages[0]!.initiative!.handoffBrief);
      return { text: typeof call!.output === "string" ? call!.output : call!.output(input), meta: {} };
    });
    const seed = { ...targetHandoffSeed(invoke, "ask"), sessionId: session.id, sessionMemory,
      historyMessages: sessionMemory.project().historyMessages, ...(markedSpark ? { sessionKind: "spark" as const } : {}) };
    const registry = await fixture.registry.prepareRequest!();
    const request = createTestRequestExecutionScopeWithCapabilities(seed, (view) => {
      expect(view).not.toHaveProperty("sessionKind");
      return createRequestWorkerCapabilityProvider({ request: view, executionPolicyAuthority: SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
        runtimeConfig: fixture.config, toolRegistryOverride: registry });
    });
    await expect(runRequestRunner(request)).resolves.toEqual({ output: finalDispatchReport });
    expect(index).toBe(script.length);
    for (const messages of excludedContexts) {
      expect(initiativeReferences(messages)).toEqual([]);
      expect(JSON.stringify(messages)).not.toContain(session.messages[0]!.initiative!.handoffBrief);
    }
    expect(rootSteps).toEqual(["supervisor.decision", "supervisor.decision", "supervisor.decision", "supervisor.response"]);
    expect(childSteps).toEqual(expect.arrayContaining(["planner.decision", "worker.decision", "worker.result", "reviewer.decision", "capability.controls"]));
    expect(fixture.executeHostOperation).toHaveBeenCalledTimes(2);
    expect(seed.toolApprovalController!.requestToolApproval).toHaveBeenCalledTimes(2);
    expect(seed.onAnswerToken).toHaveBeenCalledExactlyOnceWith(finalDispatchReport);
    expect(fixture.run).not.toHaveBeenCalled();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
