import type { ToolDefinition, ToolPayloadChannelSpec } from "../tool-types.js";
import {
  createInvalidToolDefinitionError as invalidPayloadChannelSpec,
  isPayloadContextScope,
  isPayloadResponseFormat,
  isPayloadTargetContext,
  isToolDefinitionRecordValue,
} from "./definition-shape.js";
import { parsePayloadChannelStages } from "./payload-channel-stage.js";

export function parsePayloadChannelSpec(
  toolName: string,
  params: Record<string, string>,
  raw: unknown,
): ToolDefinition["payloadChannelSpec"] {
  if (raw === undefined) return undefined;
  if (!isToolDefinitionRecordValue(raw)) {
    throw invalidPayloadChannelSpec(toolName, "payloadChannelSpec");
  }

  const payloadParams = raw.params;
  const outputParam = raw.outputParam;
  const generationMode = raw.generationMode;
  const targetParam = raw.targetParam;
  const targetRole = raw.targetRole;
  const contextScope = raw.contextScope;
  const targetContext = raw.targetContext;
  const responseFormat = raw.responseFormat;
  const promptHint = raw.promptHint;
  const stages = raw.stages;
  const groundingWindow = raw.groundingWindow;
  const requiresCurrentTargetObservation = raw.requiresCurrentTargetObservation;

  if (!hasSupportedPayloadParameters(payloadParams)) {
    throw invalidPayloadChannelSpec(toolName, "payloadChannelSpec.params");
  }
  if (typeof outputParam !== "string" || outputParam.trim().length === 0) {
    throw invalidPayloadChannelSpec(toolName, "payloadChannelSpec.outputParam");
  }
  if (generationMode !== "raw_text") {
    throw invalidPayloadChannelSpec(
      toolName,
      "payloadChannelSpec.generationMode",
    );
  }
  const payloadTargetParam = parsePayloadTargetParam(toolName, targetParam);
  if (targetRole !== undefined && !isPayloadTargetRole(targetRole)) {
    throw invalidPayloadChannelSpec(toolName, "payloadChannelSpec.targetRole");
  }
  if (contextScope !== undefined && !isPayloadContextScope(contextScope)) {
    throw invalidPayloadChannelSpec(
      toolName,
      "payloadChannelSpec.contextScope",
    );
  }
  if (targetContext !== undefined && !isPayloadTargetContext(targetContext)) {
    throw invalidPayloadChannelSpec(
      toolName,
      "payloadChannelSpec.targetContext",
    );
  }
  if (
    responseFormat !== undefined &&
    !isPayloadResponseFormat(responseFormat)
  ) {
    throw invalidPayloadChannelSpec(
      toolName,
      "payloadChannelSpec.responseFormat",
    );
  }
  if (promptHint !== undefined && typeof promptHint !== "string") {
    throw invalidPayloadChannelSpec(toolName, "payloadChannelSpec.promptHint");
  }
  if (stages !== undefined && (!Array.isArray(stages) || stages.length === 0)) {
    throw invalidPayloadChannelSpec(toolName, "payloadChannelSpec.stages");
  }
  if (!isSupportedGroundingWindow(groundingWindow)) {
    throw invalidPayloadChannelSpec(
      toolName,
      "payloadChannelSpec.groundingWindow",
    );
  }
  const currentTargetObservation = parseCurrentTargetObservation(
    toolName,
    requiresCurrentTargetObservation,
  );

  const parsedStages = Array.isArray(stages)
    ? parsePayloadChannelStages({
        toolName,
        toolParams: params,
        payloadParams,
        finalOutputParam: outputParam,
        stages,
        inheritedResponseFormat: responseFormat,
      })
    : undefined;

  const unknownParam = payloadParams.find(
    (paramName) => !(paramName in params),
  );
  if (unknownParam) {
    throw invalidPayloadChannelSpec(
      toolName,
      `payloadChannelSpec unknown param ${unknownParam}`,
    );
  }
  if (!(outputParam in params)) {
    throw invalidPayloadChannelSpec(
      toolName,
      `payloadChannelSpec outputParam ${outputParam}`,
    );
  }
  if (params[outputParam] !== "string") {
    throw invalidPayloadChannelSpec(
      toolName,
      `payloadChannelSpec outputParam ${outputParam} must be string`,
    );
  }
  if (payloadTargetParam !== undefined && !(payloadTargetParam in params)) {
    throw invalidPayloadChannelSpec(
      toolName,
      `payloadChannelSpec unknown targetParam ${payloadTargetParam}`,
    );
  }
  if (
    payloadTargetParam !== undefined &&
    payloadParams.includes(payloadTargetParam)
  ) {
    throw invalidPayloadChannelSpec(
      toolName,
      `payloadChannelSpec targetParam ${payloadTargetParam} must be a visible control param`,
    );
  }
  if (targetContext !== undefined && payloadTargetParam === undefined) {
    throw invalidPayloadChannelSpec(
      toolName,
      "payloadChannelSpec.targetContext requires targetParam",
    );
  }
  if (
    parsedStages?.some((stage) => stage.targetContext !== undefined) &&
    payloadTargetParam === undefined
  ) {
    throw invalidPayloadChannelSpec(
      toolName,
      "payloadChannelSpec stage targetContext requires targetParam",
    );
  }
  if (
    parsedStages &&
    parsedStages[parsedStages.length - 1]?.outputParam !== outputParam
  ) {
    throw invalidPayloadChannelSpec(
      toolName,
      `payloadChannelSpec final stage must materialize outputParam ${outputParam}`,
    );
  }
  if (
    currentTargetObservation !== undefined &&
    !(currentTargetObservation.targetParam in params)
  ) {
    throw invalidPayloadChannelSpec(
      toolName,
      `payloadChannelSpec requiresCurrentTargetObservation unknown targetParam ${currentTargetObservation.targetParam}`,
    );
  }

  const parsed: ToolPayloadChannelSpec = {
    params: [...payloadParams],
    outputParam,
    generationMode,
  };
  if (payloadTargetParam) {
    parsed.targetParam = payloadTargetParam;
  }
  if (isPayloadTargetRole(targetRole)) {
    parsed.targetRole = targetRole;
  }
  if (isPayloadContextScope(contextScope)) {
    parsed.contextScope = contextScope;
  }
  if (isPayloadTargetContext(targetContext)) {
    parsed.targetContext = targetContext;
  }
  if (isPayloadResponseFormat(responseFormat)) {
    parsed.responseFormat = responseFormat;
  }
  if (typeof promptHint === "string") {
    parsed.promptHint = promptHint;
  }
  if (parsedStages) {
    parsed.stages = parsedStages;
  }
  if (typeof groundingWindow === "number") {
    parsed.groundingWindow = groundingWindow;
  }
  if (currentTargetObservation) {
    parsed.requiresCurrentTargetObservation = currentTargetObservation;
  }
  return parsed;
}

