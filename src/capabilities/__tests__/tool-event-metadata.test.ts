import { describe, expect, test } from "vitest";

import {
  buildToolCompletedEventActions,
  buildToolCompletedEventMetadata,
  buildToolStartEventMetadata,
} from "../tool-event-metadata.js";
import type { ToolDefinition, ToolExecutionResult } from "../tool-types.js";

describe("tool event metadata", () => {
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
): ToolDefinition {
  return {
    name: "manifest_capability",
    routingCapability: "semantic_lookup",
    executionEffect: "read_only",
    params: {},
    eventPresentation: { metadata },
  };
}
