import type { ToolPayloadChannelStageSpec } from "../tool-types.js";
import { TOOL_PAYLOAD_STAGE_LITERAL_OUTPUT_MAX_BYTES } from "../tool-types.js";
import {
  TOOL_NORMAL_INVOCATION_IDENTIFIER_MAX_LENGTH,
  TOOL_NORMAL_INVOCATION_PAYLOAD_MAX_BYTES,
} from "../normal-invocation/contracts.js";
import {
  createInvalidToolDefinitionError as invalidPayloadStageCondition,
  isToolDefinitionRecordValue,
} from "./definition-shape.js";

const PAYLOAD_STAGE_CONDITION_VALUE_MAX_LENGTH = 256;

export function parsePayloadStageMinBytesOverride(
  params: Readonly<{
    toolName: string;
    stageIndex: number;
    input: unknown;
    baseMinBytes: unknown;
    includeMaterializedParams: unknown;
    stages: readonly unknown[];
    inheritedResponseFormat: unknown;
  }>,
): NonNullable<ToolPayloadChannelStageSpec["minBytesOverride"]> {
  const path = `payloadChannelSpec.stages.${params.stageIndex}.minBytesOverride`;
  const input = params.input;
  if (!isToolDefinitionRecordValue(input)) {
    throw invalidPayloadStageCondition(params.toolName, path);
  }
  if (!hasPayloadStageMinBytesOverrideShape(params, input)) {
    throw invalidPayloadStageCondition(params.toolName, path);
  }
  const materializedParam = input.materializedParam as string;
  const property = input.property as string;
  const equals = input.equals as string;
  const overrideMinBytes = input.minBytes as number;
  const source = resolveUniquePriorPayloadStage(
    params.stages,
    params.stageIndex,
    materializedParam,
  );
  if (!source) {
    throw invalidPayloadStageCondition(params.toolName, `${path} source`);
  }
  const responseFormat =
    source.responseFormat ?? params.inheritedResponseFormat;
  if (
    !schemaAllowsPayloadStageStringCondition(responseFormat, property, equals)
  ) {
    throw invalidPayloadStageCondition(params.toolName, `${path} schema`);
  }
  return {
    materializedParam,
    property,
    equals,
    minBytes: overrideMinBytes,
  };
}

function hasPayloadStageMinBytesOverrideShape(
  params: Readonly<{
    baseMinBytes: unknown;
    includeMaterializedParams: unknown;
  }>,
  input: Record<string, unknown>,
): boolean {
  if (typeof params.baseMinBytes !== "number") return false;
  if (
    !hasExactKeys(input, [
      "materializedParam",
      "property",
      "equals",
      "minBytes",
    ])
  ) {
    return false;
  }
  if (!hasBoundedPayloadStageIdentifier(input.materializedParam)) return false;
  if (!hasBoundedPayloadStageIdentifier(input.property)) return false;
  if (!hasBoundedPayloadStageConditionMatch(input.equals)) return false;
  if (!isPayloadStageMinimumWithinInvocationBounds(input.minBytes)) {
    return false;
  }
  if (!Array.isArray(params.includeMaterializedParams)) return false;
  return params.includeMaterializedParams.includes(input.materializedParam);
}

export function parsePayloadStageLiteralOutput(
  params: Readonly<{
    toolName: string;
    stageIndex: number;
    input: unknown;
    stageOutputParam: string;
    finalOutputParam: unknown;
    stageResponseFormat: unknown;
    inheritedResponseFormat: unknown;
    stageTargetLineBoundProperties: unknown;
    stageMinBytesOverride: unknown;
    includeMaterializedParams: unknown;
    stages: readonly unknown[];
  }>,
): NonNullable<ToolPayloadChannelStageSpec["literalOutput"]> | undefined {
  if (params.input === undefined) return undefined;
  const path = `payloadChannelSpec.stages.${params.stageIndex}.literalOutput`;
  const input = params.input;
  if (!isToolDefinitionRecordValue(input)) {
    throw invalidPayloadStageCondition(params.toolName, path);
  }
  if (!hasPayloadStageLiteralOutputShape(input)) {
    throw invalidPayloadStageCondition(params.toolName, path);
  }
  if (!canApplyLiteralOutputToPayloadStage(params, input)) {
    throw invalidPayloadStageCondition(params.toolName, path);
  }
  const when = input.when as Record<string, unknown>;
  const materializedParam = when.materializedParam as string;
  const property = when.property as string;
  const equals = when.equals as string;
  const source = resolveUniquePriorPayloadStage(
    params.stages,
    params.stageIndex,
    materializedParam,
  );
  if (!source) {
    throw invalidPayloadStageCondition(params.toolName, `${path} source`);
  }
  const sourceResponseFormat =
    source.responseFormat ?? params.inheritedResponseFormat;
  if (
    !schemaAllowsPayloadStageStringCondition(
      sourceResponseFormat,
      property,
      equals,
    )
  ) {
    throw invalidPayloadStageCondition(params.toolName, `${path} schema`);
  }
  return {
    when: { materializedParam, property, equals },
    value: input.value as string,
  };
}

