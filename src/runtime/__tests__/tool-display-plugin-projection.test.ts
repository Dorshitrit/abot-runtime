import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import {
  buildToolCompletedEventActions,
  buildToolCompletedEventMetadata,
} from "../../capabilities/tool-event-metadata.js";
import type {
  ToolDefinition,
  ToolExecutionResult,
} from "../../capabilities/tool-types.js";
import { parseAgentPluginManifest } from "../plugins/manifest-validator.js";
import { projectToolActivityEvent } from "../../web-ui/app/lib/tool-activity-event.js";

function definition(plugin: string, tool: string): ToolDefinition {
  const raw = JSON.parse(readFileSync(`plugins/${plugin}/plugin.json`, "utf8"));
  const manifest = parseAgentPluginManifest(raw, plugin);
  const capability = manifest.extensions["ai.abot.runtime"].capabilities[tool]!;
  return {
    name: tool,
    routingCapability: capability.routingCapability,
    params: {},
    executionEffect: "read_only",
    eventPresentation: capability.eventPresentation,
  };
}

function project(
  plugin: string,
  tool: string,
  data: ToolExecutionResult["data"],
  output: string,
  params: Record<string, unknown> = {},
) {
  return buildToolCompletedEventMetadata(
    { tool, params },
    {
      tool,
      ok: true,
      output,
      progress: true,
      producedNewInformation: true,
      data,
    },
    definition(plugin, tool),
  );
}

