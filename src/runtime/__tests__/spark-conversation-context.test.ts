import { supervisorFormatName } from "./support/supervisor-model-phases.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import { ensureSparkSession } from "../../sessions/spark-session.js";
import { buildSparkConversationInstructions } from "../context/spark-conversation-policy.js";
import { loadRequestRunnerConfig } from "../config/runner/loader.js";
import { snapshotRequestSeed } from "../request/approval-wait/snapshot.js";
import { createRequestSeedFacets } from "../request/execution-facets.js";
import { createCapabilityCompositionView, createCapabilityExecutionView } from "../request/execution-scope-surfaces.js";
import type { RequestExecutionSeed } from "../request/contracts.js";
import { buildSupervisorMemoryAuthoringInput, buildSupervisorResponseInput } from "../steps/supervisor-response/input.js";
import { createRequestSessionMemory } from "../context/session-memory/index.js";
import { createRoleCallLedger } from "../orchestration/role-calls/index.js";
import { EXECUTION_AGENT_V1_EXECUTION_POLICY } from "../request/role-executor-composition.js";
import { createRequestSteeringInbox } from "../request/request-steering.js";
import { buildExecutionAgentResponseInput } from "../steps/execution-agent/response-input.js";
import { resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createSchedulerRuntimeFixture, scheduledModelMessages } from "./support/scheduler-runtime-fixture.js";

type Fixture = Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
  vi.restoreAllMocks();
  resetDebugLoggerConfig();
});

async function fixture(policy: "execution-agent-v1" | "supervisor-worker-v1") {
  const value = await createSchedulerRuntimeFixture(policy);
  fixtures.push(value);
  return value;
}

async function run(value: Fixture, sessionId: string, requestId: string, extra = {}) {
  const events: Record<string, unknown>[] = [];
  await value.application.requests.handle({
    send(data: string) { events.push(JSON.parse(data)); },
  } as unknown as WebSocket, {
    type: "run_request", requestId, sessionId,
    text: "Help me think through a completely new topic.",
    agentMode: "reasoning", toolPermissionMode: "ask",
    modelPreference: { profileId: "scheduled-model", scope: "all" },
    ...extra,
  });
  return events;
}

