import { describe, expect, test } from "vitest";

import {
  buildToolCompletedEventActions,
  buildToolCompletedEventMetadata,
  buildToolStartEventMetadata,
} from "../tool-event-metadata.js";
import type { ToolDefinition, ToolExecutionResult } from "../tool-types.js";

const RESULT_COLLISION_PROJECTIONS = {
  itemCount: { path: "data.display.itemCount", kind: "number" },
  hasData: { path: "data.display.hasData", kind: "boolean" },
  errorCode: { path: "data.display.errorCode", kind: "preview" },
} as const;

describe("tool event metadata", () => {
  test("keeps explicit result mappings ahead of generic evidence, including zero and false", () => {
    const definition = createDefinition(
      {
        itemCount: { param: "limit", kind: "number" },
      },
      RESULT_COLLISION_PROJECTIONS,
    );
    const result = createCollisionResult({
      itemCount: 0,
      hasData: false,
      errorCode: "display_error",
    });
    const original = structuredClone(result);

    expect(
      buildToolCompletedEventMetadata(
        { tool: "manifest_capability", params: { limit: 20 } },
        result,
        definition,
      ),
    ).toEqual({
      sourceCount: 2,
      itemCount: 0,
      hasData: false,
      errorCode: "display_error",
      errorCodeTruncated: false,
      exitCode: 3,
      currentStateEvidence: true,
    });
    expect(result).toEqual(original);
  });

  test.each([
    {
      name: "no declaration",
      declared: false,
      display: { itemCount: 0, hasData: false, errorCode: "display_error" },
    },
    { name: "missing declared fields", declared: true, display: {} },
    {
      name: "incorrectly typed declared fields",
      declared: true,
      display: { itemCount: "0", hasData: "false", errorCode: 3 },
    },
  ])("preserves generic precedence with $name", ({ declared, display }) => {
    const definition = createDefinition(
      {
        itemCount: { param: "limit", kind: "number" },
      },
      declared ? RESULT_COLLISION_PROJECTIONS : undefined,
    );
    const result = createCollisionResult(display);
    const original = structuredClone(result);

    expect(
      buildToolCompletedEventMetadata(
        { tool: "manifest_capability", params: { limit: 20 } },
        result,
        definition,
      ),
    ).toEqual({
      sourceCount: 2,
      itemCount: 8,
      hasData: true,
      errorCode: "canonical_error",
      exitCode: 3,
      currentStateEvidence: true,
    });
    expect(result).toEqual(original);
  });

  test("projects only manifest-declared metadata without a tool-name branch", () => {
    const definition = createDefinition({
      path: { param: "target", kind: "string" },
      page: { param: "page", kind: "number", default: 1 },
      sources: { param: "urls", kind: "string_array" },
      contentLength: { param: "content", kind: "length", default: 0 },
    });

    expect(
      buildToolStartEventMetadata(
        {
          tool: "manifest_capability",
          params: {
            target: "project/output.txt",
            urls: ["https://one.example", "", 7, "https://two.example"],
            content: "private payload",
            undeclared: "must not be projected",
          },
        },
        definition,
      ),
    ).toEqual({
      path: "project/output.txt",
      page: 1,
      sources: ["https://one.example", "https://two.example"],
      contentLength: 15,
    });
  });

  test("uses a bounded shape-only fallback when a manifest has no presentation", () => {
    expect(
      buildToolStartEventMetadata({
        tool: "opaque_capability",
        params: {
          content: "secret body",
          count: 2,
          enabled: true,
          values: ["one", "two"],
          options: { mode: "strict", token: "secret" },
        },
      }),
    ).toEqual({
      params: {
        content: "string(len=11)",
        count: 2,
        enabled: true,
        options: "object(keys=mode,token)",
        values: "array(len=2)",
      },
    });
  });

  test("merges declaration metadata, tool-owned result metadata and generic evidence", () => {
    const definition = createDefinition({
      path: { param: "target", kind: "string" },
      queryLength: { param: "query", kind: "length" },
    });
    const result: ToolExecutionResult = {
      ok: true,
      tool: "manifest_capability",
      output: "done",
      exitCode: 0,
      progress: true,
      producedNewInformation: true,
      actions: [
        { type: "inspect_target", target: "/absolute/internal/path" },
        { type: "inspect_target", target: "/absolute/internal/path" },
      ],
      data: {
        hasData: true,
        itemCount: 2,
        currentStateEvidence: true,
        eventMeta: { sourceCount: 3 },
      },
    };

    expect(
      buildToolCompletedEventMetadata(
        {
          tool: "manifest_capability",
          params: { target: "project/report.txt", query: "runtime" },
        },
        result,
        definition,
      ),
    ).toEqual({
      path: "project/report.txt",
      queryLength: 7,
      sourceCount: 3,
      exitCode: 0,
      hasData: true,
      itemCount: 2,
      currentStateEvidence: true,
      actionTypes: ["inspect_target"],
      targets: ["project/report.txt"],
    });
  });

  test("keeps action targets logical when the declaration exposes a path", () => {
    const definition = createDefinition({
      path: { param: "target", kind: "string" },
    });
    const result: ToolExecutionResult = {
      ok: true,
      tool: "manifest_capability",
      output: "created",
      progress: true,
      producedNewInformation: true,
      actions: [{ type: "write_file", target: "/host/private/output.txt" }],
    };

    expect(
      buildToolCompletedEventActions(
        {
          tool: "manifest_capability",
          params: { target: "project/output.txt" },
        },
        result,
        definition,
      ),
    ).toEqual([{ type: "write_file", target: "project/output.txt" }]);
  });

  test("does not expose undeclared raw action targets", () => {
    const result: ToolExecutionResult = {
      ok: false,
      tool: "opaque_capability",
      output: "failed",
      errorCode: "operation_failed",
      progress: false,
      producedNewInformation: false,
      actions: [{ type: "unknown", target: "/host/private/target" }],
    };

    expect(
      buildToolCompletedEventMetadata(
        { tool: "opaque_capability", params: { secret: "hidden" } },
        result,
      ),
    ).toEqual({
      params: { secret: "string(len=6)" },
      errorCode: "operation_failed",
      actionTypes: ["unknown"],
    });
  });
});

function createDefinition(
  metadata: NonNullable<ToolDefinition["eventPresentation"]>["metadata"],
  resultMetadata?: NonNullable<
    ToolDefinition["eventPresentation"]
  >["resultMetadata"],
): ToolDefinition {
  return {
    name: "manifest_capability",
    routingCapability: "semantic_lookup",
    executionEffect: "read_only",
    params: {},
    eventPresentation: {
      metadata,
      ...(resultMetadata ? { resultMetadata } : {}),
    },
  };
}

function createCollisionResult(
  display: Record<string, unknown>,
): ToolExecutionResult {
  return {
    ok: false,
    tool: "manifest_capability",
    output: "Original tool output.",
    errorCode: "canonical_error",
    exitCode: 3,
    producedNewInformation: false,
    data: {
      itemCount: 8,
      hasData: true,
      currentStateEvidence: true,
      eventMeta: {
        itemCount: 99,
        hasData: true,
        errorCode: "event_meta_error",
        sourceCount: 2,
      },
      display,
    },
  };
}
