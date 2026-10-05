import { expect, test } from "vitest";
import type { ToolRequestAttachment } from "../../capabilities/tool-types.js";
import type { AgentNode, SourceFileSnapshot, ToolNode } from "../automations/definition-contracts.js";
import { sourceAttachmentIssue, sourceAttachmentsForNode } from "../automations/source-attachment-access.js";

const reader = { toolName: "document_reader", operationId: "read_document", contractVersion: 1 } as const;
const operations = [{ ...reader, attachmentInput: {
  param: "source", acceptedMimeTypes: ["text/plain"],
  mode: { param: "source_mode", value: "source" },
} }];
const files: SourceFileSnapshot[] = [
  { inputId: "input-1", sourceId: "source-1", originalPath: "/inbox/one.txt",
    snapshotPath: "/runtime/attachments/one.txt", version: "v1", sizeBytes: 3 },
  { inputId: "input-2", sourceId: "source-1", originalPath: "/inbox/two.txt",
    snapshotPath: "/runtime/attachments/two.txt", version: "v2", sizeBytes: 3 },
];
const attachments: ToolRequestAttachment[] = files.map((file) => ({
  id: file.inputId, kind: "file", mimeType: "text/plain", absolutePath: file.snapshotPath,
  name: file.originalPath.split("/").at(-1), size: file.sizeBytes,
}));
const agent: AgentNode = {
  kind: "agent", id: "agent-1", title: "Read", onFailure: "stop",
  modelProfileId: "local", agentMode: "fast", roleInstructions: "Read files.", prompt: "Summarize.",
  inputs: { files: { kind: "source_files" } },
  tools: [{ operation: reader, usage: "available" }], result: { kind: "text" },
};
const tool: ToolNode = {
  kind: "tool", id: "tool-1", title: "Read one", onFailure: "stop", operation: reader,
  controls: { source: { kind: "source_file", index: 1, field: "snapshot_path" },
    source_mode: { kind: "literal", value: "source" } },
};

test("Agent receives only selected frozen source files by input ID and path aliases", () => {
  expect(sourceAttachmentIssue(agent, operations)).toBeNull();
  const selected = sourceAttachmentsForNode({ node: agent, sourceFiles: files,
    sourceAttachments: attachments, operations });
  expect(selected.map((item) => item.id)).toEqual([
    "input-1", files[0]!.snapshotPath, "input-2", files[1]!.snapshotPath,
  ]);
  expect(selected.map((item) => item.absolutePath)).toEqual([
    files[0]!.snapshotPath, files[0]!.snapshotPath,
    files[1]!.snapshotPath, files[1]!.snapshotPath,
  ]);
  expect(selected.filter((item) => item.name === "one.txt")).toHaveLength(1);
});

test("direct Tool receives only the selected path alias for the document reader", () => {
  const selected = sourceAttachmentsForNode({ node: tool, sourceFiles: files,
    sourceAttachments: attachments, operations });
  expect(selected).toEqual([{ ...attachments[1], id: files[1]!.snapshotPath }]);
  expect(sourceAttachmentIssue({ ...tool, operation: {
    toolName: "filesystem", operationId: "read_file", contractVersion: 1,
  } }, operations)).toBe("automation_source_reader_unavailable");
  expect(sourceAttachmentIssue({ ...tool, controls: {
    source: { kind: "source_file", index: 1, field: "snapshot_path" },
    source_mode: { kind: "literal", value: "path" },
  } }, operations)).toBe("automation_source_reader_unavailable");
});

test("unsupported images and missing input handles fail before tool or model invocation", () => {
  const image = { ...attachments[0]!, kind: "image" as const, mimeType: "image/png" };
  expect(() => sourceAttachmentsForNode({ node: agent, sourceFiles: files,
    sourceAttachments: [image, attachments[1]!], operations }))
    .toThrow("automation_source_type_unsupported");
  expect(() => sourceAttachmentsForNode({ node: tool, sourceFiles: files,
    sourceAttachments: [attachments[0]!], operations }))
    .toThrow("automation_dependency_missing");
  expect(sourceAttachmentIssue({ ...agent, tools: [] }, operations))
    .toBe("automation_source_reader_unavailable");
  expect(() => sourceAttachmentsForNode({ node: tool, sourceFiles: files,
    sourceAttachments: [attachments[0]!, { ...attachments[1]!, mimeType: "application/octet-stream" }],
    operations })).toThrow("automation_source_type_unsupported");
});
