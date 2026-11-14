import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import { createLocalRuntimeOwner } from "../../local-host/app-owner.js";
import { createSchedulerRuntimeFixture } from "../support/scheduler-runtime-fixture.js";
import { makeOwnerControlPeer } from "../support/local-runtime-owner-peer.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function fixture() {
  const f = await createSchedulerRuntimeFixture("execution-agent-v1");
  cleanup.push(f.dispose);
  const store = f.application.services.sessions;
  const peer = makeOwnerControlPeer("recovery-view").peer;
  const invoke = vi.fn(async () => {
    throw new Error("startup_must_not_replay_a_model_call");
  });
  const start = async () => {
    const owner = await createLocalRuntimeOwner(f.config, { models: { invoke, invokeRaw: invoke } });
    const stop = async () => { await owner.stop(); await owner.whenIdle?.(); };
    cleanup.push(stop);
    return { owner, stop };
  };
  return { ...f, store, peer, start, recoveryModel: invoke };
}

test.each(["before_checkpoint", "after_checkpoint"])(
  "startup settles an abandoned command %s without replay or a chat turn",
  async (boundary) => {
    const f = await fixture();
    await f.store.appendMessage("session", "user", "Retain this preference. ".repeat(200), { requestId: "history" });
    await f.store.appendMessage("session", "assistant", "Confirmed preference. ".repeat(200), { requestId: "history" });
    f.invoke.mockResolvedValue({ text: JSON.stringify({ summary: "The user prefers brief answers." }), meta: {} });
    await f.application.requests.handle({ send() {} } as unknown as WebSocket, {
      type: "run_request", requestId: "command-1", sessionId: "session",
      command: { name: "compact", mode: "run" }, modelPreference: { profileId: "scheduled-model" },
    });
    const saved = (await f.store.getSessionById("session"))!;
    expect(saved.executionSessionMemoryCheckpoint).toBeDefined();
    const request = saved.requests!.find((entry) => entry.requestId === "command-1")!;
    expect(request.status).toBe("completed");
    expect(request.events).toHaveLength(2);
    await f.application.stop();
    // Reproduce the durable file at either crash boundary of the real command.
    // No active writer exists while constructing the interrupted snapshot.
    request.events = request.events.slice(0, 1);
    request.status = "streaming";
    request.lastSeqNo = 1;
    if (boundary === "before_checkpoint") delete saved.executionSessionMemoryCheckpoint;
    await writeFile(join(f.config.paths.sessionsDir, "session.json"), JSON.stringify(saved));

    const first = await f.start();
    const recovered = (await f.store.getSessionById("session"))!;
    const terminal = recovered.requests!.find((entry) => entry.requestId === "command-1")!;
    expect(terminal.status).toBe("failed");
    expect(terminal.events).toHaveLength(2);
    expect(terminal.events[1]!.payload).toMatchObject({
      type: "failed", name: "command.failed", requestKind: "command",
      command: { name: "compact", mode: "run" }, requestId: "command-1",
      sessionId: "session", seqNo: 2, error: "request_interrupted",
    });
    expect(terminal.events[1]!.payload).not.toHaveProperty("output");
    expect(recovered.messages).toEqual(saved.messages);
    expect(recovered.executionSessionMemoryCheckpoint).toEqual(saved.executionSessionMemoryCheckpoint);
    expect(f.recoveryModel).not.toHaveBeenCalled();
    expect(first.owner.isIdle?.()).toBe(true);
    const replay = await f.store.getRequestReplayById("command-1", 1, "session");
    expect(replay?.events).toEqual([{
      ...terminal.events[1]!.payload,
      timestamp: Date.parse(terminal.events[1]!.timestamp),
    }]);
    const snapshot = await first.owner.call("sessions.getSessionSnapshot", ["session"], f.peer);
    expect(snapshot).toMatchObject({ requests: [expect.objectContaining({ requestId: "command-1", status: "failed" })] });

    await first.stop();
    await f.start();
    expect(await f.store.getSessionById("session")).toEqual(recovered);
    expect(f.recoveryModel).not.toHaveBeenCalled();
  },
);

test.each(["completed", "failed"])("startup preserves a %s command and ordinary legacy streams", async (status) => {
  const f = await fixture();
  const command = { requestKind: "command", command: { name: "compact", mode: "run" }, sessionId: "session" };
  await f.store.appendRequestEvent("session", "settled", { ...command, type: "event", name: "command.started" });
  await f.store.appendRequestEvent("session", "settled", { ...command, type: status, name: status === "failed" ? "command.failed" : "context.compaction.completed" });
  await f.store.startRequestStream("session", "legacy-chat");
  const before = await f.store.getSessionById("session");
  await f.application.stop();
  await f.start();
  expect(await f.store.getSessionById("session")).toEqual(before);
  expect(f.recoveryModel).not.toHaveBeenCalled();
});
