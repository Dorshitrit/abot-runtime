import type { ToolRequestAttachment } from "../../capabilities/tool-types.js";
import type { AgentNode, OperationRef, SourceFileSnapshot, ToolNode, ValueBinding } from "./definition-contracts.js";

type AttachmentInput = Readonly<{
  param: string;
  acceptedMimeTypes: readonly string[];
  mode?: Readonly<{ param: string; value: string }>;
}>;

export type AttachmentInputOperation = OperationRef & Readonly<{
  attachmentInput?: AttachmentInput;
}>;

function matchesOperation(left: OperationRef, right: OperationRef): boolean {
  return left.toolName === right.toolName && left.operationId === right.operationId &&
    left.contractVersion === right.contractVersion;
}

function selectedAttachmentInputs(
  node: AgentNode | ToolNode,
  operations: readonly AttachmentInputOperation[],
): readonly AttachmentInput[] {
  const selected = node.kind === "agent" ? node.tools.map((item) => item.operation) : [node.operation];
  return selected.flatMap((operation) => {
    const capability = operations.find((item) => matchesOperation(item, operation))?.attachmentInput;
    return capability ? [capability] : [];
  });
}

export function usesSourceFileContents(binding: ValueBinding): boolean {
  return binding.kind === "source_files" ||
    (binding.kind === "source_file" && binding.field === "snapshot_path");
}

export function sourceAttachmentIssue(
  node: AgentNode | ToolNode,
  operations: readonly AttachmentInputOperation[],
): string | null {
  if (node.kind === "agent") {
    const needsSourceReader = Object.values(node.inputs).some(usesSourceFileContents);
    return needsSourceReader && selectedAttachmentInputs(node, operations).length === 0
      ? "automation_source_reader_unavailable" : null;
  }
  const snapshotControls = Object.entries(node.controls).filter(([, binding]) =>
    usesSourceFileContents(binding));
  if (!snapshotControls.length && !node.payload) return null;
  if (node.payload && usesSourceFileContents(node.payload))
    return "automation_source_reader_unavailable";
  if (!snapshotControls.length) return null;
  const capability = selectedAttachmentInputs(node, operations)[0];
  if (!capability || snapshotControls.length !== 1 ||
      snapshotControls[0]![0] !== capability.param)
    return "automation_source_reader_unavailable";
  const mode = capability.mode && node.controls[capability.mode.param];
  return mode && (mode.kind !== "literal" || mode.value !== capability.mode?.value)
    ? "automation_source_reader_unavailable" : null;
}

/** Exposes only the frozen inputs selected by this node, under the exact source aliases it receives. */
export function sourceAttachmentsForNode(input: {
  node: AgentNode | ToolNode;
  sourceFiles: readonly SourceFileSnapshot[];
  sourceAttachments: readonly ToolRequestAttachment[];
  operations: readonly AttachmentInputOperation[];
}): readonly ToolRequestAttachment[] {
  const { node } = input;
  const bindings = node.kind === "agent" ? Object.values(node.inputs)
    : [...Object.values(node.controls), ...(node.payload ? [node.payload] : [])];
  const selected = new Set<number>();
  for (const binding of bindings) {
    if (binding.kind === "source_files")
      input.sourceFiles.forEach((_file, index) => selected.add(index));
    else if (binding.kind === "source_file" && usesSourceFileContents(binding))
      selected.add(binding.index);
  }
  if (!selected.size) return [];
  const issue = sourceAttachmentIssue(node, input.operations);
  if (issue) throw new Error(issue);
  const accepted = selectedAttachmentInputs(node, input.operations);
  const handles = [...selected].map((index) => {
    const attachment = input.sourceAttachments[index];
    const file = input.sourceFiles[index];
    if (!attachment || !file) throw new Error("automation_dependency_missing");
    if (attachment.kind !== "file" || !accepted.some((capability) =>
      capability.acceptedMimeTypes.includes(attachment.mimeType)))
      throw new Error("automation_source_type_unsupported");
    return { attachment, file };
  });
  if (node.kind === "tool")
    return handles.map(({ attachment, file }) => ({ ...attachment, id: file.snapshotPath }));
  return handles.flatMap(({ attachment, file }) => [
    attachment,
    { ...attachment, id: file.snapshotPath, name: undefined },
  ]);
}
