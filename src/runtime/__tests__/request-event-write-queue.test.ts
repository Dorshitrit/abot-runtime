import { expect, test, vi } from "vitest";
import { RequestEventWriteQueue } from "../events/request-event-write-queue.js";

function writeGate() {
  let open!: () => void;
  const waiting = new Promise<void>((resolve) => { open = resolve; });
  return { waiting, open };
}

function thinking(text: string, delta = text) {
  return { type: "event", name: "thinking.delta", requestId: "request", text, delta };
}

test("a running write stays immutable while only its pending successor coalesces", async () => {
  const entered = writeGate();
  const finish = writeGate();
  const writes: Record<string, unknown>[] = [];
  const queue = new RequestEventWriteQueue(async (payload) => {
    writes.push(payload);
    if (writes.length !== 1) return;
    entered.open();
    await finish.waiting;
  }, (error) => { throw error; });
  queue.enqueue(thinking("a"));
  await entered.waiting;
  queue.enqueue(thinking("ab", "b"));
  queue.enqueue(thinking("abc", "c"));
  let drained = false;
  const drain = queue.drain().then(() => { drained = true; });
  await Promise.resolve();
  expect(drained).toBe(false);
  expect(writes).toEqual([thinking("a")]);
  finish.open();
  await drain;
  expect(writes).toEqual([thinking("a"), thinking("abc", "bc")]);
});

test("tool and approval boundaries cannot be crossed by pending snapshots", async () => {
  const writes: Record<string, unknown>[] = [];
  const queue = new RequestEventWriteQueue(async (payload) => { writes.push(payload); }, vi.fn());
  const tool = { type: "event", name: "tool.completed" };
  const approval = { type: "event", name: "tool.approval.required" };
  for (const payload of [thinking("a"), thinking("ab", "b"), tool,
    thinking("abc", "c"), approval, thinking("abcd", "d")]) queue.enqueue(payload);
  await queue.drain();
  expect(writes).toEqual([thinking("ab", "ab"), tool, thinking("abc", "c"), approval, thinking("abcd", "d")]);
});

test("lifecycle barriers retain their reserved order between snapshots", async () => {
  const writes: unknown[] = [];
  const queue = new RequestEventWriteQueue(async (payload) => { writes.push(payload.text); }, vi.fn());
  queue.enqueue(thinking("a"));
  const committed = queue.runBarrier(async () => { writes.push("commit"); return 7; });
  queue.enqueue(thinking("ab", "b"));
  expect(await committed).toBe(7);
  await queue.drain();
  expect(writes).toEqual(["a", "commit", "ab"]);
});

test("write failures are reported once and do not strand subsequent queued work", async () => {
  const failure = new Error("write_failed");
  const onError = vi.fn();
  const write = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
  const queue = new RequestEventWriteQueue(write, onError);
  queue.enqueue(thinking("a"));
  queue.enqueue({ type: "event", name: "tool.completed" });
  await queue.drain();
  expect(write).toHaveBeenCalledTimes(2);
  expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
  await expect(queue.runBarrier(async () => { throw new Error("commit_failed"); })).rejects.toThrow("commit_failed");
  queue.enqueue(thinking("ab", "b"));
  await queue.drain();
  expect(write).toHaveBeenCalledTimes(3);
});