function hasSupportedPayloadParameters(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  if (value.length === 0) return false;
  return value.every(
    (paramName) => typeof paramName === "string" && paramName.trim().length > 0,
  );
}

function parsePayloadTargetParam(
  toolName: string,
  value: unknown,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidPayloadChannelSpec(toolName, "payloadChannelSpec.targetParam");
  }
  return value.trim();
}

function isPayloadTargetRole(
  value: unknown,
): value is "payload_body" | "operation_target" {
  if (value === "payload_body") return true;
  return value === "operation_target";
}

function isSupportedGroundingWindow(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "number") return false;
  if (!Number.isInteger(value)) return false;
  return value >= 0;
}

function parseCurrentTargetObservation(
  toolName: string,
  raw: unknown,
): ToolPayloadChannelSpec["requiresCurrentTargetObservation"] {
  if (raw === undefined) return undefined;
  if (!isToolDefinitionRecordValue(raw)) {
    throw invalidCurrentTargetObservation(toolName);
  }
  if (typeof raw.targetParam !== "string") {
    throw invalidCurrentTargetObservation(toolName);
  }
  if (raw.targetParam.trim().length === 0) {
    throw invalidCurrentTargetObservation(toolName);
  }
  if (!isCurrentTargetContentRequirement(raw.contentRequirement)) {
    throw invalidCurrentTargetObservation(toolName);
  }
  return {
    targetParam: raw.targetParam,
    ...(raw.contentRequirement
      ? { contentRequirement: raw.contentRequirement }
      : {}),
  };
}

function isCurrentTargetContentRequirement(
  value: unknown,
): value is "any" | "full" | undefined {
  if (value === undefined) return true;
  if (value === "any") return true;
  return value === "full";
}

function invalidCurrentTargetObservation(toolName: string): Error {
  return invalidPayloadChannelSpec(
    toolName,
    "payloadChannelSpec.requiresCurrentTargetObservation",
  );
}
