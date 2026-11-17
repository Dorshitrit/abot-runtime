import { readRequiredString, successResult, type ToolImplementation } from "../../../src/plugin-sdk/index.js";
import type { FilesystemPathService } from "../../filesystem/source/path-service.js";
import { fail } from "../../filesystem/source/errors.js";
import type { RangeReferences } from "./range-references.js";
import { lineAt, readSnapshot, versionKey } from "./snapshot.js";
import { selectReadWindow } from "./read-window.js";

export function createReadTextHandler(paths: FilesystemPathService, references: RangeReferences): ToolImplementation {
  return async (params, context) => {
    const target = paths.resolve(readRequiredString(params.path, "path"), context);
    const snapshot = await readSnapshot(target);
    if (snapshot.content === null) fail("file_not_found", "The requested text file does not exist.");
    const content = snapshot.content;
    const window = selectReadWindow(content, params);
    const { start, end: actualEnd, text, startLine, totalLines, truncated, complete, byteRange } = window;
    const rangeRef = truncated ? undefined : references.observe({
      path: target.absolutePath, targetPath: target.logicalPath,
      version: versionKey(snapshot.version), start, end: actualEnd, text,
    });
    const output = [
      `Path: ${target.logicalPath}`,
      `Coverage: ${complete ? "complete file" : truncated ? "truncated window" : "complete requested window"}`,
      `Lines: ${startLine}-${lineAt(content, Math.max(start, actualEnd - 1))} of ${totalLines}`,
      ...(byteRange ? [`Bytes: ${byteRange.start_byte}-${byteRange.end_byte} of ${window.totalBytes} (zero-based, end-exclusive)`] : []),
      ...(byteRange?.next_byte !== undefined ? [`next_byte: ${byteRange.next_byte}`] : []),
      ...(rangeRef ? [`range_ref: ${rangeRef}`] : []),
      "Content:", text,
    ].join("\n");
    return successResult({ output, progress: true, data: {
      hasData: true, path: target.logicalPath, range_ref: rangeRef, ...byteRange,
      observationMeta: { kind: "volatile_external", carryPolicy: "never" },
      eventMeta: { path: target.logicalPath, operation: "read", mode: "file", startLine,
        endLine: lineAt(content, Math.max(start, actualEnd - 1)), totalLines,
        byteCount: Buffer.byteLength(text), truncated, complete,
        outputPreview: text.slice(0, 1200), outputPreviewTruncated: text.length > 1200 },
    } }, context?.resultBudget);
  };
}
