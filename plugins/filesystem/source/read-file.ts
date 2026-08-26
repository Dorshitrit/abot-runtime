import {
  boundText,
  readRequiredString,
  successResult,
  type ToolImplementation,
} from "../../../src/plugin-sdk/index.js";

import { readBoundedText } from "./bounded-io.js";
import type { FilesystemPathService } from "./path-service.js";

export function createReadFileHandler(
  paths: FilesystemPathService,
): ToolImplementation {
  return async (params, context) => {
    const requestedPath = readRequiredString(params.path, "path");
    const target = paths.resolve(requestedPath, context);
    const result = await readBoundedText(target);
    const bounded = boundText(result.text, {
      maxChars: 24_000,
      marker: "\n[read output truncated]",
    });
    return successResult({
      output: [
        `Path: ${target.logicalPath}`,
        `Bytes: ${result.byteCount}`,
        `View: ${result.truncated ? "bounded head/tail" : "complete"}`,
        ...(result.truncated ? [`Omitted bytes: ${result.omittedBytes}`] : []),
        "Content:",
        bounded.text,
      ].join("\n"),
      progress: true,
      data: {
        hasData: true,
        itemCount: 1,
        location: target.location,
        path: target.logicalPath,
        byteCount: result.byteCount,
        bytesRead: result.bytesRead,
        truncation: {
          truncated: result.truncated || bounded.metadata.truncated,
          omittedBytes: result.omittedBytes,
          output: bounded.metadata,
        },
        observationMeta: {
          kind: "volatile_external",
          carryPolicy: "never",
        },
        eventMeta: {
          path: target.logicalPath,
          byteCount: result.byteCount,
          truncated: result.truncated || bounded.metadata.truncated,
        },
      },
      actions: [
        {
          type: "inspect_target",
          target: target.logicalPath,
          details: result.truncated ? "bounded_read" : "complete_read",
        },
      ],
    });
  };
}
