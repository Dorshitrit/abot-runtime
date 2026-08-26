import { stat } from "node:fs/promises";

import {
  boundText,
  readBoundedInteger,
  readOptionalString,
  readRequiredString,
  successResult,
  type ResolvedRuntimeToolPath,
  type ToolImplementation,
  type ToolImplementationOutput,
} from "../../../src/plugin-sdk/index.js";

import { readDirectorySample, readPrefixText } from "./bounded-io.js";
import { fail, rethrowFilesystemError } from "./errors.js";
import type { FilesystemPathService } from "./path-service.js";
import {
  completeScannedLines,
  DEFAULT_CONTEXT_LINES,
  formatLines,
  MAX_VIEW_LINES,
  parseTrailingRange,
  selectWindow,
} from "./view-window.js";

export function createDevViewHandler(
  paths: FilesystemPathService,
): ToolImplementation {
  return async (params, context) => {
    const requestedPath = readRequiredString(params.path, "path");
    const pathRange = parseTrailingRange(requestedPath);
    const target = paths.resolve(pathRange.path, context);
    let info;
    try {
      info = await stat(target.absolutePath);
    } catch (error: unknown) {
      rethrowFilesystemError(error, "inspect", target.logicalPath);
    }
    if (info.isDirectory()) return viewDirectory(target);
    if (!info.isFile()) {
      fail("not_a_file", `Expected a file or directory: ${target.logicalPath}`);
    }

    const startCandidate = params.start_line ?? pathRange.startLine;
    const startLine =
      startCandidate === undefined
        ? undefined
        : readBoundedInteger(startCandidate, {
            name: "start_line",
            minimum: 1,
            maximum: 1_000_000,
          });
    const endCandidate = params.end_line ?? pathRange.endLine;
    const endLine =
      endCandidate === undefined
        ? undefined
        : readBoundedInteger(endCandidate, {
            name: "end_line",
            minimum: 1,
            maximum: 1_000_000,
          });
    const locator = readOptionalString(params.locator, {
      name: "locator",
      maxLength: 4096,
    });
    const contextLines = readBoundedInteger(params.context_lines, {
      name: "context_lines",
      defaultValue: DEFAULT_CONTEXT_LINES,
      minimum: 1,
      maximum: 30,
    });
    return viewFile({
      target,
      startLine,
      endLine,
      locator,
      contextLines,
    });
  };
}

async function viewDirectory(
  target: ResolvedRuntimeToolPath,
): Promise<ToolImplementationOutput> {
  const sample = await readDirectorySample(target);
  const rendered = [
    `Path: ${target.logicalPath}`,
    "Mode: directory",
    `Entries returned: ${sample.entries.length}`,
    `More entries: ${sample.truncated ? "yes" : "no"}`,
    ...(sample.entries.length
      ? sample.entries.map((entry) => `- ${entry}`)
      : ["(empty)"]),
  ].join("\n");
  const bounded = boundText(rendered, {
    maxChars: 24_000,
    marker: "\n[directory output truncated]",
  });
  return successResult({
    output: bounded.text,
    progress: true,
    data: {
      hasData: true,
      itemCount: sample.entries.length,
      location: target.location,
      path: target.logicalPath,
      entries: sample.entries,
      truncation: {
        truncated: sample.truncated || bounded.metadata.truncated,
        returnedItems: sample.entries.length,
        totalKnown: !sample.truncated,
        ...(sample.truncated ? {} : { totalItems: sample.entries.length }),
        output: bounded.metadata,
      },
      observationMeta: {
        kind: "volatile_external",
        carryPolicy: "never",
      },
      eventMeta: {
        path: target.logicalPath,
        mode: "directory",
        returnedEntries: sample.entries.length,
        truncated: sample.truncated || bounded.metadata.truncated,
      },
    },
    actions: [
      {
        type: "inspect_target",
        target: target.logicalPath,
        details: "directory",
      },
    ],
  });
}

