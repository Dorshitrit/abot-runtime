import { describe, expect, it } from "vitest";
import { ObservationQueue } from "../passive-learning/queue.js";
import type { LearningObservation } from "../passive-learning/contracts.js";

const now = Date.parse("2026-09-23T10:00:00Z");
function observation(
  id: string,
  app = "browser",
  content = "Article text",
  kind: LearningObservation["kind"] = "view",
  offset = 0,
): LearningObservation {
  return {
    id,
    deviceId: "device",
    timestamp: new Date(now + offset).toISOString(),
    sequence: Number(id),
    source: { app, windowId: app, documentId: app },
    content,
    kind,
    extraction: "uia",
    coverage: "partial",
  };
}

describe("passive observation quality", () => {
  it.each([[300, 10], [100, 24_000]])("reserves eligible evidence within the same caps for a burst of %i items", (count, bytes) => {
    const queue = new ObservationQueue((item) => item.source.app === "editor");
    queue.add(observation("1", "editor", "Eligible evidence"), now);
    for (let i = 0; i < count; i++)
      queue.add(observation(String(i + 2), "blocked", `${i} ${"x".repeat(bytes)}`), now);
    expect(queue.items[0]!.id).toBe("1");
    expect(queue.length).toBeLessThanOrEqual(256);
    expect(queue.items.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0)).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(queue.dropped).toBe(count + 1 - queue.length);
    expect(queue.dropped).toBeGreaterThan(0);
    queue.expire(now + 86_400_001);
    expect(queue.length).toBe(0);
  });

  it.each([true, false])("keeps FIFO capacity bounds when every item has eligibility %s", (eligible) => {
    const queue = new ObservationQueue(() => eligible);
    for (let i = 0; i < 300; i++) queue.add(observation(String(i), "editor", `Evidence ${i}`), now);
    expect(queue.length).toBe(256);
    expect(queue.items[0]!.id).toBe("44");
    expect(queue.dropped).toBe(44);
  });

  it("drops event noise without invoking semantic judgement", () => {
    const queue = new ObservationQueue();
    expect(queue.add(observation("1"), now)).toBe(true);
    expect(queue.add(observation("2"), now)).toBe(false);
    expect(queue.take(now)).toHaveLength(1);
  });
  it("keeps distinct documents in one batch and records a revisit without repeated text", () => {
    const queue = new ObservationQueue();
    queue.add(observation("1", "browser"), now);
    queue.add(observation("2", "editor", "Draft"), now);
    queue.add(observation("3", "browser"), now);
    const batch = queue.take(now);
    expect(batch.map((item) => item.source.app)).toEqual([
      "browser",
      "editor",
      "browser",
    ]);
    expect(batch[2]).toMatchObject({
      content: "",
      kind: "activity",
      revisit: { contentUnchanged: true },
    });
  });
  it("settles successive edits for the same document without attributing authorship", () => {
    const queue = new ObservationQueue();
    queue.add(observation("1", "editor", "Draft a", "edit"), now);
    queue.add(
      observation("2", "editor", "Draft b", "edit", 1_000),
      now + 1_000,
    );
    expect(queue.take(now + 2_000)).toMatchObject([
      { id: "2", content: "Draft b", kind: "edit" },
    ]);
  });
  it("retains new metadata-only activity and drops repeated unchanged source events", () => {
    const queue = new ObservationQueue();
    expect(queue.add(observation("1", "files", "", "activity"), now)).toBe(
      true,
    );
    expect(queue.add(observation("2", "files", "", "activity"), now)).toBe(
      false,
    );
    expect(queue.take(now)).toHaveLength(1);
  });
  it("reports expired and over-capacity evidence as dropped", () => {
    const queue = new ObservationQueue();
    queue.add(observation("1"), now);
    expect(queue.take(now + 86_400_001)).toEqual([]);
    expect(queue.dropped).toBe(1);
    queue.add(observation("2", "editor", "x".repeat(2 * 1024 * 1024)), now);
    expect(queue.length).toBe(0);
    expect(queue.dropped).toBe(2);
  });
  it("retains a provider revisit even when an excluded intermediate source was invisible", () => {
    const queue = new ObservationQueue();
    queue.add(observation("1"), now);
    queue.add(
      {
        ...observation("2", "browser", "", "activity"),
        revisitsObservationId: "1",
      },
      now,
    );
    queue.add(
      {
        ...observation("3", "browser", "", "activity"),
        revisitsObservationId: "1",
      },
      now,
    );
    expect(queue.take(now)).toHaveLength(3);
  });
  it("preserves a draft reverting to earlier text instead of mistaking it for duplicate noise", () => {
    const queue = new ObservationQueue();
    queue.add(observation("1", "editor", "Draft A", "edit"), now);
    queue.add(
      observation("2", "editor", "Draft B", "edit", 1_000),
      now + 1_000,
    );
    queue.add(
      observation("3", "editor", "Draft A", "edit", 2_000),
      now + 2_000,
    );
    expect(queue.take(now + 3_000)).toMatchObject([
      { id: "3", content: "Draft A", kind: "edit" },
    ]);
  });
});
