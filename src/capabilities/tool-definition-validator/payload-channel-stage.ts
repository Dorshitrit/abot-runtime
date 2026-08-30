import type { ToolPayloadChannelStageSpec } from "../tool-types.js";
import {
  createInvalidToolDefinitionError as invalidPayloadChannelStage,
  isPayloadContextScope,
  isPayloadResponseFormat,
  isPayloadTargetContext,
  isToolDefinitionRecordValue,
} from "./definition-shape.js";
import {
  isPayloadStageMinimumWithinInvocationBounds,
  parsePayloadStageLiteralOutput,
  parsePayloadStageMinBytesOverride,
} from "./payload-stage-conditions.js";

type PayloadChannelStageParsingContext = Readonly<{
  toolName: string;
  toolParams: Readonly<Record<string, string>>;
  payloadParams: readonly string[];
  finalOutputParam: string;
  stages: readonly unknown[];
  inheritedResponseFormat: unknown;
}>;

export function parsePayloadChannelStages(
  context: PayloadChannelStageParsingContext,
): ToolPayloadChannelStageSpec[] {
  return context.stages.map((stage, index) =>
    parsePayloadChannelStage(context, stage, index),
  );
}

function parsePayloadChannelStage(
  context: PayloadChannelStageParsingContext,
  raw: unknown,
  stageIndex: number,
): ToolPayloadChannelStageSpec {
  const path = `payloadChannelSpec.stages.${stageIndex}`;
  if (!isToolDefinitionRecordValue(raw)) {
    throw invalidPayloadChannelStage(context.toolName, path);
  }

  const outputParam = raw.outputParam;
  const contextScope = raw.contextScope;
  const targetContext = raw.targetContext;
  const responseFormat = raw.responseFormat;
  const targetLineBoundProperties = raw.targetLineBoundProperties;
  const promptHint = raw.promptHint;
  const includeMaterializedParams = raw.includeMaterializedParams;
  const minBytes = raw.minBytes;
  const minBytesOverride = raw.minBytesOverride;
  const literalOutput = raw.literalOutput;

  if (!hasSupportedPayloadStageOutput(context, outputParam)) {
    throw invalidPayloadChannelStage(context.toolName, `${path}.outputParam`);
  }
  if (contextScope !== undefined && !isPayloadContextScope(contextScope)) {
    throw invalidPayloadChannelStage(context.toolName, `${path}.contextScope`);
  }
  if (targetContext !== undefined && !isPayloadTargetContext(targetContext)) {
    throw invalidPayloadChannelStage(context.toolName, `${path}.targetContext`);
  }
  if (
    responseFormat !== undefined &&
    !isPayloadResponseFormat(responseFormat)
  ) {
    throw invalidPayloadChannelStage(
      context.toolName,
      `${path}.responseFormat`,
    );
  }
  if (!hasSupportedTargetLineBoundProperties(targetLineBoundProperties)) {
    throw invalidPayloadChannelStage(
      context.toolName,
      `${path}.targetLineBoundProperties`,
    );
  }
  if (promptHint !== undefined && typeof promptHint !== "string") {
    throw invalidPayloadChannelStage(context.toolName, `${path}.promptHint`);
  }
  if (
    !hasSupportedMaterializedStageInputs(
      includeMaterializedParams,
      context.payloadParams,
    )
  ) {
    throw invalidPayloadChannelStage(
      context.toolName,
      `${path}.includeMaterializedParams`,
    );
  }
  if (!hasSupportedPayloadStageMinimum(minBytes)) {
    throw invalidPayloadChannelStage(context.toolName, `${path}.minBytes`);
  }

  const normalizedOutputParam = outputParam.trim();
  if (
    hasPayloadStageByteMinimum(minBytes, minBytesOverride) &&
    normalizedOutputParam !== context.finalOutputParam
  ) {
    throw invalidPayloadChannelStage(
      context.toolName,
      `${path} byte minimum must belong to the final payload stage`,
    );
  }
  if (
    !referencesAvailableMaterializedStageInputs(
      context.stages,
      stageIndex,
      includeMaterializedParams,
    )
  ) {
    throw invalidPayloadChannelStage(
      context.toolName,
      `${path} references unavailable materialized params`,
    );
  }

  let parsedMinBytesOverride:
    | ToolPayloadChannelStageSpec["minBytesOverride"]
    | undefined;
  if (minBytesOverride !== undefined) {
    parsedMinBytesOverride = parsePayloadStageMinBytesOverride({
      toolName: context.toolName,
      stageIndex,
      input: minBytesOverride,
      baseMinBytes: minBytes,
      includeMaterializedParams,
      stages: context.stages,
      inheritedResponseFormat: context.inheritedResponseFormat,
    });
  }
  const parsedLiteralOutput = parsePayloadStageLiteralOutput({
    toolName: context.toolName,
    stageIndex,
    input: literalOutput,
    stageOutputParam: normalizedOutputParam,
    finalOutputParam: context.finalOutputParam,
    stageResponseFormat: responseFormat,
    inheritedResponseFormat: context.inheritedResponseFormat,
    stageTargetLineBoundProperties: targetLineBoundProperties,
    stageMinBytesOverride: minBytesOverride,
    includeMaterializedParams,
    stages: context.stages,
  });

  const parsed: ToolPayloadChannelStageSpec = {
    outputParam: normalizedOutputParam,
  };
  if (isPayloadContextScope(contextScope)) {
    parsed.contextScope = contextScope;
  }
  if (isPayloadTargetContext(targetContext)) {
    parsed.targetContext = targetContext;
  }
  if (isPayloadResponseFormat(responseFormat)) {
    parsed.responseFormat = responseFormat;
  }
  if (Array.isArray(targetLineBoundProperties)) {
    parsed.targetLineBoundProperties = [...targetLineBoundProperties];
  }
  if (typeof promptHint === "string") {
    parsed.promptHint = promptHint;
  }
  if (Array.isArray(includeMaterializedParams)) {
    parsed.includeMaterializedParams = [...includeMaterializedParams];
  }
  if (typeof minBytes === "number") {
    parsed.minBytes = minBytes;
  }
  if (parsedMinBytesOverride) {
    parsed.minBytesOverride = parsedMinBytesOverride;
  }
  if (parsedLiteralOutput) {
    parsed.literalOutput = parsedLiteralOutput;
  }
  return parsed;
}

