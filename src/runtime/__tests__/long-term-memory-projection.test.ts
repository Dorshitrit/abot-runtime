import { describe, expect, test } from "vitest";

import type { LongTermMemoryRecord } from "../long-term-memory/contracts.js";
import { projectLongTermMemoryMessage } from "../long-term-memory/projection.js";

describe("long-term memory projection", () => {
  test("budgets the serialized envelope and escaped memory content", () => {
    const message = projectLongTermMemoryMessage([
      createRecord("kept", "A bounded memory."),
      createRecord("escaped", '"\\\n'.repeat(1_000)),
    ]);

    expect(message).toBeDefined();
    expect(message!.content.length).toBeLessThanOrEqual(6_000);
    expect(JSON.parse(message!.content)).toMatchObject({
      memories: [{ content: "A bounded memory.", tags: ["preference"] }],
    });
  });

  test("skips an oversized record and projects later bounded records", () => {
    const message = projectLongTermMemoryMessage([
      createRecord("oversized", '"\\\n'.repeat(1_000)),
      createRecord("kept", "A later bounded memory."),
    ]);

    expect(message).toBeDefined();
    expect(JSON.parse(message!.content)).toMatchObject({
      memories: [{ content: "A later bounded memory.", tags: ["preference"] }],
    });
  });
});

function createRecord(id: string, content: string): LongTermMemoryRecord {
  return Object.freeze({
    id,
    content,
    tags: Object.freeze(["preference"]),
    provenance: Object.freeze({
      kind: "manual" as const,
      source: "management_api" as const,
    }),
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  });
}
