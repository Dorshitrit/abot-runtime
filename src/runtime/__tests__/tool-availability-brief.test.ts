import { describe, expect, test } from "vitest";

import {
  buildToolAvailabilityBrief,
  type ToolAvailabilityEntry,
} from "../../plugin-sdk/index.js";

function availableTool(
  operationId: string,
  overrides: Partial<ToolAvailabilityEntry> = {},
): ToolAvailabilityEntry {
  return Object.freeze({
    toolName: "weather_forecast",
    operationId,
    summary: "Get a forecast.",
    catalogGroups: Object.freeze(["web"]),
    effect: "read_only",
    ...overrides,
  });
}

describe("shared on-demand tool availability brief", () => {
  test("preserves full output, ASCII ordering, and collection metadata", () => {
    const entries = Object.freeze([
      availableTool("shared", { toolName: "alpha" }),
      availableTool("shared", {
        toolName: "Zulu",
        catalogGroups: ["web", "read"],
        effect: "mixed",
      }),
      availableTool("first"),
    ]);
    const brief = buildToolAvailabilityBrief(entries);
    const expectedText = [
      "Available tool operations: 3",
      "- first (tool=weather_forecast; effect=read_only; groups=web) Get a forecast.",
      "- shared (tool=Zulu; effect=mixed; groups=web,read) Get a forecast.",
      "- shared (tool=alpha; effect=read_only; groups=web) Get a forecast.",
    ].join("\n");

    expect(brief).toEqual({
      text: expectedText,
      collection: {
        truncated: false,
        totalItems: 3,
        returnedItems: 3,
        omittedItems: 0,
      },
      output: {
        truncated: false,
        originalChars: expectedText.length,
        returnedChars: expectedText.length,
        omittedChars: 0,
      },
    });
    expect(entries.map(({ toolName }) => toolName)).toEqual([
      "alpha",
      "Zulu",
      "weather_forecast",
    ]);
  });

  test("retains the plugin's exact empty-catalog response", () => {
    const brief = buildToolAvailabilityBrief([]);
    expect(brief.text).toBe("Available tool operations: 0");
    expect(brief.collection).toEqual({
      truncated: false,
      totalItems: 0,
      returnedItems: 0,
      omittedItems: 0,
    });
    expect(brief.output.truncated).toBe(false);
  });

  test("retains the 64-operation limit and existing omission marker", () => {
    const entries = Array.from({ length: 65 }, (_, index) =>
      availableTool(`operation_${String(index).padStart(2, "0")}`),
    );
    const brief = buildToolAvailabilityBrief(entries);

    expect(brief.text).toContain("Available tool operations: 65\n");
    expect(brief.text).toContain("- operation_63 ");
    expect(brief.text).not.toContain("operation_64");
    expect(brief.text.endsWith("[1 additional tool operations omitted]")).toBe(
      true,
    );
    expect(brief.collection).toEqual({
      truncated: true,
      totalItems: 65,
      returnedItems: 64,
      omittedItems: 1,
    });
    expect(brief.output.truncated).toBe(false);
  });

  test("retains the 16000-character limit and original output metadata", () => {
    const summary = "x".repeat(16_000);
    const brief = buildToolAvailabilityBrief([
      availableTool("forecast", { summary }),
    ]);
    const originalText = [
      "Available tool operations: 1",
      `- forecast (tool=weather_forecast; effect=read_only; groups=web) ${summary}`,
    ].join("\n");
    const marker = "\n[available tool brief truncated]";

    expect(brief.text).toHaveLength(16_000);
    expect(brief.text.endsWith(marker)).toBe(true);
    expect(brief.output).toEqual({
      truncated: true,
      originalChars: originalText.length,
      returnedChars: 16_000,
      omittedChars: originalText.length - (16_000 - marker.length),
    });
    expect(brief.collection.truncated).toBe(false);
  });
});