function hasPayloadStageLiteralOutputShape(
  input: Record<string, unknown>,
): boolean {
  if (!hasExactKeys(input, ["when", "value"])) return false;
  if (!isToolDefinitionRecordValue(input.when)) return false;
  if (!hasExactKeys(input.when, ["materializedParam", "property", "equals"])) {
    return false;
  }
  if (!hasVisibleBoundedPayloadStageIdentifier(input.when.materializedParam)) {
    return false;
  }
  if (!hasVisibleBoundedPayloadStageIdentifier(input.when.property)) {
    return false;
  }
  if (!hasBoundedPayloadStageConditionMatch(input.when.equals)) return false;
  if (typeof input.value !== "string") return false;
  return (
    Buffer.byteLength(input.value, "utf8") <=
    TOOL_PAYLOAD_STAGE_LITERAL_OUTPUT_MAX_BYTES
  );
}

function canApplyLiteralOutputToPayloadStage(
  params: Readonly<{
    stageOutputParam: string;
    finalOutputParam: unknown;
    stageResponseFormat: unknown;
    inheritedResponseFormat: unknown;
    stageTargetLineBoundProperties: unknown;
    stageMinBytesOverride: unknown;
    includeMaterializedParams: unknown;
  }>,
  input: Record<string, unknown>,
): boolean {
  if (params.stageOutputParam !== params.finalOutputParam) return false;
  if (params.stageResponseFormat !== undefined) return false;
  if (params.inheritedResponseFormat !== undefined) return false;
  if (params.stageTargetLineBoundProperties !== undefined) return false;
  if (params.stageMinBytesOverride !== undefined) return false;
  if (!Array.isArray(params.includeMaterializedParams)) return false;
  const when = input.when as Record<string, unknown>;
  return params.includeMaterializedParams.includes(when.materializedParam);
}

function resolveUniquePriorPayloadStage(
  stages: readonly unknown[],
  stageIndex: number,
  materializedParam: string,
): Record<string, unknown> | undefined {
  const matchingStages = stages
    .slice(0, stageIndex)
    .filter(isToolDefinitionRecordValue)
    .filter((stage) => stage.outputParam === materializedParam);
  if (matchingStages.length !== 1) return undefined;
  return matchingStages[0];
}

function schemaAllowsPayloadStageStringCondition(
  input: unknown,
  property: string,
  equals: string,
): boolean {
  if (!isToolDefinitionRecordValue(input) || input.type !== "object") {
    return false;
  }
  const properties = input.properties;
  const required = input.required;
  if (!isToolDefinitionRecordValue(properties)) return false;
  if (!Array.isArray(required)) return false;
  if (!required.includes(property)) return false;
  const propertySchema = properties[property];
  if (!isToolDefinitionRecordValue(propertySchema)) return false;
  if (propertySchema.type !== "string") return false;
  if (!Array.isArray(propertySchema.enum)) return false;
  if (propertySchema.enum.length === 0) return false;
  if (propertySchema.enum.some((value) => typeof value !== "string")) {
    return false;
  }
  return propertySchema.enum.includes(equals);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const keys = Object.keys(value);
  if (keys.length !== expectedKeys.length) return false;
  return keys.every((key) => expectedKeys.includes(key));
}

function hasBoundedPayloadStageIdentifier(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0) return false;
  return value.length <= TOOL_NORMAL_INVOCATION_IDENTIFIER_MAX_LENGTH;
}

function hasVisibleBoundedPayloadStageIdentifier(
  value: unknown,
): value is string {
  if (!hasBoundedPayloadStageIdentifier(value)) return false;
  return value.trim().length > 0;
}

function hasBoundedPayloadStageConditionMatch(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0) return false;
  return value.length <= PAYLOAD_STAGE_CONDITION_VALUE_MAX_LENGTH;
}

export function isPayloadStageMinimumWithinInvocationBounds(
  value: unknown,
): value is number {
  if (typeof value !== "number") return false;
  if (!Number.isSafeInteger(value)) return false;
  if (value < 0) return false;
  return value <= TOOL_NORMAL_INVOCATION_PAYLOAD_MAX_BYTES;
}
