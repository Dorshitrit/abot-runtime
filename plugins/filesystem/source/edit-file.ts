import {
  boundText,
  readRequiredString,
  successResult,
  type ToolImplementation,
} from "../../../src/plugin-sdk/index.js";

import { atomicWriteText } from "./atomic-write.js";
import {
  assertMutationContentSize,
  assertMutationTargetUnchanged,
  readMutationSnapshot,
} from "./bounded-io.js";
import { buildMutationGrounding } from "./draft/grounding.js";
import { prepareFileDraft } from "./draft/prepare.js";
import { fail } from "./errors.js";
import type { FilesystemMutationCoordinator } from "./mutation-coordinator.js";
import type { FilesystemPathService } from "./path-service.js";

type EditSelection = Readonly<{
  placement: "before" | "after" | "replace" | "delete";
  startLine: number;
  endLine: number;
}>;

export function createEditFileHandler(
  paths: FilesystemPathService,
  mutations: FilesystemMutationCoordinator,
): ToolImplementation {
  return async (params, context) => {
    const requestedPath = readRequiredString(params.path, "path");
    readRequiredString(params.instruction, "instruction");
    const selection = parseSelection(params.selection);
    const editContent = resolveEditContent(params.content, selection);
    const target = paths.resolve(requestedPath, context);
    return mutations.runExclusive(target.absolutePath, async () => {
      const snapshot = await readMutationSnapshot(target);
      const previousContent = snapshot.content;
      if (previousContent === null) {
        fail("file_not_found", `Path does not exist: ${target.logicalPath}`);
      }
      const applied = applyLineEdit(previousContent, selection, editContent);
      const prepared = await prepareFileDraft({
        targetPath: target.logicalPath,
        candidate: applied.content,
        ...(context ? { context } : {}),
        repairScope: {
          startLine: applied.changedStartLine,
          endLine: applied.changedEndLine,
        },
      });
      assertMutationContentSize(prepared.content);
      if (prepared.structuralIntegrity !== "validated") {
        const regressions = delimiterRegressions(
          previousContent,
          prepared.content,
        );
        if (regressions.length) {
          fail(
            "structural_regression",
            [
              `Edit would regress structural balance in ${target.logicalPath}.`,
              ...regressions.map((entry) => `- ${entry}`),
            ].join("\n"),
          );
        }
      }
      if (prepared.content === previousContent) {
        await assertMutationTargetUnchanged(target, snapshot.version);
        return successResult({
          output: [`Path: ${target.logicalPath}`, "Edit: no-op"].join("\n"),
          progress: true,
          producedNewInformation: false,
          actions: [
            {
              type: "state_already_satisfied",
              target: target.logicalPath,
              details: `line_edit:${selection.placement}`,
            },
          ],
          data: {
            mutationEvidence: false,
            stateAlreadySatisfied: true,
            currentStateEvidence: true,
            path: target.logicalPath,
          },
        });
      }

      const grounding = buildMutationGrounding({
        logicalPath: target.logicalPath,
        content: prepared.content,
        previousContent,
        prepared,
      });
      const changedStartLine = Math.min(
        applied.changedStartLine,
        prepared.changedRange?.startLine ?? applied.changedStartLine,
      );
      const changedEndLine = Math.max(
        applied.changedEndLine,
        prepared.changedRange?.endLine ?? applied.changedEndLine,
      );
      const result = successResult({
        output: [
          `Path: ${target.logicalPath}`,
          "Edit: success",
          `Updated range: lines ${changedStartLine}-${changedEndLine}`,
          renderWindow(prepared.content, changedStartLine, changedEndLine),
        ].join("\n"),
        progress: true,
        actions: [
          {
            type: "refine_target",
            target: target.logicalPath,
            details: `line_edit:${selection.placement}:${selection.startLine}-${selection.endLine}`,
          },
        ],
        data: {
          mutationEvidence: true,
          mutationGrounding: grounding.summary,
          currentStateEvidence: true,
          path: target.logicalPath,
          changedRange: {
            startLine: changedStartLine,
            endLine: changedEndLine,
          },
          validation: prepared.validation,
          eventMeta: {
            path: target.logicalPath,
            operation: selection.placement,
            changedStartLine,
            changedEndLine,
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

function parseSelection(value: unknown): EditSelection {
  if (typeof value !== "string" || !value.trim()) {
    fail("invalid_edit_payload", "A structured edit selection is required.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail("invalid_edit_payload", "Edit selection must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("invalid_edit_payload", "Edit selection must be one object.");
  }
  const record = parsed as Record<string, unknown>;
  const placement = record.placement;
  const startLine = record.start_line;
  const endLine = record.end_line;
  if (
    (placement !== "before" &&
      placement !== "after" &&
      placement !== "replace" &&
      placement !== "delete") ||
    typeof startLine !== "number" ||
    !Number.isSafeInteger(startLine) ||
    startLine < 1 ||
    typeof endLine !== "number" ||
    !Number.isSafeInteger(endLine) ||
    endLine < startLine ||
    ((placement === "before" || placement === "after") && startLine !== endLine)
  ) {
    fail("invalid_edit_payload", "Edit selection contains an invalid range.");
  }
  return Object.freeze({ placement, startLine, endLine });
}

function resolveEditContent(value: unknown, selection: EditSelection): string {
  const deletePayloadEmpty =
    value === undefined ||
    (typeof value === "string" && value.trim().length === 0);
  if (selection.placement === "delete") {
    if (!deletePayloadEmpty) {
      fail(
        "invalid_edit_payload",
        "Delete does not accept replacement content.",
      );
    }
    return "";
  }
  if (typeof value !== "string" || value.length === 0) {
    fail("invalid_edit_payload", "A non-empty raw edit body is required.");
  }
  return value;
}

function applyLineEdit(
  content: string,
  selection: EditSelection,
  editContent: string,
): Readonly<{
  content: string;
  changedStartLine: number;
  changedEndLine: number;
}> {
  const lines = content.split(/\r?\n/u);
  if (selection.endLine > lines.length) {
    fail(
      "invalid_edit_location",
      `Selected line range exceeds the current ${lines.length}-line file.`,
    );
  }
  const editLines =
    selection.placement === "delete" ? [] : splitPayload(editContent);
  const spliceStart =
    selection.placement === "after"
      ? selection.endLine
      : selection.startLine - 1;
  const deleteCount =
    selection.placement === "replace" || selection.placement === "delete"
      ? selection.endLine - selection.startLine + 1
      : 0;
  lines.splice(spliceStart, deleteCount, ...editLines);
  const startLine =
    selection.placement === "delete"
      ? Math.min(spliceStart + 1, Math.max(lines.length, 1))
      : spliceStart + 1;
  return Object.freeze({
    content: lines.join(content.includes("\r\n") ? "\r\n" : "\n"),
    changedStartLine: startLine,
    changedEndLine: Math.max(startLine, startLine + editLines.length - 1),
  });
}

function splitPayload(value: string): string[] {
  const normalized = value.replace(/\r\n/gu, "\n").replace(/\n$/u, "");
  return normalized ? normalized.split("\n") : [""];
}

function delimiterRegressions(previous: string, updated: string): string[] {
  const delimiters = [
    ["curly", "{", "}"],
    ["square", "[", "]"],
    ["paren", "(", ")"],
  ] as const;
  return delimiters.flatMap(([name, open, close]) => {
    if (!previous.includes(open) || !previous.includes(close)) return [];
    const before = balance(previous, open, close);
    const after = balance(updated, open, close);
    return before === 0 && after !== 0
      ? [`${name} delimiter balance changed from 0 to ${after}`]
      : [];
  });
}

function balance(content: string, open: string, close: string): number {
  let count = 0;
  for (const character of content) {
    if (character === open) count += 1;
    else if (character === close) count -= 1;
  }
  return count;
}

function renderWindow(
  content: string,
  startLine: number,
  endLine: number,
): string {
  const lines = content.split(/\r?\n/u);
  const from = Math.max(1, startLine - 8);
  const to = Math.min(lines.length, endLine + 8);
  const rendered = [
    `Updated content: lines ${from}-${to} of ${lines.length}`,
    ...lines
      .slice(from - 1, to)
      .map((line, index) => `${from + index} | ${line}`),
  ].join("\n");
  return boundText(rendered, {
    maxChars: 12_000,
    marker: "\n[updated window output truncated]",
  }).text;
}
