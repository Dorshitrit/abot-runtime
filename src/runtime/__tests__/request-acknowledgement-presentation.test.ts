import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type WebSocket from "ws";
import { afterEach, describe, expect, test } from "vitest";
import { createRuntimeEventBus } from "../events/runtime-emitter.js";
import { createRequestCallbacks } from "../streaming/request-callbacks.js";
import { SessionService } from "../../sessions/session-service.js";
import { compactRequestEvents } from "../../sessions/record/projection.js";
import type { SessionRuntimeEvent } from "../../sessions/types.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function sessionsFixture() {
  const root = join(process.cwd(), ".codex", "artifacts", "unified-work-timeline-20261028");
  await mkdir(root, { recursive: true });
  const sessionsDir = await mkdtemp(join(root, "ack-sessions-"));
  directories.push(sessionsDir);
  return new SessionService({ sessionsDir });
}

function streamHarness(persist?: (payload: Record<string, unknown>) => Promise<unknown>) {
  const sent: Record<string, unknown>[] = [];
  const ws = { send: (value: string) => sent.push(JSON.parse(value)) } as unknown as WebSocket;
  const events = createRuntimeEventBus({ requestId: "request", ws, persist });
  return { events, sent, callbacks: createRequestCallbacks(events, "request") };
}

function thinking(text: string, presentationKind?: string): Record<string, unknown> {
  return { type: "event", name: "thinking.delta", text, ...(presentationKind ? { presentationKind } : {}) };
}

function stored(payload: Record<string, unknown>, index: number): SessionRuntimeEvent {
  return {
    seqNo: index + 1, type: String(payload.type), requestId: "request",
    timestamp: "2026-10-28T12:00:00.000Z", payload,
  };
}

describe("acknowledgement presentation", () => {
  test("tags only the acknowledgement and keeps reasoning, answer and restoration separate", () => {
    const f = streamHarness();
    f.callbacks.onThinkingDelta("Private ");
    f.callbacks.onAcknowledgement("I will inspect the project.");
    f.callbacks.onThinkingDelta("reasoning.");
    f.callbacks.onAnswerToken("Exact answer.  ");
    expect(f.sent.slice(0, 3)).toMatchObject([
      { name: "thinking.delta", delta: "Private ", text: "Private " },
      { name: "thinking.delta", delta: "I will inspect the project.\n\n", text: "I will inspect the project.\n\n", presentationKind: "acknowledgement" },
      { name: "thinking.delta", delta: "reasoning.", text: "Private reasoning." },
    ]);
    expect(f.sent[0]).not.toHaveProperty("presentationKind");
    expect(f.sent[2]).not.toHaveProperty("presentationKind");
    expect(f.callbacks.snapshot()).toEqual({
      answerText: "Exact answer.  ", thinkingText: "Private reasoning.", thinkingTrace: [],
    });
    const restored = createRequestCallbacks(f.events, "request", f.callbacks.snapshot());
    restored.onThinkingDelta(" Continued.");
    expect(f.sent.at(-1)).toMatchObject({ text: "Private reasoning. Continued." });
    expect(f.sent.at(-1)).not.toHaveProperty("presentationKind");
    expect(restored.getAnswerText()).toBe("Exact answer.  ");
  });

  test.each([
    {
      name: "acknowledgement followed by reasoning",
      payloads: [thinking("Ack", "acknowledgement"), thinking("A"), thinking("AB")],
      sequences: [1, 3],
    },
    {
      name: "reasoning on both sides of an acknowledgement",
      payloads: [thinking("A"), thinking("AB"), thinking("Ack", "acknowledgement"), thinking("ABC"), thinking("ABCD")],
      sequences: [2, 3, 5],
    },
    {
      name: "successive acknowledgements are independent messages",
      payloads: [thinking("First", "acknowledgement"), thinking("Second", "acknowledgement")],
      sequences: [1, 2],
    },
    {
      name: "ordinary reasoning retains its snapshot compaction",
      payloads: [thinking("A"), thinking("AB"), thinking("ABC")],
      sequences: [3],
    },
    {
      name: "a marker on another event type cannot change token compaction",
      payloads: [{ type: "token", text: "A", presentationKind: "acknowledgement" }, { type: "token", text: "AB" }],
      sequences: [2],
    },
  ])("preserves event identity: $name", ({ payloads, sequences }) => {
    const events = payloads.map(stored);
    const original = structuredClone(events);
    expect(compactRequestEvents(events).map((event) => event.seqNo)).toEqual(sequences);
    expect(events).toEqual(original);
  });

  test("retains the marker and canonical order through durable activation persistence", async () => {
    const service = await sessionsFixture();
    await service.getOrCreateSession("conversation");
    const started = await service.requestLifecycle.startActivation("conversation", {
      requestId: "request", activationId: "activation", ownerEpoch: "owner",
    });
    if (!started.accepted) throw new Error(started.reason);
    let current = started.current;
    const f = streamHarness();
    f.callbacks.onThinkingDelta("Before");
    f.callbacks.onAcknowledgement("Inspecting now");
    f.callbacks.onThinkingDelta(" after");
    f.callbacks.onThinkingDelta(" more");
    for (const payload of f.sent) {
      const result = await service.requestLifecycle.appendActivationEvent("conversation", {
        expected: {
          requestId: "request", generation: current.generation, revision: current.revision,
          activationId: current.activation!.activationId, ownerEpoch: current.activation!.ownerEpoch,
        },
        payload,
      });
      if (!result.accepted) throw new Error(result.reason);
      current = result.current;
    }
    const replay = await service.getRequestReplayById("request");
    expect(replay?.events.map((event) => event.seqNo)).toEqual([1, 2, 4]);
    expect(replay?.events[1]).toMatchObject({
      name: "thinking.delta", presentationKind: "acknowledgement", text: "Inspecting now\n\n",
      generation: current.generation, activationId: "activation", eventSequence: 2, seqNo: 2,
    });
    expect(replay?.events[2]).toMatchObject({ text: "Before after more", eventSequence: 4 });
  });

  test("persists marked messages across adjacent snapshots and replays their exact metadata", async () => {
    const service = await sessionsFixture();
    await service.startRequestStream("conversation", "request");
    const f = streamHarness((payload) => service.appendRequestEvent("conversation", "request", payload));
    f.callbacks.onAcknowledgement("First");
    f.callbacks.onThinkingDelta("A");
    f.callbacks.onThinkingDelta("B");
    f.callbacks.onAcknowledgement("Second");
    f.callbacks.onAcknowledgement("Third");
    f.callbacks.onThinkingDelta("C");
    f.callbacks.onThinkingDelta("D");
    f.callbacks.onAnswerToken("Answer");
    f.callbacks.onAnswerToken(" complete");
    await f.events.drain();
    const replay = await service.getRequestReplayById("request");
    expect(replay?.events.map((event) => event.seqNo)).toEqual([1, 3, 4, 5, 7, 9]);
    expect(replay?.events.filter((event) => event.presentationKind === "acknowledgement").map((event) => ({
      text: event.text, delta: event.delta, eventSequence: event.eventSequence,
    }))).toEqual([
      { text: "First\n\n", delta: "First\n\n", eventSequence: 1 },
      { text: "Second\n\n", delta: "Second\n\n", eventSequence: 4 },
      { text: "Third\n\n", delta: "Third\n\n", eventSequence: 5 },
    ]);
    expect(replay?.events.at(-1)).toMatchObject({ type: "token", text: "Answer complete" });
    expect((await service.getRequestReplayById("request", 4))?.events.map((event) => event.seqNo)).toEqual([5, 7, 9]);
  });
});
