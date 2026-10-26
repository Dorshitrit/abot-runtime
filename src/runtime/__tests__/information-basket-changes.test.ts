import { describe, expect, test, vi } from "vitest";
import type { BasketDiscoveryChange, BasketSourceStatus } from "../information-basket/contracts.js";
import { emptyBasketSnapshot, type BasketSnapshot, type StoredBasketSource } from "../information-basket/index-records.js";
import { createBasketStateOwner } from "../information-basket/state-owner.js";

function source(id: string, status: BasketSourceStatus, revision = 1): StoredBasketSource {
  return {
    sourceId: id, displayName: id, path: "/" + id, revision, status,
    sizeBytes: 5, chunkCount: status === "ready" ? 1 : 0, indexedAt: null, reason: null,
    index: status === "ready" ? {
      contentHash: "a".repeat(64), fileIdentity: "1:2:3", totalCharacters: 5, profileSignature: "profile",
      chunkingVersion: 1, modelFingerprint: "model", dimensions: 1,
      chunks: [{ chunkId: "chunk-0", startChar: 0, endChar: 5, vector: [1] }],
    } : null,
  };
}
describe("Information Basket committed discovery changes", () => {
  test("unrelated progress does not invalidate ready sources; publication and removal are distinct", async () => {
    let stored: BasketSnapshot = { ...emptyBasketSnapshot("fixture"), sources: [source("A", "ready")] };
    const state = createBasketStateOwner({
      read: async () => stored, update: async change => { stored = change(stored); return stored; },
    });
    const changed = vi.fn<(change: BasketDiscoveryChange) => void>();
    state.subscribeChanges(changed);
    await state.update(current => ({ ...current, sources: [...current.sources, source("B", "queued")] }));
    expect(changed).toHaveBeenLastCalledWith({
      settingsChanged: false, invalidatedSourceIds: [], readySourcesAdded: false,
    });
    await state.update(current => ({ ...current, sources: [current.sources[0]!, source("B", "indexing")] }));
    expect(changed).toHaveBeenLastCalledWith({
      settingsChanged: false, invalidatedSourceIds: [], readySourcesAdded: false,
    });
    await state.update(current => ({ ...current, sources: [current.sources[0]!, source("B", "ready")] }));
    expect(changed).toHaveBeenLastCalledWith({
      settingsChanged: false, invalidatedSourceIds: [], readySourcesAdded: true,
    });
    await state.update(current => ({ ...current, sources: [current.sources[1]!] }));
    expect(changed).toHaveBeenLastCalledWith({
      settingsChanged: false, invalidatedSourceIds: ["A"], readySourcesAdded: false,
    });
  });

  test("source revisions invalidate exact bindings and failed commits never notify", async () => {
    let stored: BasketSnapshot = { ...emptyBasketSnapshot("fixture"), sources: [source("A", "ready")] };
    let rejectCommit = false;
    const state = createBasketStateOwner({
      read: async () => stored,
      update: async change => {
        const next = change(stored);
        if (rejectCommit) throw new Error("write failed");
        stored = next;
        return stored;
      },
    });
    const changed = vi.fn<(change: BasketDiscoveryChange) => void>();
    state.subscribeChanges(changed);
    await state.update(current => ({ ...current, sources: [source("A", "queued", 2)] }));
    expect(changed).toHaveBeenLastCalledWith({
      settingsChanged: false, invalidatedSourceIds: ["A"], readySourcesAdded: false,
    });
    await state.update(current => ({ ...current, settings: { ...current.settings, enabled: false, revision: 2 } }));
    expect(changed).toHaveBeenLastCalledWith({
      settingsChanged: true, invalidatedSourceIds: [], readySourcesAdded: false,
    });
    const notifications = changed.mock.calls.length;
    rejectCommit = true;
    await expect(state.update(current => ({ ...current, sources: [] }))).rejects.toThrow("write failed");
    expect(changed).toHaveBeenCalledTimes(notifications);
    expect((await state.read()).sources).toHaveLength(1);
  });
});
