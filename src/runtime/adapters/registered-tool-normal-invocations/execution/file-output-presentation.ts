import { isAbsolute } from "node:path";
import {
  isToolFileOutputLocation,
  parseToolFileOutputRootIdentity,
  parseToolFileOutputReceipt,
  type ToolFileOutputReceipt,
  type ToolFileOutputReport,
  type ToolFileOutputReporter,
} from "../../../../capabilities/file-output-presentation.js";
import type {
  ResolvedRuntimeToolPath,
  RuntimeToolPathResolver,
  ToolEventMetadata,
  ToolExecutionResult,
  ToolExecutionSharedState,
  ToolNormalInvocationEffect,
} from "../../../../capabilities/tool-types.js";
import { createRuntimeToolPathResolver } from "../../../capabilities/runtime-target-path.js";
import { captureFileOutputRootId } from "../../../capabilities/file-output-root-identity.js";

function matchesReportedFileTarget(
  target: ResolvedRuntimeToolPath,
  resolved: ResolvedRuntimeToolPath,
): boolean {
  if (target.location !== resolved.location) return false;
  if (target.rootPath !== resolved.rootPath) return false;
  if (target.absolutePath !== resolved.absolutePath) return false;
  if (target.relativePath !== resolved.relativePath) return false;
  return target.logicalPath === resolved.logicalPath;
}

function captureReportedFileOutput(
  report: ToolFileOutputReport,
  resolver: RuntimeToolPathResolver,
): ToolFileOutputReceipt | undefined {
  const rootIdentity = parseToolFileOutputRootIdentity(report.rootIdentity);
  if (!rootIdentity) return undefined;
  const target = report.target;
  if (!isToolFileOutputLocation(target.location)) return undefined;
  if (!isAbsolute(target.absolutePath)) return undefined;
  const resolved = resolver.resolve(target.absolutePath, {
    requirePath: true,
    allowedLocations: [target.location],
  });
  if (!matchesReportedFileTarget(target, resolved)) return undefined;
  return parseToolFileOutputReceipt({
    version: 1,
    location: target.location,
    rootId: captureFileOutputRootId(
      target.location,
      resolved.rootPath,
      rootIdentity,
    ),
    relativePath: target.relativePath,
    logicalPath: target.logicalPath,
    operation: report.operation,
  });
}

function isSameFileOutputReceipt(
  left: ToolFileOutputReceipt,
  right: ToolFileOutputReceipt,
): boolean {
  if (left.rootId !== right.rootId) return false;
  if (left.relativePath !== right.relativePath) return false;
  return left.operation === right.operation;
}

function hasConflictingFileOutputReceipt(
  previous: ToolFileOutputReceipt | undefined,
  next: ToolFileOutputReceipt,
): boolean {
  if (!previous) return false;
  return !isSameFileOutputReceipt(previous, next);
}

function canPublishFileOutput(
  result: ToolExecutionResult,
  effect: ToolNormalInvocationEffect,
): boolean {
  if (!result.ok) return false;
  if (result.data?.mutationEvidence !== true) return false;
  return effect !== "read_only";
}

function omitReservedFileOutput(
  metadata: ToolEventMetadata | undefined,
): ToolEventMetadata {
  const { fileOutput: _untrustedFileOutput, ...rest } = metadata ?? {};
  return rest;
}

/** One invocation-local presentation collector; canonical results are untouched. */
export function createFileOutputPresentation(
  runtimePaths: ToolExecutionSharedState["runtimePaths"],
) {
  const resolver = createRuntimeToolPathResolver(runtimePaths);
  let receipt: ToolFileOutputReceipt | undefined;
  let rejected = false;
  let finished = false;

  const report: ToolFileOutputReporter = (input) => {
    if (finished) return;
    if (rejected) return;
    try {
      const captured = captureReportedFileOutput(input, resolver);
      if (!captured) {
        rejected = true;
        return;
      }
      if (hasConflictingFileOutputReceipt(receipt, captured)) {
        rejected = true;
        return;
      }
      receipt = captured;
    } catch {
      rejected = true;
    }
  };

  return Object.freeze({
    report,
    finish(
      result: ToolExecutionResult,
      metadata: ToolEventMetadata | undefined,
      effect: ToolNormalInvocationEffect,
    ): ToolEventMetadata | undefined {
      finished = true;
      const base = omitReservedFileOutput(metadata);
      const fallback = Object.keys(base).length > 0 ? base : undefined;
      if (rejected) return fallback;
      if (!receipt) return fallback;
      if (!canPublishFileOutput(result, effect)) return fallback;
      return { ...base, fileOutput: receipt };
    },
  });
}
