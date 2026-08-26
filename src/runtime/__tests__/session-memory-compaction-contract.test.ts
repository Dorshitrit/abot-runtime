import { describe, expect, it } from "vitest";

import { selectLargestFittingPrefix } from "../context/session-memory/compaction/batching.js";
import { parseSessionMemoryCompactionOutput } from "../context/session-memory/compaction/parser.js";

describe("session memory compaction contract", () => {
  it("accepts one bounded replacement summary", () => {
    expect(
      parseSessionMemoryCompactionOutput(
        JSON.stringify({ summary: "  settled prior conversation  " }),
      ),
    ).toEqual({ ok: true, summary: "settled prior conversation" });
  });

  it("rejects extra model-owned fields", () => {
    expect(
      parseSessionMemoryCompactionOutput(
        JSON.stringify({ summary: "valid", sourceRefs: ["message-1"] }),
      ),
    ).toEqual({
      ok: false,
      issueCode: "session_memory_output_shape_invalid",
    });
  });

  it("selects the largest fitting contiguous prefix", async () => {
    const selected = await selectLargestFittingPrefix({
      entries: [1, 2, 3, 4, 5],
      fits: async (entries) => entries.length <= 3,
    });

    expect(selected).toEqual([1, 2, 3]);
  });
});
