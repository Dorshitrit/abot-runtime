import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type WebSocket from "ws";
import { afterEach, expect, test } from "vitest";
import { SessionService } from "../../sessions/session-service.js";
import { isUserInteractionMessage } from "../../web-ui/app/lib/user-interaction-event.js";
import { createRuntimeEventBus } from "../events/runtime-emitter.js";
import { RequestActivationEvents } from "../request/approval-wait/activation-events.js";
import { createRequestUserInteractions } from "../user-interactions/request-service.js";
import { USER_INTERACTION_EVENT_NAME } from "../user-interactions/contracts.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("canonical Runtime messages survive durable storage and completed Web UI replay without replacing the final answer", async () => {
  const artifactRoot = join(process.cwd(), ".codex/artifacts/ea-user-interactions-20261027");
  await mkdir(artifactRoot, { recursive: true });
  const sessionsDir = await mkdtemp(join(artifactRoot, "interaction-roundtrip-"));
  directories.push(sessionsDir);
  const store = new SessionService({ sessionsDir });
  await store.appendMessage("session-1", "user", "Prepare release", { requestId: "request-1" });
  const started = await store.requestLifecycle.startActivation("session-1", {
    requestId: "request-1", activationId: "activation-1", ownerEpoch: "owner-1",
  });
  if (!started.accepted) throw new Error(started.reason);
  const live = createPlanLifecycleHarness();
  const finalMessageId = live.state.requestMessages.get("request-1");
  const wireEvents: Record<string, unknown>[] = [];
  const ws = {
    send(data: string) {
      const event = { ...JSON.parse(data), environment: "dev", sessionId: "session-1" };
      wireEvents.push(event);
      live.realtime.handle(event);
    },
  } as WebSocket;
  const owner = new RequestActivationEvents(
    store.requestLifecycle, started.current, { create: createRuntimeEventBus }, ws,
  );
  const interactions = createRequestUserInteractions({ requestId: "request-1", events: owner.events });
  const updates = ["בדקתי את הנתונים הראשוניים.", "The next check is ready."];
  for (const [index, text] of updates.entries()) {
    interactions.publish({ kind: "message", text }, {
      callId: "root-1", activationCount: index + 1, steeringVersion: 0,
    });
  }
  await owner.events.drain();
  expect(live.state.activeRequestId).toBe("request-1");
  expect(live.state.requestMessages.get("request-1")).toBe(finalMessageId);
  expect(live.state.messages.filter(isUserInteractionMessage).map((message) => message.text)).toEqual(updates);
  expect(live.drainQueuedComposerMessage).not.toHaveBeenCalled();

  const finalText = "  Final response\nwith exact spacing.  ";
  await owner.commit((expected) => store.requestLifecycle.commitTerminal("session-1", {
    expected, commandId: "finish-1", status: "completed", message: { content: finalText },
  }));
  expect(live.state.messages.filter(isUserInteractionMessage).map((message) => message.text)).toEqual(updates);
  expect(live.conversationSession.activeAssistantForRequest("request-1").text).toBe(finalText);

  // A new service reads the serialized record rather than sharing request memory.
  const diskStore = new SessionService({ sessionsDir });
  const persisted = await diskStore.getSessionById("session-1");
  expect(persisted?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  expect(persisted?.messages[1]?.content).toBe(finalText);
  const replay = await diskStore.getRequestReplayById("request-1");
  const replayUpdates = replay!.events.filter((event) => event.name === USER_INTERACTION_EVENT_NAME);
  expect(replayUpdates.map((event) => event.interaction)).toEqual(interactions.snapshot()!.recent);
  expect(replayUpdates.map((event) => event.generation)).toEqual([
    started.current.generation, started.current.generation,
  ]);
  expect(wireEvents.filter((event) => event.name === USER_INTERACTION_EVENT_NAME)
    .map((event) => event.interaction)).toEqual(replayUpdates.map((event) => event.interaction));
  const snapshot = await diskStore.getSessionSnapshot("session-1");
  const reopened = createPlanLifecycleHarness(snapshot as unknown as Record<string, unknown>);
  await reopened.conversationSession.openSession("session-1");
  for (const event of replay!.events)
    reopened.realtime.handle({ ...event, environment: "dev", sessionId: "session-1" });
  expect(reopened.state.messages.filter(isUserInteractionMessage).map((message) => message.text)).toEqual(updates);
  expect(reopened.conversationSession.activeAssistantForRequest("request-1").text).toBe(finalText);
  expect(reopened.state.messages.filter(isUserInteractionMessage)).toHaveLength(2);
  owner.events.dispose();
});
