import { FilesystemToolError } from "../errors.js";
import {
  applyRepairResponse,
  buildRepairRequest,
  formatDiagnostic,
} from "./repair.js";
import type {
  DraftDiagnostic,
  DraftValidator,
  LineRange,
  PrepareDraftInput,
  PreparedDraft,
} from "./types.js";
import { resolveDraftValidator } from "./validators.js";

export async function prepareFileDraft(
  input: PrepareDraftInput,
): Promise<PreparedDraft> {
  const validator = resolveDraftValidator(input.targetPath);
  if (!validator) {
    return Object.freeze({
      content: input.candidate,
      validation: "not_applicable",
      structuralIntegrity: "unknown",
    });
  }
  let content = input.candidate;
  let diagnostic = validator.validate(content, input.targetPath);
  if (!diagnostic) return prepared(content, validator, "valid");
  if (!input.context?.modelInvoker) {
    throw draftError(
      "file_syntax_invalid",
      validator,
      diagnostic,
      "No bounded repair service is available.",
      false,
    );
  }

  const attemptLimit = diagnostic.repairAttemptLimit ?? 1;
  let changedRange: LineRange | undefined;
  for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
    let request;
    try {
      request = buildRepairRequest({
        targetPath: input.targetPath,
        candidate: content,
        validator,
        diagnostic,
        ...(input.repairScope ? { repairScope: input.repairScope } : {}),
      });
    } catch (error: unknown) {
      if (hasCode(error, "file_syntax_repair_scope_invalid")) {
        throw draftError(
          "file_syntax_repair_scope_invalid",
          validator,
          diagnostic,
          error instanceof Error ? error.message : "Invalid repair scope.",
          attempt > 1,
        );
      }
      throw error;
    }

    let applied;
    try {
      const response = await input.context.modelInvoker.invokeText({
        modelStep: "tool_payload.raw",
        instructions: request.instructions,
        prompt: request.prompt,
        timeoutReason: "file_draft_repair_timeout",
        format: request.format,
      });
      applied = applyRepairResponse(content, request, response);
    } catch (error: unknown) {
      if (
        input.context.abortSignal?.aborted ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        throw error;
      }
      throw draftError(
        "file_syntax_repair_failed",
        validator,
        diagnostic,
        "The bounded repair could not be authored.",
        true,
      );
    }
    if (applied.content === content) {
      throw draftError(
        "file_syntax_repair_invalid",
        validator,
        diagnostic,
        "The bounded repair did not change the invalid draft.",
        true,
      );
    }
    content = applied.content;
    changedRange = mergeRanges(changedRange, applied.changedRange);
    const remaining = validator.validate(content, input.targetPath);
    if (!remaining) {
      return Object.freeze({
        ...prepared(content, validator, "repaired"),
        ...(changedRange ? { changedRange } : {}),
      });
    }
    if (attempt === attemptLimit) {
      throw draftError(
        "file_syntax_repair_invalid",
        validator,
        remaining,
        `The bounded repair did not produce valid ${validator.label}.`,
        true,
      );
    }
    diagnostic = remaining;
  }
  throw new FilesystemToolError(
    "file_draft_repair_attempts_exhausted",
    "Draft repair attempts were exhausted.",
  );
}

function prepared(
  content: string,
  validator: DraftValidator,
  validation: "valid" | "repaired",
): PreparedDraft {
  return Object.freeze({
    content,
    validation,
    structuralIntegrity: validator.authoritativeStructure
      ? "validated"
      : "unknown",
    validatorId: validator.id,
  });
}

function mergeRanges(
  current: LineRange | undefined,
  next: LineRange,
): LineRange {
  return Object.freeze({
    startLine: Math.min(current?.startLine ?? next.startLine, next.startLine),
    endLine: Math.max(current?.endLine ?? next.endLine, next.endLine),
  });
}

function draftError(
  code: string,
  validator: DraftValidator,
  diagnostic: DraftDiagnostic,
  reason: string,
  repairAttempted: boolean,
): FilesystemToolError {
  return new FilesystemToolError(
    code,
    [
      `${validator.label} draft is syntactically invalid: ${formatDiagnostic(diagnostic)}`,
      reason,
      "No file was written. Correct the local payload before retrying.",
    ].join("\n"),
    {
      validatorId: validator.id,
      diagnosticCode: diagnostic.code,
      repairAttempted,
      ...(diagnostic.line === undefined ? {} : { line: diagnostic.line }),
      ...(diagnostic.column === undefined ? {} : { column: diagnostic.column }),
    },
  );
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