function hasSupportedPayloadStageOutput(
  context: Pick<
    PayloadChannelStageParsingContext,
    "payloadParams" | "toolParams"
  >,
  value: unknown,
): value is string {
  if (typeof value !== "string") return false;
  if (value.trim().length === 0) return false;
  if (!context.payloadParams.includes(value)) return false;
  return context.toolParams[value] === "string";
}

function hasSupportedTargetLineBoundProperties(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  if (value.length === 0) return false;
  if (new Set(value).size !== value.length) return false;
  return value.every(
    (property) => typeof property === "string" && property.trim().length > 0,
  );
}

function hasSupportedMaterializedStageInputs(
  value: unknown,
  payloadParams: readonly string[],
): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  return value.every(
    (paramName) =>
      typeof paramName === "string" && payloadParams.includes(paramName),
  );
}

function hasSupportedPayloadStageMinimum(value: unknown): boolean {
  if (value === undefined) return true;
  return isPayloadStageMinimumWithinInvocationBounds(value);
}

function hasPayloadStageByteMinimum(
  minBytes: unknown,
  minBytesOverride: unknown,
): boolean {
  return minBytes !== undefined || minBytesOverride !== undefined;
}

function referencesAvailableMaterializedStageInputs(
  stages: readonly unknown[],
  stageIndex: number,
  includeMaterializedParams: unknown,
): boolean {
  if (!Array.isArray(includeMaterializedParams)) return true;
  const priorStageOutputs = new Set(
    stages
      .slice(0, stageIndex)
      .filter(isToolDefinitionRecordValue)
      .map((stage) => stage.outputParam)
      .filter(
        (paramName): paramName is string => typeof paramName === "string",
      ),
  );
  return includeMaterializedParams.every((paramName) =>
    priorStageOutputs.has(paramName),
  );
}