describe("SPARK canonical conversation policy", () => {
  test.each((["execution-agent-v1", "supervisor-worker-v1"] as const).flatMap((policy) => [
    { policy, language: "Hebrew", prompt: "אני רוצה לחשוב איתך על נושא חדש לגמרי." },
    { policy, language: "English", prompt: "Help me think through a completely new topic." },
    { policy, language: "explicit language override", prompt: "בוא נחשוב על נושא חדש, אבל תענה לי באנגלית." },
  ]))(
    "$policy supplies current $language input and presentation policy only to the marked session",
    async ({ policy, prompt }) => {
      const value = await fixture(policy);
      const sessions = value.application.services.sessions;
      const spark = await ensureSparkSession(sessions);
      await sessions.updateSessionTitle(spark.id, "Renamed companion");
      await sessions.appendMessage(spark.id, "user", "Earlier question");
      await sessions.appendMessage(spark.id, "assistant", "Earlier ordinary answer");
      await sessions.appendAssistantInitiative!(spark.id, {
        title: "Earlier idea", content: "An earlier idea you may want to consider.",
        initiative: { kind: "proactive_proposal_v1", proposalId: "prior-suggestion", reason: "Relevant stored context",
          sources: [{ kind: "memory", id: "memory-1", version: "1" }], handoffBrief: "A saved, tentative interest in the earlier idea." },
      });
      await run(value, spark.id, "spark-request", { text: prompt });
      const root = policy === "execution-agent-v1" ? "execution" : "supervisor";
      expect(value.invoke.mock.calls.map(([input]) => supervisorFormatName(input) ?? input.modelStep)).toEqual(
        policy === "execution-agent-v1" ? [`${root}.decision`, `${root}.response`] : [
          "supervisor_presentation", "supervisor_skill_selection", "supervisor_procedure_gate", "supervisor.response",
        ],
      );
      const policyBlock = buildSparkConversationInstructions("spark").join("\n");
      for (const [input] of value.invoke.mock.calls) {
        const messages = scheduledModelMessages(input);
        expect(messages[0].role).toBe("system");
        expect(messages.filter((message) => message.role === "user" && message.content === prompt)).toHaveLength(1);
        const phase = supervisorFormatName(input);
        if (["supervisor_presentation", "supervisor_skill_selection", "supervisor_procedure_gate"].includes(phase ?? "")) {
          expect(messages[0].content).not.toContain(policyBlock);
          expect(messages.filter(({ role }) => role !== "system")).toEqual([{ role: "user", content: prompt }]);
          expect(JSON.stringify(messages)).not.toContain("Relevant stored context");
          expect(JSON.stringify(messages)).not.toContain("A saved, tentative interest in the earlier idea.");
          continue;
        }
        expect(messages[0].content.split(policyBlock)).toHaveLength(2);
        expect(messages.find((message) => message.content === "An earlier idea you may want to consider.")?.role).toBe("assistant");
        const conversationContents = new Set(["Earlier question", "Earlier ordinary answer",
          "An earlier idea you may want to consider.", prompt]);
        expect(messages.filter(({ content }) => conversationContents.has(content))).toEqual([
          { role: "user", content: "Earlier question" },
          { role: "assistant", content: "Earlier ordinary answer" },
          { role: "assistant", content: "An earlier idea you may want to consider." },
          { role: "user", content: prompt },
        ]);
        expect(JSON.stringify(messages)).not.toContain("Relevant stored context");
        expect(JSON.stringify(messages)).not.toContain("A saved, tentative interest in the earlier idea.");
        expect(messages.filter(({ role }) => role === "system").flatMap(({ content }) => {
          try { return [JSON.parse(content).kind]; } catch { return []; }
        })).not.toContain("runtime_spark_initiative_reference_v1");
      }
      expect(value.invokeRaw).not.toHaveBeenCalled();
      const saved = await sessions.getSessionById(spark.id);
      expect(saved?.messages.filter((message) => message.role === "user")).toHaveLength(2);
      expect(saved?.messages.at(-1)?.role).toBe("assistant");

      value.invoke.mockClear();
      await sessions.updateSessionTitle("session", "ABOT SPARK");
      await run(value, "session", "ordinary-request", { sessionKind: "spark", text: prompt });
      for (const [input] of value.invoke.mock.calls) {
        const messages = scheduledModelMessages(input);
        expect(messages[0].content).not.toContain(policyBlock);
        expect(messages.some((message) => message.content === "An earlier idea you may want to consider.")).toBe(false);
      }
    },
  );

  test("durable approval keeps the canonical kind; capability views and memory extraction omit presentation policy", async () => {
    const value = await fixture("supervisor-worker-v1");
    const runnerConfig = loadRequestRunnerConfig(value.config.requestRunner!);
    const sessions = value.application.services.sessions;
    const spark = await sessions.appendAssistantInitiative!("spark-companion", {
      title: "Previous initiative", content: "A previous assistant suggestion.",
      initiative: { kind: "proactive_proposal_v1", proposalId: "memory-exclusion", reason: "Saved reason",
        sources: [{ kind: "memory", id: "source", version: "1" }], handoffBrief: "Saved background" },
    });
    const sessionMemory = createRequestSessionMemory({ sessionId: spark.id, session: spark, repository: sessions,
      compactor: { compact: async () => "Unused" } });
    const seed: RequestExecutionSeed = {
      requestId: "request", sessionId: "spark-companion", sessionKind: "spark",
      prompt: "Remember this preference", historyMessages: [], sessionMemory, shouldGenerateSessionTitle: false,
      runnerConfig, modelPolicy: value.config.models, agentMode: "deep", toolPermissionMode: "ask",
      modelGatewayClient: { invoke: value.invoke, invokeRaw: value.invokeRaw },
      abortSignal: new AbortController().signal,
      onAcknowledgement() {}, onSessionTitle: async () => {}, onThinkingDelta() {},
      onThinkingTrace() {}, onAnswerToken() {}, onEvent() {},
    };
    expect(snapshotRequestSeed(seed).sessionKind).toBe("spark");
    const facets = createRequestSeedFacets(seed);
    expect(facets.session.sessionKind).toBe("spark");
    const modelSteps = { invoke: vi.fn() };
    expect(createCapabilityCompositionView(facets, modelSteps)).not.toHaveProperty("sessionKind");
    expect(createCapabilityExecutionView(facets, undefined, modelSteps)).not.toHaveProperty("sessionKind");
    const options = {
      call: { rootCallId: "call", callId: "call", parentCallId: null, depth: 0, invocationAttempt: 1 },
      toolResults: { sourceRevision: 0, results: [] },
    };
    const { sessionKind: omitted, ...ordinary } = seed;
    const metadataKind = '"kind":"runtime_spark_initiative_reference_v1"';
    expect(buildSupervisorResponseInput(seed, options).context.messages.some(({ content }) => content.includes(metadataKind))).toBe(false);
    expect(buildSupervisorMemoryAuthoringInput(seed, options).context.messages.some(({ content }) => content.includes(metadataKind))).toBe(false);
    expect(buildSupervisorMemoryAuthoringInput(seed, options).context.messages)
      .toEqual(buildSupervisorMemoryAuthoringInput(ordinary, options).context.messages);
    const ledger = createRoleCallLedger({ requestId: seed.requestId, policy: {
      authority: EXECUTION_AGENT_V1_EXECUTION_POLICY.authority,
      limits: { maxDepth: 4, maxCalls: 8, maxCapabilityExecutions: 8,
        maxObjectiveChars: 6000, maxResultChars: 20000, maxResponseChars: 6000 },
    } });
    const created = await ledger.apply({ expectedHead: ledger.current(), command: { authority: "runtime", type: "create_root" } });
    expect(created.ok).toBe(true);
    const head = ledger.current();
    const combined = buildExecutionAgentResponseInput(seed, {
      head, call: head.state.calls[0]!, steeringSnapshot: createRequestSteeringInbox({ requestId: seed.requestId }).snapshot(),
      memoryAuthoringMaxResponseChars: 4000,
    });
    expect(combined.messages.filter(({ content }) => content.includes(metadataKind))).toHaveLength(0);
    for (const messages of [combined.messages, buildSupervisorResponseInput(seed, options).context.messages,
      buildSupervisorMemoryAuthoringInput(seed, options).context.messages]) {
      expect(messages.filter(({ content }) => content === spark.messages[0]!.content || content === seed.prompt)).toEqual([
        { role: "assistant", content: spark.messages[0]!.content },
        { role: "user", content: seed.prompt },
      ]);
      expect(JSON.stringify(messages)).not.toContain(spark.messages[0]!.initiative!.reason);
      expect(JSON.stringify(messages)).not.toContain(spark.messages[0]!.initiative!.handoffBrief);
    }
    expect(combined.messages.filter(({ role, content }) => role === "user" && content === seed.prompt)).toHaveLength(1);
  });
});