async function viewFile(
  input: Readonly<{
    target: ResolvedRuntimeToolPath;
    startLine?: number;
    endLine?: number;
    locator?: string;
    contextLines: number;
  }>,
): Promise<ToolImplementationOutput> {
  const source = await readPrefixText(input.target);
  const lines = completeScannedLines(source.text, source.truncated);
  const availableLineCount = Math.max(lines.length, 1);
  const selection = selectWindow({
    text: source.text,
    lines,
    startLine: input.startLine,
    endLine: input.endLine,
    locator: input.locator,
    contextLines: input.contextLines,
  });
  if (!selection) {
    return successResult({
      output: [
        `Path: ${input.target.logicalPath}`,
        "Mode: file",
        `Locator: ${input.locator}`,
        `Match: ${source.truncated ? "not found in bounded scan" : "not found"}`,
        `Bytes scanned: ${source.bytesRead}/${source.byteCount}`,
      ].join("\n"),
      progress: true,
      data: {
        hasData: true,
        itemCount: 0,
        path: input.target.logicalPath,
        locatorFound: false,
        truncation: {
          truncated: source.truncated,
          omittedBytes: source.omittedBytes,
        },
        eventMeta: {
          path: input.target.logicalPath,
          mode: "file",
          locatorFound: false,
          scanTruncated: source.truncated,
        },
      },
      actions: [
        {
          type: "inspect_target",
          target: input.target.logicalPath,
          details: "locator_not_found",
        },
      ],
    });
  }
  if (selection.startLine > availableLineCount) {
    fail(
      source.truncated
        ? "view_range_outside_bounded_scan"
        : "view_range_outside_file",
      source.truncated
        ? `Requested range is beyond the bounded scan for ${input.target.logicalPath}.`
        : `Requested range is beyond the file: ${input.target.logicalPath}.`,
    );
  }
  const endLine = Math.min(selection.endLine, availableLineCount);
  const rendered = formatLines(lines, selection.startLine, endLine);
  const boundedContent = boundText(rendered, {
    maxChars: 24_000,
    marker: "\n[file window output truncated]",
  });
  const viewComplete =
    !source.truncated &&
    selection.startLine === 1 &&
    endLine === availableLineCount;
  return successResult({
    output: [
      `Path: ${input.target.logicalPath}`,
      "Mode: file",
      `Range: lines ${selection.startLine}-${endLine}${source.truncated ? " of scanned prefix" : ` of ${availableLineCount}`}`,
      `Coverage: ${viewComplete ? "complete file" : "partial file window"}`,
      `Bytes scanned: ${source.bytesRead}/${source.byteCount}`,
      ...(selection.rangeTruncated
        ? [`Line limit: ${MAX_VIEW_LINES}; more lines were requested`]
        : []),
      ...(source.truncated
        ? [`Scan truncated: ${source.omittedBytes} bytes not scanned`]
        : []),
      "Content:",
      boundedContent.text,
    ].join("\n"),
    progress: true,
    data: {
      hasData: true,
      itemCount: endLine - selection.startLine + 1,
      location: input.target.location,
      path: input.target.logicalPath,
      range: { startLine: selection.startLine, endLine },
      truncation: {
        lineWindowTruncated: selection.rangeTruncated,
        scanTruncated: source.truncated,
        omittedBytes: source.omittedBytes,
        output: boundedContent.metadata,
      },
      observationMeta: {
        kind: "volatile_external",
        carryPolicy: "never",
      },
      eventMeta: {
        path: input.target.logicalPath,
        mode: "file",
        startLine: selection.startLine,
        endLine,
        complete: viewComplete && !boundedContent.metadata.truncated,
        scanTruncated: source.truncated,
        outputTruncated: boundedContent.metadata.truncated,
      },
    },
    actions: [
      {
        type: "inspect_target",
        target: input.target.logicalPath,
        details: `view:${selection.startLine}-${endLine}`,
      },
    ],
  });
}
