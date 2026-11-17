import { successResult, type ToolImplementation } from "../../../src/plugin-sdk/index.js";
import { atomicWriteText } from "../../filesystem/source/atomic-write.js";
import { assertMutationContentSize } from "../../filesystem/source/bounded-io.js";
import { fail } from "../../filesystem/source/errors.js";
import { reportCommittedFileOutput } from "../../filesystem/source/file-output-presentation.js";
import type { FilesystemMutationCoordinator } from "../../filesystem/source/mutation-coordinator.js";
import type { FilesystemPathService } from "../../filesystem/source/path-service.js";
import { applyEdits, type TextEdit } from "./edit-text.js";
import { buildEaMutationGrounding } from "./mutation-grounding.js";
import { boundPayload } from "./payload-source.js";
import type { PayloadBinding, RangeReferences } from "./range-references.js";
import { readSnapshot, versionKey } from "./snapshot.js";

export function createMutationHandler(paths: FilesystemPathService, references: RangeReferences,
  mutations: FilesystemMutationCoordinator, tool: "create_text" | "edit_text"): ToolImplementation {
  return async (params, context) => {
    const bound = boundPayload({ tool, params }, paths, references);
    if (context?.executionAuthority?.executionIdentity !== bound.identity) fail("ea_execution_authority_missing", "This mutation requires its captured execution authority.");
    return mutations.runExclusive(bound.target.absolutePath, async () => {
      context?.abortSignal?.throwIfAborted();
      const snapshot = await readSnapshot(bound.target);
      if (versionKey(snapshot.version) !== bound.binding.version) fail("filesystem_target_changed", "The target changed after preparation; no changes were applied.");
      const source = snapshot.content ?? "";
      const edits = resolvePreparedFileEdits(bound.binding, bound.body);
      const changedEdits = edits.filter((edit) => source.slice(edit.start, edit.end) !== edit.newText);
      const { content, ranges } = applyEdits(source, changedEdits);
      if (content.includes("\0") || Buffer.from(content, "utf8").toString("utf8") !== content)
        fail("ea_content_invalid", "Expected exact, well-formed UTF-8 text without binary NUL bytes.");
      const byteCount = assertMutationContentSize(content);
      const changed = snapshot.content === null || content !== source;
      const grounding = buildEaMutationGrounding({ logicalPath: bound.target.logicalPath, content,
        ...(snapshot.content === null ? {} : { previousContent: source }),
        prepared: { content, validation: "not_applicable", structuralIntegrity: "unknown" } });
      const preview = changedEdits.map((edit) => edit.newText).join("\n").slice(0, 1200);
      const result = successResult({
        output: `Path: ${bound.target.logicalPath}\n${changed ? "Applied" : "Unchanged"}: ${tool === "create_text" ? "create" : "edit"}\nChanged chunks: ${changedEdits.length}\nBytes: ${byteCount}`,
        progress: true, producedNewInformation: changed,
        actions: [{ type: mutationActionType(changed, tool), target: bound.target.logicalPath }],
        data: { hasData: true, path: bound.target.logicalPath, mutationEvidence: changed,
          stateAlreadySatisfied: !changed,
          mutationGrounding: grounding.summary, byteCount, lineCount: grounding.lineCount,
          truncation: { groundingTruncated: grounding.snapshotTruncated, groundingCoverage: grounding.snapshotCoverage },
          eventMeta: { path: bound.target.logicalPath, operation: tool === "create_text" ? "create" : "edit",
            state: changed ? "applied" : "unchanged", changedChunkCount: changedEdits.length,
            changedRanges: ranges, byteCount, outputPreview: preview,
            outputPreviewTruncated: changedEdits.map((edit) => edit.newText).join("\n").length > 1200 },
        },
      }, context?.resultBudget);
      if (!result.ok) return result;
      if (changed) {
        context?.abortSignal?.throwIfAborted();
        await atomicWriteText({ target: bound.target, content, expectedVersion: snapshot.version,
          onCommitted: (root) => reportCommittedFileOutput(context, bound.target,
            snapshot.content === null ? "created" : "updated", root) });
      }
      references.forget(bound.binding.id);
      return result;
    });
  };
}

function resolvePreparedFileEdits(binding: PayloadBinding, body: string): readonly TextEdit[] {
  if (binding.mode === "create") return [{ start: 0, end: 0, newText: body }];
  if (binding.mode === "range") return [{ start: binding.start!, end: binding.end!, newText: body }];
  return fail("ea_payload_binding_invalid", "This saved file edit requires a new range selection.");
}

function mutationActionType(changed: boolean, tool: "create_text" | "edit_text") {
  if (!changed) return "state_already_satisfied";
  if (tool === "create_text") return "establish_target";
  return "refine_target";
}
