import {
  readRequiredString,
  successResult,
  type ToolImplementation,
} from "../../../src/plugin-sdk/index.js";

import { atomicWriteText } from "./atomic-write.js";
import {
  assertMutationContentSize,
  assertMutationTargetUnchanged,
  MAX_MUTATION_BYTES,
  readMutationSnapshot,
} from "./bounded-io.js";
import { buildMutationGrounding } from "./draft/grounding.js";
import { prepareFileDraft } from "./draft/prepare.js";
import { fail } from "./errors.js";
import type { FilesystemMutationCoordinator } from "./mutation-coordinator.js";
import type { FilesystemPathService } from "./path-service.js";

export function createWriteFileHandler(
  paths: FilesystemPathService,
  mutations: FilesystemMutationCoordinator,
): ToolImplementation {
  return async (params, context) => {
    const requestedPath = readRequiredString(params.path, "path");
    const content = resolveContent(params);
    const contentBytes = Buffer.byteLength(content, "utf8");
    if (contentBytes > MAX_MUTATION_BYTES) {
      fail(
        "file_too_large",
        `Content exceeds the ${MAX_MUTATION_BYTES}-byte mutation limit.`,
        { byteCount: contentBytes, maxBytes: MAX_MUTATION_BYTES },
      );
    }
    const target = paths.resolve(requestedPath, context);
    return mutations.runExclusive(target.absolutePath, async () => {
      const snapshot = await readMutationSnapshot(target);
      const previousContent = snapshot.content;
      const prepared = await prepareFileDraft({
        targetPath: target.logicalPath,
        candidate: content,
        ...(context ? { context } : {}),
      });
      assertMutationContentSize(prepared.content);
      if (previousContent === prepared.content) {
        await assertMutationTargetUnchanged(target, snapshot.version);
        return successResult({
          output: [
            `Path: ${target.logicalPath}`,
            "Bytes written: 0",
            "Write: no-op",
          ].join("\n"),
          progress: true,
          producedNewInformation: false,
          actions: [
            {
              type: "state_already_satisfied",
              target: target.logicalPath,
              details: "write_full_content",
            },
          ],
          data: {
            mutationEvidence: false,
            stateAlreadySatisfied: true,
            path: target.logicalPath,
            eventMeta: { path: target.logicalPath, state: "unchanged" },
          },
        });
      }

      const grounding = buildMutationGrounding({
        logicalPath: target.logicalPath,
        content: prepared.content,
        ...(previousContent === null ? {} : { previousContent }),
        prepared,
      });
      const state =
        previousContent === null ? "establish_target" : "refine_target";
      const result = successResult({
        output: [
          `Path: ${target.logicalPath}`,
          `Bytes written: ${grounding.byteCount}`,
          "Write: success",
        ].join("\n"),
        progress: true,
        actions: [
          {
            type: state,
            target: target.logicalPath,
            details: "write_full_content",
          },
        ],
        data: {
          mutationEvidence: true,
          mutationGrounding: grounding.summary,
          path: target.logicalPath,
          byteCount: grounding.byteCount,
          lineCount: grounding.lineCount,
          validation: prepared.validation,
          truncation: {
            groundingTruncated: grounding.snapshotTruncated,
            groundingCoverage: grounding.snapshotCoverage,
          },
          eventMeta: {
            path: target.logicalPath,
            state,
            byteCount: grounding.byteCount,
          },
        },
      });
      assertPreparedMutationResult(result);
      await atomicWriteText({
        target,
        content: prepared.content,
        expectedVersion: snapshot.version,
      });
      return result;
    });
  };
}

function assertPreparedMutationResult(
  result: ReturnType<typeof successResult>,
): asserts result is ReturnType<typeof successResult> & Readonly<{ ok: true }> {
  if (result.ok) return;
  fail(
    result.errorCode ?? "plugin_result_invalid",
    result.error ?? result.output,
  );
}

function resolveContent(params: Readonly<Record<string, unknown>>): string {
  const content = params.content;
  const contentLines = params.content_lines;
  if (typeof content === "string" && Array.isArray(contentLines)) {
    fail("ambiguous_content", "Provide content or content_lines, not both.");
  }
  if (typeof content === "string") return content;
  if (Array.isArray(contentLines)) {
    if (!contentLines.every((line) => typeof line === "string")) {
      fail("invalid_content_lines", "content_lines must contain only strings.");
    }
    return contentLines.join("\n");
  }
  fail("invalid_content", "A complete file body is required.");
}
