import { describe, expect, test } from "vitest";

import { buildToolCompletedEventMetadata } from "../tool-event-metadata.js";
import { projectToolResultEventMetadata } from "../tool-result-event-projection.js";
import type {
  ToolDefinition,
  ToolEventPresentation,
  ToolExecutionResult,
} from "../tool-types.js";

const OUTPUT_PROJECTION = {
  outputPreview: { path: "output", kind: "preview" },
} as const;

function result(output = "Observed content."): ToolExecutionResult {
  return {
    ok: true,
    tool: "lookup",
    output,
    progress: true,
    producedNewInformation: true,
    actions: [{ type: "inspect_target", target: "internal/target" }],
    data: {
      itemCount: 100,
      returnedItemCount: 10,
      truncated: true,
      eventMeta: { sourceCount: 2 },
    },
  };
}

describe("display-only result event projection", () => {
  test("projects declared fields while preserving the exact result and existing metadata", () => {
    const execution = result();
    const before = JSON.stringify(execution);
    const definition: ToolDefinition = {
      name: "lookup",
      params: {},
      routingCapability: "semantic_lookup",
      executionEffect: "read_only",
      eventPresentation: {
        metadata: {},
        resultMetadata: {
          ...OUTPUT_PROJECTION,
          returnedItemCount: { path: "data.returnedItemCount", kind: "number" },
          sourceTruncated: { path: "data.truncated", kind: "boolean" },
        },
      },
    };
    expect(
      buildToolCompletedEventMetadata(
        { tool: "lookup", params: {} },
        execution,
        definition,
      ),
    ).toEqual({
      sourceCount: 2,
      itemCount: 100,
      actionTypes: ["inspect_target"],
      outputPreview: "Observed content.",
      outputPreviewTruncated: false,
      returnedItemCount: 10,
      sourceTruncated: true,
    });
    expect(JSON.stringify(execution)).toBe(before);
  });

  test("clips preview text without changing source truncation", () => {
    const metadata = projectToolResultEventMetadata(result("x".repeat(1_500)), {
      ...OUTPUT_PROJECTION,
      sourceTruncated: { path: "data.truncated", kind: "boolean" },
    });
    expect(metadata).toMatchObject({
      outputPreview: "x".repeat(1_200),
      outputPreviewTruncated: true,
      sourceTruncated: true,
    });
    expect(
      projectToolResultEventMetadata(result("short"), OUTPUT_PROJECTION),
    ).toEqual({ outputPreview: "short", outputPreviewTruncated: false });
  });

  test.each(["\n", "\r\n", "\r"])(
    "clips to twenty lines using %j separators",
    (separator) => {
      const text = Array.from(
        { length: 30 },
        (_, index) => `line ${index}`,
      ).join(separator);
      const preview = projectToolResultEventMetadata(
        result(text),
        OUTPUT_PROJECTION,
      );
      expect(preview?.outputPreview).toBe(
        text.split(separator).slice(0, 20).join(separator),
      );
      expect(preview?.outputPreviewTruncated).toBe(true);
    },
  );

  test("preserves Unicode pairs at the character boundary and enforces the total preview budget", () => {
    const execution = result(`${"x".repeat(1_199)}😀tail`);
    const metadata = projectToolResultEventMetadata(execution, {
      first: { path: "output", kind: "preview" },
      second: { path: "output", kind: "preview" },
      third: { path: "output", kind: "preview" },
    });
    expect(metadata?.first).toBe("x".repeat(1_199));
    expect(metadata?.third).toBe("xx");
    const total = [metadata?.first, metadata?.second, metadata?.third].join(
      "",
    ).length;
    expect(total).toBe(2_400);
    expect(metadata?.thirdTruncated).toBe(true);
  });

  test("omits missing, inherited and incorrectly typed data without manufacturing zeroes", () => {
    const execution = result();
    execution.data = Object.assign(Object.create({ inherited: 5 }), {
      count: Infinity,
      falseFlag: false,
      zero: 0,
    });
    const projections: NonNullable<ToolEventPresentation["resultMetadata"]> = {
      missing: { path: "data.deletedCount", kind: "number" },
      inherited: { path: "data.inherited", kind: "number" },
      count: { path: "data.count", kind: "number" },
      wrongType: { path: "output", kind: "boolean" },
      flag: { path: "data.falseFlag", kind: "boolean" },
      zero: { path: "data.zero", kind: "number" },
    };
    expect(projectToolResultEventMetadata(execution, projections)).toEqual({
      flag: false,
      zero: 0,
    });
  });

  test("leaves tools without a result declaration unchanged", () => {
    expect(projectToolResultEventMetadata(result(), undefined)).toBeUndefined();
    expect(
      buildToolCompletedEventMetadata({ tool: "lookup", params: {} }, result()),
    ).toEqual({
      sourceCount: 2,
      itemCount: 100,
      actionTypes: ["inspect_target"],
    });
  });
});