describe("packaged tool display outcomes", () => {
  test("the registered document tool name reaches the UI with its actual working-path target", () => {
    const tool = definition("document-reader", "document_reader").name;
    const meta = project(
      "document-reader",
      tool,
      {
        startChar: 0,
        endChar: 10,
        totalCharacters: 20,
        truncated: true,
      },
      "Document excerpt",
      {
        source_mode: "working_path",
        source: "unused.pdf",
        path: "report.txt",
      },
    );
    const event = projectToolActivityEvent({
      name: "tool.completed",
      tool,
      ok: true,
      meta,
    });
    expect(event).toMatchObject({
      target: "report.txt",
      partial: true,
    });
    expect(event!.received).toContainEqual({
      label: "End character",
      value: "10",
    });
  });

  test("project inspection exposes the selected target and actual configured scope", () => {
    const metadata = project(
      "project-orientation",
      "inspect_project",
      {
        target: "workspace/project",
        depth: 2,
        maxEntries: 80,
        truncation: { tree: true, output: { truncated: false } },
      },
      "Project target: workspace/project\nFiles (80, bounded sample): package.json, src/index.ts",
      { path: "workspace/project" },
    );
    expect(metadata).toMatchObject({
      displayTarget: "workspace/project",
      depth: 2,
      maxEntries: 80,
      sourceTruncated: true,
      outputTruncated: false,
      outputPreview:
        "Project target: workspace/project\nFiles (80, bounded sample): package.json, src/index.ts",
    });
    expect(metadata).not.toHaveProperty("path");
  });

  test.each([true, false])(
    "JSON inspection preserves syntaxValid=%s as an observation result",
    (syntaxValid) => {
      const output = syntaxValid
        ? "Valid JSON: config.json\nTop-level type: object"
        : "JSON syntax is invalid: config.json\nLocation: line 4, column 2";
      expect(
        project(
          "json-inspector",
          "inspect_json",
          {
            path: "config.json",
            syntaxValid,
            ...(syntaxValid ? { maxDepth: 2 } : {}),
          },
          output,
          { path: "config.json" },
        ),
      ).toMatchObject({
        displayTarget: "config.json",
        syntaxValid,
        outputPreview: output,
      });
    },
  );

  test.each([
    ["project-orientation", "inspect_project"],
    ["json-inspector", "inspect_json"],
    ["code-outline", "inspect_code_outline"],
    ["document-reader", "document_reader"],
  ])(
    "%s display target leaves canonical completion references unchanged",
    (plugin, tool) => {
      const execution: ToolExecutionResult = {
        tool,
        ok: true,
        output: "inspection receipt",
        progress: true,
        producedNewInformation: true,
        actions: [{ type: "inspect_target", target: "/private/internal/path" }],
      };
      const call = { tool, params: { path: "workspace/project" } };
      const before = JSON.stringify(execution);
      const original = buildToolCompletedEventActions(call, execution);
      const visible = definition(plugin, tool);
      buildToolCompletedEventMetadata(call, execution, visible);
      expect(buildToolCompletedEventActions(call, execution, visible)).toEqual(
        original,
      );
      expect(JSON.stringify(execution)).toBe(before);
    },
  );

  test("memory pagination distinguishes the returned page from the whole store", () => {
    expect(
      project(
        "memory",
        "memory_get",
        {
          itemCount: 150,
          returnedItemCount: 50,
          nextOffset: 50,
          truncated: true,
        },
        "Memory entries: 150\n1. [memory-1] A remembered preference.",
      ),
    ).toMatchObject({
      itemCount: 150,
      totalItemCount: 150,
      returnedItemCount: 50,
      nextOffset: 50,
      sourceTruncated: true,
      outputPreviewTruncated: false,
    });
  });

  test("code outline exposes symbol coverage and a bounded structural receipt", () => {
    const metadata = project(
      "code-outline",
      "inspect_code_outline",
      {
        lineCount: 500,
        truncation: {
          returnedSymbols: 20,
          totalSymbols: 30,
          symbolsTruncated: true,
          output: { truncated: false },
        },
      },
      "Code outline: src/main.ts\nSymbols (20/30, truncated):\n- function main (line 4)",
      {
        path: "src/main.ts",
        maxSymbols: 20,
      },
    );
    expect(metadata).toMatchObject({
      displayTarget: "src/main.ts",
      maxSymbols: 20,
      lineCount: 500,
      returnedItemCount: 20,
      totalItemCount: 30,
      sourceTruncated: true,
      outputPreview:
        "Code outline: src/main.ts\nSymbols (20/30, truncated):\n- function main (line 4)",
    });
  });

  test("document attachment source survives alongside its bounded returned character window", () => {
    const metadata = project(
      "document-reader",
      "document_reader",
      {
        startChar: 200,
        endChar: 1_200,
        totalCharacters: 9_000,
        inputBytes: 12_000,
        truncated: true,
      },
      "Document: report.pdf\nCoverage: characters 200-1200 of 9000 (partial)\nContent:\nExtracted text.",
      {
        source: "report.pdf",
        path: ".",
        start_char: 200,
        max_chars: 1_000,
      },
    );
    expect(metadata).toMatchObject({
      source: "report.pdf",
      displayTarget: ".",
      startChar: 200,
      maxChars: 1_000,
      endChar: 1_200,
      totalCharacters: 9_000,
      inputBytes: 12_000,
      sourceTruncated: true,
      outputPreview:
        "Document: report.pdf\nCoverage: characters 200-1200 of 9000 (partial)\nContent:\nExtracted text.",
    });
    expect(metadata).not.toHaveProperty("path");
  });

  test("a complete file with a clipped display is not reported as a partial read", () => {
    expect(
      project(
        "filesystem",
        "read_file",
        {
          truncation: { truncated: false },
        },
        "x".repeat(1_500),
      ),
    ).toMatchObject({
      sourceTruncated: false,
      outputPreviewTruncated: true,
    });
  });

  test("a write displays its returned receipt while canonical snapshot framing stays hidden", () => {
    const metadata = project(
      "filesystem",
      "write_file",
      {
        mutationGrounding:
          "Exact committed artifact snapshot\nBEGIN EXACT COMMITTED HEAD\nnew content",
        truncation: { groundingTruncated: true },
      },
      "Path: notes.txt\nBytes written: 42\nWrite: success",
    );
    expect(metadata).toMatchObject({
      outputPreview: "Path: notes.txt\nBytes written: 42\nWrite: success",
      outputPreviewTruncated: false,
    });
    expect(metadata).not.toHaveProperty("sourceTruncated");
    expect(metadata).not.toHaveProperty("evidenceTruncated");
    expect(JSON.stringify(metadata)).not.toContain("EXACT COMMITTED");
    expect(
      project(
        "filesystem",
        "write_file",
        {
          stateAlreadySatisfied: true,
        },
        "Path: notes.txt\nBytes written: 0\nWrite: no-op",
      ),
    ).toMatchObject({
      outputPreview: "Path: notes.txt\nBytes written: 0\nWrite: no-op",
      stateAlreadySatisfied: true,
    });
  });

  test("memory delete preserves a no-match receipt without fabricating a mutation count", () => {
    const metadata = project(
      "memory",
      "memory_delete",
      undefined,
      "Memory delete: no_match\nid: missing\ndeleted: 0",
    );
    expect(metadata?.outputPreview).toContain("no_match");
    expect(metadata).not.toHaveProperty("deletedCount");
    expect(
      project(
        "memory",
        "memory_delete",
        { deletedCount: 1 },
        "Memory delete: success",
      ),
    ).toMatchObject({ deletedCount: 1 });
  });

  test("memory add exposes its saved identifier separately from a clipped output receipt", () => {
    const id = "memory-6e07f4db-2dc2-464a-b9ec-547f668221cf";
    const data = Object.freeze({ mutationEvidence: true, id });
    const metadata = project(
      "memory",
      "memory_add",
      data,
      "Saved content. ".repeat(200),
      { content: "A preference to remember" },
    );
    const event = projectToolActivityEvent({
      name: "tool.completed",
      tool: "memory_add",
      ok: true,
      meta: metadata,
    });

    expect(metadata).toMatchObject({ savedId: id, savedIdTruncated: false });
    expect(metadata?.outputPreviewTruncated).toBe(true);
    expect(event?.target).toBe(id);
    expect(event?.received).toContainEqual({
      label: "Saved memory ID",
      value: id,
    });
    expect(data).toEqual({ mutationEvidence: true, id });
  });

  test.each([undefined, 42])(
    "memory add never invents an identifier from output when data.id is %s",
    (id) => {
      const metadata = project(
        "memory",
        "memory_add",
        { id },
        "Memory add: success\nid: not-structured",
      );
      const event = projectToolActivityEvent({
        name: "tool.completed",
        tool: "memory_add",
        ok: true,
        meta: metadata,
      });

      expect(metadata).not.toHaveProperty("savedId");
      expect(event?.target).toBe("");
      expect(event?.received).not.toContainEqual({
        label: "Saved memory ID",
        value: "not-structured",
      });
    },
  );

  test("local search retains bounded result count and source coverage", () => {
    expect(
      project(
        "local-search",
        "local_search",
        {
          itemCount: 40,
          truncation: { truncated: true },
        },
        "Returned matches: 40 (bounded)\nContent matches:\n- notes.txt:2:matching text",
      ),
    ).toMatchObject({
      returnedItemCount: 40,
      sourceTruncated: true,
      outputPreview:
        "Returned matches: 40 (bounded)\nContent matches:\n- notes.txt:2:matching text",
    });
  });
});
