import { describe, expect, test } from "vitest";

import { classifyMemoryFailure } from "../long-term-memory/diagnostics.js";

describe("long-term memory diagnostics", () => {
  test("preserves only stable internal failure codes", () => {
    expect(
      classifyMemoryFailure(new Error("memory_store_unavailable")),
    ).toBe("memory_store_unavailable");
  });

  test("does not expose provider errors or credentials", () => {
    const providerFailure = new Error(
      "bridge_embedding_failed:401:api_key=secret-value",
    );

    expect(classifyMemoryFailure(providerFailure)).toBe(
      "long_term_memory_unavailable",
    );
  });
});
