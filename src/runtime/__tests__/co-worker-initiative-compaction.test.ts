import { describe, expect, test } from "vitest";
import { resolveApplicableSessionMemoryCheckpoint } from "../../sessions/memory/rules.js";
import { captureRequestSessionMemory, restoreRequestSessionMemory } from "../context/session-memory/snapshot.js";
import { projectRequestContext } from "../context/request-context.js";
import type { BoundRequestModelInvocationContext } from "../request/contracts.js";
import { initiative, memoryFor, ordinaryTurn, session } from "./support/initiative-session-memory-fixture.js";

const request = {} as BoundRequestModelInvocationContext;

describe("ordinary assistant initiative compaction", () => {
  test("compacts an initiative-only prefix and keeps exactly the latest ten units raw", async () => {
    const record = session(Array.from({ length: 35 }, (_, index) => initiative(index)));
    const { memory, compact } = memoryFor(record);
    expect(memory.project().compactableTurnCount).toBe(25);
    const prepared = await memory.prepare(request);
    const turns = compact.mock.calls[0]![0].turns;
    expect(turns).toHaveLength(25);
    expect(turns.every(({ userMessages }) => userMessages.length === 0)).toBe(true);
    expect(prepared.checkpoint.coveredMessages.map(({ messageId }) => messageId))
      .toEqual(record.messages.slice(0, 25).map(({ id }) => id));
    await prepared.commit();
    const projection = memory.project();
    expect(projection.historyMessages.map(({ id }) => id)).toEqual(record.messages.slice(25).map(({ id }) => id));
    expect(projection.compactableTurnCount).toBe(0);
    const prompt = "Help me choose a keyboard.";
    const context = projectRequestContext({ instructions: "Chat rules", ...projection, prompt,
      historyRetention: "compaction_managed", budget: { contextWindowTokens: 100_000,
        outputReserveTokens: 1000, safetyReserveTokens: 100, attachmentReserveTokens: 0 } });
    expect(context.messages.filter(({ role }) => role === "user")).toEqual([{ role: "user", content: prompt }]);
    expect(context.messages.filter(({ role }) => role === "assistant").map(({ content }) => content))
      .toEqual(record.messages.slice(25).map(({ content }) => content));
    expect(JSON.stringify(context.messages)).not.toContain("Private reason");
    expect(JSON.stringify(context.messages)).not.toContain("Private handoff");
  });

  test("covers mixed chronological units, reloads the checkpoint and extends it once", async () => {
    const record = session([initiative(0), ...ordinaryTurn(0), initiative(1),
      ...Array.from({ length: 10 }, (_, index) => ordinaryTurn(index + 1)).flat()]);
    const { memory, compact } = memoryFor(record);
    const prepared = await memory.prepare(request);
    expect(compact.mock.calls[0]![0].turns.map(({ assistant }) => assistant.id))
      .toEqual(["initiative-0", "assistant-0", "initiative-1"]);
    expect(prepared.checkpoint.coveredMessages.map(({ messageId }) => messageId))
      .toEqual(["initiative-0", "user-0", "assistant-0", "initiative-1"]);
    await prepared.commit();
    const continued = JSON.parse(JSON.stringify(record)) as typeof record;
    continued.messages.push(initiative(2));
    const restarted = memoryFor(continued);
    expect(restarted.memory.project().checkpointRevision).toBe(1);
    const next = await restarted.memory.prepare(request);
    expect(restarted.compact.mock.calls[0]![0]).toMatchObject({ previousSummary: prepared.checkpoint.summary });
    expect(restarted.compact.mock.calls[0]![0].turns.map(({ assistant }) => assistant.id)).toEqual(["assistant-1"]);
    await next.commit();
    expect(restarted.memory.project().historyMessages.at(-1)?.id).toBe("initiative-2");
    expect(restarted.memory.project().historyMessages.some(({ id }) => id === "initiative-0")).toBe(false);
    expect(resolveApplicableSessionMemoryCheckpoint(continued)).toEqual(next.checkpoint);
  });

  test("leaves an ordinary checkpoint unchanged and protects ten mixed units", async () => {
    const ordinary = session(Array.from({ length: 12 }, (_, index) => ordinaryTurn(index)).flat());
    const { memory } = memoryFor(ordinary);
    const checkpoint = await memory.prepare(request);
    expect(checkpoint.checkpoint.coveredMessages.map(({ messageId }) => messageId))
      .toEqual(["user-0", "assistant-0", "user-1", "assistant-1"]);
    await checkpoint.commit();
    expect(resolveApplicableSessionMemoryCheckpoint(ordinary)).toEqual(checkpoint.checkpoint);
    const mixed = memoryFor(session([initiative(0), ...Array.from({ length: 9 }, (_, index) => ordinaryTurn(index)).flat()]));
    expect(mixed.memory.project().compactableTurnCount).toBe(0);
    await expect(mixed.memory.prepare(request)).rejects.toThrow("session_memory_compaction_not_available");
    expect(mixed.compact).not.toHaveBeenCalled();
  });

  test.each([false, true])("roundtrips a current approval snapshot unchanged (initiative=%s)", async (includeInitiative) => {
    const record = session([...(includeInitiative ? [initiative(0)] : []),
      ...Array.from({ length: 12 }, (_, index) => ordinaryTurn(index)).flat()]);
    const { memory, options } = memoryFor(record);
    const prepared = await memory.prepare(request); await prepared.commit();
    const current = JSON.parse(JSON.stringify(captureRequestSessionMemory(memory)));
    const restored = restoreRequestSessionMemory(current, options);
    expect(captureRequestSessionMemory(restored)).toEqual(current);
    expect(restored.project()).toEqual(memory.project());
    current.source.historyMessages[0].content = "Replaced historical message";
    expect(() => restoreRequestSessionMemory(current, options)).toThrow("session_memory_snapshot_source_invalid");
  });
});
