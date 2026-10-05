import { afterEach, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import { buildSparkConversationInstructions } from "../context/spark-conversation-policy.js";
import { resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createSchedulerRuntimeFixture, scheduledModelMessages } from "./support/scheduler-runtime-fixture.js";

type Fixture = Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
  vi.restoreAllMocks();
  resetDebugLoggerConfig();
});

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
  "%s receives a chosen work-session brief as prior assistant background and waits for actual user intent", async (policy) => {
    const fixture = await createSchedulerRuntimeFixture(policy);
    fixtures.push(fixture);
    const brief = "Original background: an uncertain interest in a community garden. Possible next step: compare locations. No work has been done; waiting for the user to decide where to begin.";
    const sessions = fixture.application.services.sessions;
    const target = await sessions.createAssistantConversation!("spark-work-context", {
      title: "Garden idea", content: brief,
      initiative: { kind: "proactive_proposal_v1", proposalId: "garden-proposal",
        reason: "An earlier conversation suggested this interest",
        sources: [{ kind: "candidate", id: "garden-interest", version: "1" }],
        handoffBrief: brief, handoffTitle: "Garden idea" },
    });
    expect(target.kind).toBeUndefined();
    expect(target.messages.map(({ role }) => role)).toEqual(["assistant"]);
    expect(fixture.invoke).not.toHaveBeenCalled();
    expect(fixture.invokeRaw).not.toHaveBeenCalled();

    const text = "Before that, help me think about a completely different topic.";
    await fixture.application.requests.handle({ send() {} } as unknown as WebSocket, {
      type: "run_request", requestId: "work-session-user-request", sessionId: target.id,
      text, agentMode: "reasoning", toolPermissionMode: "ask",
      modelPreference: { profileId: "scheduled-model", scope: "all" },
    });
    const root = policy === "execution-agent-v1" ? "execution" : "supervisor";
    expect(fixture.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
      `${root}.decision`, `${root}.response`,
    ]);
    const companionPolicy = buildSparkConversationInstructions("spark").join("\n");
    for (const [input] of fixture.invoke.mock.calls) {
      const messages = scheduledModelMessages(input);
      expect(messages.filter((message) => message.role === "user" && message.content === text)).toHaveLength(1);
      expect(messages.filter((message) => message.role === "user").some((message) => message.content === brief)).toBe(false);
      expect(messages.filter((message) => message.content === brief).map(({ role }) => role)).toEqual(["assistant"]);
      expect(messages.some((message) => message.content.includes(companionPolicy))).toBe(false);
    }
    expect((await sessions.getSessionById(target.id))!.messages.filter(({ role }) => role === "user").map(({ content }) => content)).toEqual([text]);
  },
);
