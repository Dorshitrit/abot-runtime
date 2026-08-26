import type {
  ToolCallAdapter,
  ToolCatalogGroup,
  ToolDefinition,
  ToolDevelopmentRole,
  ToolEventPresentation,
  ToolExecutionEffect,
  ToolModule,
  ToolModuleDeclaration,
  ToolPayloadChannelStageSpec,
} from "./tool-types.js";
import {
  isToolCatalogGroupId,
  TOOL_PAYLOAD_STAGE_LITERAL_OUTPUT_MAX_BYTES,
} from "./tool-types.js";
import {
  TOOL_NORMAL_INVOCATION_IDENTIFIER_MAX_LENGTH,
  TOOL_NORMAL_INVOCATION_PAYLOAD_MAX_BYTES,
} from "./normal-invocation/contracts.js";
import { projectNormalInvocationDefinition } from "./normal-invocation/definition-projection.js";
import {
  parseToolNormalInvocationContract,
  parseToolNormalInvocationForDefinition,
} from "./normal-invocation/validator.js";

const ROUTING_CAPABILITIES: readonly ToolDefinition["routingCapability"][] = [
  "filesystem_inspection",
  "filesystem_mutation",
  "semantic_lookup",
  "semantic_mutation",
  "web_lookup",
];

const DEVELOPMENT_ROLES: readonly ToolDevelopmentRole[] = [
  "inspect",
  "establish",
  "mutate",
  "verify",
  "auxiliary",
];

const EXECUTION_EFFECTS: readonly ToolExecutionEffect[] = [
  "read_only",
  "mutating",
  "mixed",
];

const EVENT_PROJECTION_KINDS = [
  "string",
  "number",
  "string_array",
  "length",
] as const;
const PAYLOAD_STAGE_CONDITION_VALUE_MAX_LENGTH = 256;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isRoutingCapability(
  value: unknown,
): value is ToolDefinition["routingCapability"] {
  return (
    typeof value === "string" &&
    ROUTING_CAPABILITIES.includes(value as ToolDefinition["routingCapability"])
  );
}

function isDevelopmentRole(value: unknown): value is ToolDevelopmentRole {
  return (
    typeof value === "string" &&
    DEVELOPMENT_ROLES.includes(value as ToolDevelopmentRole)
  );
}

function parseToolCatalogGroups(
  toolName: string,
  value: unknown,
): ToolCatalogGroup[] {
  if (value === undefined) return ["other"];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((group) => !isToolCatalogGroupId(group)) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`Invalid tool definition for ${toolName} (catalogGroups)`);
  }
  return [...(value as ToolCatalogGroup[])];
}

function isExecutionEffect(value: unknown): value is ToolExecutionEffect {
  return (
    typeof value === "string" &&
    EXECUTION_EFFECTS.includes(value as ToolExecutionEffect)
  );
}

function parseEventPresentation(
  toolName: string,
  raw: unknown,
): ToolEventPresentation | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw) || !isObject(raw.metadata)) {
    throw new Error(
      `Invalid tool definition for ${toolName} (eventPresentation)`,
    );
  }
  const metadata = Object.fromEntries(
    Object.entries(raw.metadata).map(([key, rawProjection]) => {
      if (!key.trim() || !isObject(rawProjection)) {
        throw new Error(
          `Invalid tool definition for ${toolName} (eventPresentation.metadata.${key})`,
        );
      }
      const param = rawProjection.param;
      const kind = rawProjection.kind;
      const fallback = rawProjection.default;
      if (
        typeof param !== "string" ||
        !param.trim() ||
        !EVENT_PROJECTION_KINDS.includes(
          kind as (typeof EVENT_PROJECTION_KINDS)[number],
        ) ||
        (fallback !== undefined &&
          typeof fallback !== "string" &&
          typeof fallback !== "number" &&
          typeof fallback !== "boolean")
      ) {
        throw new Error(
          `Invalid tool definition for ${toolName} (eventPresentation.metadata.${key})`,
        );
      }
      return [
        key,
        {
          param: param.trim(),
          kind: kind as (typeof EVENT_PROJECTION_KINDS)[number],
          ...(fallback !== undefined ? { default: fallback } : {}),
        },
      ];
    }),
  );
  const lifecycle = raw.lifecycle;
  if (lifecycle !== undefined && !isObject(lifecycle)) {
    throw new Error(
      `Invalid tool definition for ${toolName} (eventPresentation.lifecycle)`,
    );
  }
  const parsedLifecycle = isObject(lifecycle)
    ? Object.fromEntries(
        ["started", "completed", "failed"].flatMap((phase) => {
          const copy = lifecycle[phase];
          if (copy === undefined) return [];
          if (
            !isObject(copy) ||
            typeof copy.status !== "string" ||
            copy.status.trim().length === 0 ||
            typeof copy.message !== "string" ||
            copy.message.trim().length === 0
          ) {
            throw new Error(
              `Invalid tool definition for ${toolName} (eventPresentation.lifecycle.${phase})`,
            );
          }
          return [
            [
              phase,
              { status: copy.status.trim(), message: copy.message.trim() },
            ],
          ];
        }),
      )
    : undefined;
  return {
    metadata,
    ...(parsedLifecycle && Object.keys(parsedLifecycle).length > 0
      ? { lifecycle: parsedLifecycle }
      : {}),
  };
}

function parseParamsByCommand(
  toolName: string,
  raw: unknown,
): ToolDefinition["paramsByCommand"] {
  if (raw === undefined) {
    return undefined;
  }
  if (!isObject(raw)) {
    throw new Error(
      `Invalid tool definition for ${toolName} (paramsByCommand)`,
    );
  }
  const discriminator = raw.discriminator;
  const variants = raw.variants;
  if (typeof discriminator !== "string" || discriminator.trim().length === 0) {
    throw new Error(
      `Invalid tool definition for ${toolName} (paramsByCommand.discriminator)`,
    );
  }
  if (!isObject(variants)) {
    throw new Error(
      `Invalid tool definition for ${toolName} (paramsByCommand.variants)`,
    );
  }
  const parsedVariants: Record<string, Record<string, string>> = {};
  for (const [variantName, variantParams] of Object.entries(variants)) {
    if (!isObject(variantParams)) {
      throw new Error(
        `Invalid tool definition for ${toolName} (paramsByCommand.variants.${variantName})`,
      );
    }
    const parsedVariant: Record<string, string> = {};
    for (const [paramName, paramType] of Object.entries(variantParams)) {
      if (typeof paramType !== "string") {
        throw new Error(
          `Invalid tool definition for ${toolName} (paramsByCommand.variants.${variantName}.${paramName})`,
        );
      }
      parsedVariant[paramName] = paramType;
    }
    parsedVariants[variantName] = parsedVariant;
  }
  return { discriminator, variants: parsedVariants };
}

function parseRuntimePathBindings(
  toolName: string,
  raw: unknown,
): ToolDefinition["runtimePathBindings"] {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 32) {
    throw new Error(
      `Invalid tool definition for ${toolName} (runtimePathBindings)`,
    );
  }
  const identities = new Set<string>();
  return raw.map((value, index) => {
    if (
      !isObject(value) ||
      (Object.keys(value).length !== 3 && Object.keys(value).length !== 4) ||
      !Object.hasOwn(value, "operationId") ||
      !Object.hasOwn(value, "param") ||
      !Object.hasOwn(value, "base") ||
      Object.keys(value).some(
        (key) => !["operationId", "param", "base", "default"].includes(key),
      ) ||
      typeof value.operationId !== "string" ||
      value.operationId.trim().length === 0 ||
      typeof value.param !== "string" ||
      value.param.trim().length === 0 ||
      value.base !== "worker_working_directory" ||
      (value.default !== undefined && value.default !== ".")
    ) {
      throw new Error(
        `Invalid tool definition for ${toolName} (runtimePathBindings.${index})`,
      );
    }
    const operationId = value.operationId.trim();
    const param = value.param.trim();
    const identity = `${operationId}\u0000${param}`;
    if (identities.has(identity)) {
      throw new Error(
        `Invalid tool definition for ${toolName} (runtimePathBindings duplicate ${operationId}.${param})`,
      );
    }
    identities.add(identity);
    return Object.freeze({
      operationId,
      param,
      base: "worker_working_directory" as const,
      ...(value.default === "." ? { default: "." as const } : {}),
    });
  });
}

function parsePayloadChannelSpec(
  toolName: string,
  params: Record<string, string>,
  raw: unknown,
): ToolDefinition["payloadChannelSpec"] {
  if (raw === undefined) {
    return undefined;
  }
  if (!isObject(raw)) {
    throw new Error(
      `Invalid tool definition for ${toolName} (payloadChannelSpec)`,
    );
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

  if (
    !Array.isArray(payloadParams) ||
    payloadParams.length === 0 ||
    payloadParams.some(
      (paramName) =>
        typeof paramName !== "string" || paramName.trim().length === 0,
    )
  ) {
    throw new Error(
      `Invalid tool definition for ${toolName} (payloadChannelSpec.params)`,
    );
  }
  if (typeof outputParam !== "string" || outputParam.trim().length === 0) {
    throw new Error(
      `Invalid tool definition for ${toolName} (payloadChannelSpec.outputParam)`,
    );
  }
  if (generationMode !== "raw_text") {
    throw new Error(
      `Invalid tool definition for ${toolName} (payloadChannelSpec.generationMode)`,
    );
  }
  if (
    targetParam !== undefined &&
    (typeof targetParam !== "string" || targetParam.trim().length === 0)
  ) {
    throw new Error(
      `Invalid tool definition for ${toolName} (payloadChannelSpec.targetParam)`,
    );
  }
  if (
    targetRole !== undefined &&
    targetRole !== "payload_body" &&
    targetRole !== "operation_target"
  ) {
    throw new Error(
      `Invalid tool definition for ${toolName} (payloadChannelSpec.targetRole)`,
    );
  }
  if (
    contextScope !== undefined &&
    contextScope !== "standard" &&
    contextScope !== "target_only" &&
    contextScope !== "target_with_artifacts"
  ) {
    throw new Error(
      `Invalid tool definition for ${toolName} (payloadChannelSpec.contextScope)`,
    );
  }
  if (
    targetContext !== undefined &&
    targetContext !== "bounded" &&
    targetContext !== "full" &&
    targetContext !== "full_numbered"
  ) {
    throw new Error(
      `Invalid tool definition for ${toolName} (payloadChannelSpec.targetContext)`,
    );
  }
  if (
    responseFormat !== undefined &&
    responseFormat !== "json" &&
    !isObject(responseFormat)
  ) {
    throw new Error(
      `Invalid tool definition for ${toolName} (payloadChannelSpec.responseFormat)`,
    );
  }
  if (promptHint !== undefined && typeof promptHint !== "string") {
    throw new Error(
      `Invalid tool definition for ${toolName} (payloadChannelSpec.promptHint)`,
    );
  }
  if (stages !== undefined && (!Array.isArray(stages) || stages.length === 0)) {
    throw new Error(
      `Invalid tool definition for ${toolName} (payloadChannelSpec.stages)`,
    );
  }
  if (
    groundingWindow !== undefined &&
    (typeof groundingWindow !== "number" ||
      !Number.isInteger(groundingWindow) ||
      groundingWindow < 0)
  ) {
    throw new Error(
      `Invalid tool definition for ${toolName} (payloadChannelSpec.groundingWindow)`,
    );
  }
  if (
    requiresCurrentTargetObservation !== undefined &&
    (!isObject(requiresCurrentTargetObservation) ||
      typeof requiresCurrentTargetObservation.targetParam !== "string" ||
      requiresCurrentTargetObservation.targetParam.trim().length === 0 ||
      (requiresCurrentTargetObservation.contentRequirement !== undefined &&
        requiresCurrentTargetObservation.contentRequirement !== "any" &&
        requiresCurrentTargetObservation.contentRequirement !== "full"))
  ) {
    throw new Error(
      `Invalid tool definition for ${toolName} (payloadChannelSpec.requiresCurrentTargetObservation)`,
    );
  }
  const requiredCurrentTargetParam =
    isObject(requiresCurrentTargetObservation) &&
    typeof requiresCurrentTargetObservation.targetParam === "string"
      ? requiresCurrentTargetObservation.targetParam
      : undefined;
  const payloadTargetParam =
    typeof targetParam === "string" ? targetParam.trim() : undefined;
  const requiredCurrentTargetContent =
    isObject(requiresCurrentTargetObservation) &&
    (requiresCurrentTargetObservation.contentRequirement === "any" ||
      requiresCurrentTargetObservation.contentRequirement === "full")
      ? requiresCurrentTargetObservation.contentRequirement
      : undefined;
  const parsedStages: ToolPayloadChannelStageSpec[] | undefined = Array.isArray(
    stages,
  )
    ? stages.map((stage, index) => {
        if (!isObject(stage)) {
          throw new Error(
            `Invalid tool definition for ${toolName} (payloadChannelSpec.stages.${index})`,
          );
        }
        const stageOutputParam = stage.outputParam;
        const stageContextScope = stage.contextScope;
        const stageTargetContext = stage.targetContext;
        const stageResponseFormat = stage.responseFormat;
        const stageTargetLineBoundProperties = stage.targetLineBoundProperties;
        const stagePromptHint = stage.promptHint;
        const includeMaterializedParams = stage.includeMaterializedParams;
        const stageMinBytes = stage.minBytes;
        const stageMinBytesOverride = stage.minBytesOverride;
        const stageLiteralOutput = stage.literalOutput;
        if (
          typeof stageOutputParam !== "string" ||
          stageOutputParam.trim().length === 0 ||
          !payloadParams.includes(stageOutputParam) ||
          params[stageOutputParam] !== "string"
        ) {
          throw new Error(
            `Invalid tool definition for ${toolName} (payloadChannelSpec.stages.${index}.outputParam)`,
          );
        }
        if (
          stageContextScope !== undefined &&
          stageContextScope !== "standard" &&
          stageContextScope !== "target_only" &&
          stageContextScope !== "target_with_artifacts"
        ) {
          throw new Error(
            `Invalid tool definition for ${toolName} (payloadChannelSpec.stages.${index}.contextScope)`,
          );
        }
        if (
          stageTargetContext !== undefined &&
          stageTargetContext !== "bounded" &&
          stageTargetContext !== "full" &&
          stageTargetContext !== "full_numbered"
        ) {
          throw new Error(
            `Invalid tool definition for ${toolName} (payloadChannelSpec.stages.${index}.targetContext)`,
          );
        }
        if (
          stageResponseFormat !== undefined &&
          stageResponseFormat !== "json" &&
          !isObject(stageResponseFormat)
        ) {
          throw new Error(
            `Invalid tool definition for ${toolName} (payloadChannelSpec.stages.${index}.responseFormat)`,
          );
        }
        if (
          stageTargetLineBoundProperties !== undefined &&
          (!Array.isArray(stageTargetLineBoundProperties) ||
            stageTargetLineBoundProperties.length === 0 ||
            new Set(stageTargetLineBoundProperties).size !==
              stageTargetLineBoundProperties.length ||
            stageTargetLineBoundProperties.some(
              (property) =>
                typeof property !== "string" || property.trim().length === 0,
            ))
        ) {
          throw new Error(
            `Invalid tool definition for ${toolName} (payloadChannelSpec.stages.${index}.targetLineBoundProperties)`,
          );
        }
        if (
          stagePromptHint !== undefined &&
          typeof stagePromptHint !== "string"
        ) {
          throw new Error(
            `Invalid tool definition for ${toolName} (payloadChannelSpec.stages.${index}.promptHint)`,
          );
        }
        if (
          includeMaterializedParams !== undefined &&
          (!Array.isArray(includeMaterializedParams) ||
            includeMaterializedParams.some(
              (paramName) =>
                typeof paramName !== "string" ||
                !payloadParams.includes(paramName),
            ))
        ) {
          throw new Error(
            `Invalid tool definition for ${toolName} (payloadChannelSpec.stages.${index}.includeMaterializedParams)`,
          );
        }
        if (
          stageMinBytes !== undefined &&
          (typeof stageMinBytes !== "number" ||
            !Number.isSafeInteger(stageMinBytes) ||
            stageMinBytes < 0 ||
            stageMinBytes > TOOL_NORMAL_INVOCATION_PAYLOAD_MAX_BYTES)
        ) {
          throw new Error(
            `Invalid tool definition for ${toolName} (payloadChannelSpec.stages.${index}.minBytes)`,
          );
        }
        if (
          (stageMinBytes !== undefined ||
            stageMinBytesOverride !== undefined) &&
          stageOutputParam.trim() !== outputParam
        ) {
          throw new Error(
            `Invalid tool definition for ${toolName} (payloadChannelSpec.stages.${index} byte minimum must belong to the final payload stage)`,
          );
        }
        const priorStageOutputs = new Set(
          stages
            .slice(0, index)
            .filter(isObject)
            .map((priorStage) => priorStage.outputParam)
            .filter(
              (paramName): paramName is string => typeof paramName === "string",
            ),
        );
        if (
          Array.isArray(includeMaterializedParams) &&
          includeMaterializedParams.some(
            (paramName) => !priorStageOutputs.has(paramName),
          )
        ) {
          throw new Error(
            `Invalid tool definition for ${toolName} (payloadChannelSpec.stages.${index} references unavailable materialized params)`,
          );
        }
        const parsedMinBytesOverride =
          stageMinBytesOverride === undefined
            ? undefined
            : parsePayloadStageMinBytesOverride({
                toolName,
                stageIndex: index,
                input: stageMinBytesOverride,
                baseMinBytes: stageMinBytes,
                includeMaterializedParams,
                stages,
                inheritedResponseFormat: responseFormat,
              });
        const parsedLiteralOutput = parsePayloadStageLiteralOutput({
          toolName,
          stageIndex: index,
          input: stageLiteralOutput,
          stageOutputParam: stageOutputParam.trim(),
          finalOutputParam: outputParam,
          stageResponseFormat,
          inheritedResponseFormat: responseFormat,
          stageTargetLineBoundProperties,
          stageMinBytesOverride,
          includeMaterializedParams,
          stages,
        });
        return {
          outputParam: stageOutputParam.trim(),
          ...(stageContextScope === "standard" ||
          stageContextScope === "target_only" ||
          stageContextScope === "target_with_artifacts"
            ? { contextScope: stageContextScope }
            : {}),
          ...(stageTargetContext === "bounded" ||
          stageTargetContext === "full" ||
          stageTargetContext === "full_numbered"
            ? { targetContext: stageTargetContext }
            : {}),
          ...(stageResponseFormat === "json" || isObject(stageResponseFormat)
            ? { responseFormat: stageResponseFormat }
            : {}),
          ...(Array.isArray(stageTargetLineBoundProperties)
            ? {
                targetLineBoundProperties: [...stageTargetLineBoundProperties],
              }
            : {}),
          ...(typeof stagePromptHint === "string"
            ? { promptHint: stagePromptHint }
            : {}),
          ...(Array.isArray(includeMaterializedParams)
            ? { includeMaterializedParams: [...includeMaterializedParams] }
            : {}),
          ...(typeof stageMinBytes === "number"
            ? { minBytes: stageMinBytes }
            : {}),
          ...(parsedMinBytesOverride
            ? { minBytesOverride: parsedMinBytesOverride }
            : {}),
          ...(parsedLiteralOutput
            ? { literalOutput: parsedLiteralOutput }
            : {}),
        } as ToolPayloadChannelStageSpec;
      })
    : undefined;

  const unknownParam = payloadParams.find(
    (paramName) => !(paramName in params),
  );
  if (unknownParam) {
    throw new Error(
      `Invalid tool definition for ${toolName} (payloadChannelSpec unknown param ${unknownParam})`,
    );
  }
  if (!(outputParam in params)) {
    throw new Error(
      `Invalid tool definition for ${toolName} (payloadChannelSpec outputParam ${outputParam})`,
    );
  }
  if (params[outputParam] !== "string") {
    throw new Error(
      `Invalid tool definition for ${toolName} (payloadChannelSpec outputParam ${outputParam} must be string)`,
    );
  }
  if (payloadTargetParam !== undefined && !(payloadTargetParam in params)) {
    throw new Error(
      `Invalid tool definition for ${toolName} (payloadChannelSpec unknown targetParam ${payloadTargetParam})`,
    );
  }
  if (
    payloadTargetParam !== undefined &&
    payloadParams.includes(payloadTargetParam)
  ) {
    throw new Error(
      `Invalid tool definition for ${toolName} (payloadChannelSpec targetParam ${payloadTargetParam} must be a visible control param)`,
    );
  }
  if (targetContext !== undefined && payloadTargetParam === undefined) {
    throw new Error(
      `Invalid tool definition for ${toolName} (payloadChannelSpec.targetContext requires targetParam)`,
    );
  }
  if (
    parsedStages?.some((stage) => stage.targetContext !== undefined) &&
    payloadTargetParam === undefined
  ) {
    throw new Error(
      `Invalid tool definition for ${toolName} (payloadChannelSpec stage targetContext requires targetParam)`,
    );
  }
  if (
    parsedStages &&
    parsedStages[parsedStages.length - 1]?.outputParam !== outputParam
  ) {
    throw new Error(
      `Invalid tool definition for ${toolName} (payloadChannelSpec final stage must materialize outputParam ${outputParam})`,
    );
  }
  if (
    requiredCurrentTargetParam !== undefined &&
    !(requiredCurrentTargetParam in params)
  ) {
    throw new Error(
      `Invalid tool definition for ${toolName} (payloadChannelSpec requiresCurrentTargetObservation unknown targetParam ${requiredCurrentTargetParam})`,
    );
  }

  return {
    params: [...payloadParams],
    outputParam,
    generationMode,
    ...(payloadTargetParam ? { targetParam: payloadTargetParam } : {}),
    ...(targetRole === "payload_body" || targetRole === "operation_target"
      ? { targetRole }
      : {}),
    ...(contextScope === "standard" ||
    contextScope === "target_only" ||
    contextScope === "target_with_artifacts"
      ? { contextScope }
      : {}),
    ...(targetContext === "bounded" ||
    targetContext === "full" ||
    targetContext === "full_numbered"
      ? { targetContext }
      : {}),
    ...(responseFormat === "json" || isObject(responseFormat)
      ? { responseFormat }
      : {}),
    ...(typeof promptHint === "string" ? { promptHint } : {}),
    ...(parsedStages ? { stages: parsedStages } : {}),
    ...(typeof groundingWindow === "number" ? { groundingWindow } : {}),
    ...(requiredCurrentTargetParam
      ? {
          requiresCurrentTargetObservation: {
            targetParam: requiredCurrentTargetParam,
            ...(requiredCurrentTargetContent
              ? { contentRequirement: requiredCurrentTargetContent }
              : {}),
          },
        }
      : {}),
  };
}

function parsePayloadStageMinBytesOverride(
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
  if (
    typeof params.baseMinBytes !== "number" ||
    !isObject(input) ||
    Object.keys(input).length !== 4 ||
    Object.keys(input).some(
      (key) =>
        !["materializedParam", "property", "equals", "minBytes"].includes(key),
    ) ||
    typeof input.materializedParam !== "string" ||
    input.materializedParam.length === 0 ||
    input.materializedParam.length >
      TOOL_NORMAL_INVOCATION_IDENTIFIER_MAX_LENGTH ||
    typeof input.property !== "string" ||
    input.property.length === 0 ||
    input.property.length > TOOL_NORMAL_INVOCATION_IDENTIFIER_MAX_LENGTH ||
    typeof input.equals !== "string" ||
    input.equals.length === 0 ||
    input.equals.length > PAYLOAD_STAGE_CONDITION_VALUE_MAX_LENGTH ||
    typeof input.minBytes !== "number" ||
    !Number.isSafeInteger(input.minBytes) ||
    input.minBytes < 0 ||
    input.minBytes > TOOL_NORMAL_INVOCATION_PAYLOAD_MAX_BYTES ||
    !Array.isArray(params.includeMaterializedParams) ||
    !params.includeMaterializedParams.includes(input.materializedParam)
  ) {
    throw new Error(`Invalid tool definition for ${params.toolName} (${path})`);
  }

  const materializedParam = input.materializedParam;
  const property = input.property;
  const equals = input.equals;
  const overrideMinBytes = input.minBytes;
  const sourceStages: Record<string, unknown>[] = [];
  for (const stage of params.stages.slice(0, params.stageIndex)) {
    if (isObject(stage) && stage.outputParam === materializedParam) {
      sourceStages.push(stage);
    }
  }
  if (sourceStages.length !== 1) {
    throw new Error(
      `Invalid tool definition for ${params.toolName} (${path} source)`,
    );
  }
  const source = sourceStages[0]!;
  const responseFormat =
    source.responseFormat ?? params.inheritedResponseFormat;
  if (
    !validPayloadStageStringConditionSchema(responseFormat, property, equals)
  ) {
    throw new Error(
      `Invalid tool definition for ${params.toolName} (${path} schema)`,
    );
  }
  return {
    materializedParam,
    property,
    equals,
    minBytes: overrideMinBytes,
  };
}

function parsePayloadStageLiteralOutput(
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
  if (
    !isObject(input) ||
    Object.keys(input).length !== 2 ||
    Object.keys(input).some((key) => !["when", "value"].includes(key)) ||
    !isObject(input.when) ||
    Object.keys(input.when).length !== 3 ||
    Object.keys(input.when).some(
      (key) => !["materializedParam", "property", "equals"].includes(key),
    ) ||
    typeof input.when.materializedParam !== "string" ||
    input.when.materializedParam.trim().length === 0 ||
    input.when.materializedParam.length >
      TOOL_NORMAL_INVOCATION_IDENTIFIER_MAX_LENGTH ||
    typeof input.when.property !== "string" ||
    input.when.property.trim().length === 0 ||
    input.when.property.length > TOOL_NORMAL_INVOCATION_IDENTIFIER_MAX_LENGTH ||
    typeof input.when.equals !== "string" ||
    input.when.equals.length === 0 ||
    input.when.equals.length > PAYLOAD_STAGE_CONDITION_VALUE_MAX_LENGTH ||
    typeof input.value !== "string" ||
    Buffer.byteLength(input.value, "utf8") >
      TOOL_PAYLOAD_STAGE_LITERAL_OUTPUT_MAX_BYTES ||
    params.stageOutputParam !== params.finalOutputParam ||
    params.stageResponseFormat !== undefined ||
    params.inheritedResponseFormat !== undefined ||
    params.stageTargetLineBoundProperties !== undefined ||
    params.stageMinBytesOverride !== undefined ||
    !Array.isArray(params.includeMaterializedParams) ||
    !params.includeMaterializedParams.includes(input.when.materializedParam)
  ) {
    throw new Error(`Invalid tool definition for ${params.toolName} (${path})`);
  }

  const sourceStages: Record<string, unknown>[] = [];
  for (const stage of params.stages.slice(0, params.stageIndex)) {
    if (isObject(stage) && stage.outputParam === input.when.materializedParam) {
      sourceStages.push(stage);
    }
  }
  if (sourceStages.length !== 1) {
    throw new Error(
      `Invalid tool definition for ${params.toolName} (${path} source)`,
    );
  }
  const source = sourceStages[0]!;
  const sourceResponseFormat =
    source.responseFormat ?? params.inheritedResponseFormat;
  if (
    !validPayloadStageStringConditionSchema(
      sourceResponseFormat,
      input.when.property,
      input.when.equals,
    )
  ) {
    throw new Error(
      `Invalid tool definition for ${params.toolName} (${path} schema)`,
    );
  }

  return {
    when: {
      materializedParam: input.when.materializedParam,
      property: input.when.property,
      equals: input.when.equals,
    },
    value: input.value,
  };
}

function validPayloadStageStringConditionSchema(
  input: unknown,
  property: string,
  equals: string,
): boolean {
  if (!isObject(input) || input.type !== "object") return false;
  const properties = input.properties;
  const required = input.required;
  if (
    !isObject(properties) ||
    !Array.isArray(required) ||
    !required.includes(property)
  ) {
    return false;
  }
  const propertySchema = properties[property];
  return (
    isObject(propertySchema) &&
    propertySchema.type === "string" &&
    Array.isArray(propertySchema.enum) &&
    propertySchema.enum.length > 0 &&
    propertySchema.enum.every((value) => typeof value === "string") &&
    propertySchema.enum.includes(equals)
  );
}

export function parseToolDefinition(raw: unknown): ToolDefinition {
  if (!isObject(raw)) {
    throw new Error("Invalid tool definition entry (not an object)");
  }

  const name = raw.name;
  const description = raw.description;
  const routingCapability = raw.routingCapability;
  const controlsRefinement = raw.controlsRefinement;
  const catalogGroups = raw.catalogGroups;
  const executionEffect = raw.executionEffect;
  const developmentRoles = raw.developmentRoles;
  const eventPresentation = raw.eventPresentation;
  const params = raw.params;

  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error("Invalid tool definition entry (name)");
  }
  if (description !== undefined && typeof description !== "string") {
    throw new Error(`Invalid tool definition for ${name} (description)`);
  }
  if (!isRoutingCapability(routingCapability)) {
    throw new Error(`Invalid tool definition for ${name} (routingCapability)`);
  }
  if (
    controlsRefinement !== undefined &&
    controlsRefinement !== "mechanical_when_complete"
  ) {
    throw new Error(`Invalid tool definition for ${name} (controlsRefinement)`);
  }
  if (executionEffect !== undefined && !isExecutionEffect(executionEffect)) {
    throw new Error(`Invalid tool definition for ${name} (executionEffect)`);
  }
  if (!isObject(params)) {
    throw new Error(`Invalid tool definition for ${name} (params)`);
  }
  if (
    developmentRoles !== undefined &&
    (!Array.isArray(developmentRoles) ||
      developmentRoles.some((role) => !isDevelopmentRole(role)))
  ) {
    throw new Error(`Invalid tool definition for ${name} (developmentRoles)`);
  }
  for (const [paramName, paramType] of Object.entries(params)) {
    if (typeof paramType !== "string") {
      throw new Error(
        `Invalid tool definition for ${name} (param type for ${paramName})`,
      );
    }
  }

  const paramsByCommand = parseParamsByCommand(name, raw.paramsByCommand);
  const runtimePathBindings = parseRuntimePathBindings(
    name,
    raw.runtimePathBindings,
  );
  const payloadChannelSpec = parsePayloadChannelSpec(
    name,
    params as Record<string, string>,
    raw.payloadChannelSpec,
  );
  const parsedEventPresentation = parseEventPresentation(
    name,
    eventPresentation,
  );

  return {
    name,
    ...(typeof description === "string" ? { description } : {}),
    routingCapability,
    ...(controlsRefinement === "mechanical_when_complete"
      ? { controlsRefinement }
      : {}),
    catalogGroups: parseToolCatalogGroups(name, catalogGroups),
    ...(executionEffect ? { executionEffect } : {}),
    ...(Array.isArray(developmentRoles)
      ? { developmentRoles: [...developmentRoles] }
      : {}),
    ...(parsedEventPresentation
      ? { eventPresentation: parsedEventPresentation }
      : {}),
    params: params as Record<string, string>,
    ...(paramsByCommand ? { paramsByCommand } : {}),
    ...(payloadChannelSpec ? { payloadChannelSpec } : {}),
    ...(runtimePathBindings ? { runtimePathBindings } : {}),
  };
}

function parseToolAdapter(
  toolName: string,
  raw: unknown,
): ToolCallAdapter | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isObject(raw)) {
    throw new Error(`Invalid tool module for ${toolName} (adapter)`);
  }
  const normalizeCall = raw.normalizeCall;
  const validateCall = raw.validateCall;
  if (normalizeCall !== undefined && typeof normalizeCall !== "function") {
    throw new Error(
      `Invalid tool module for ${toolName} (adapter.normalizeCall)`,
    );
  }
  if (validateCall !== undefined && typeof validateCall !== "function") {
    throw new Error(
      `Invalid tool module for ${toolName} (adapter.validateCall)`,
    );
  }
  const adapter: ToolCallAdapter = {};
  if (typeof normalizeCall === "function") {
    adapter.normalizeCall = normalizeCall as ToolCallAdapter["normalizeCall"];
  }
  if (typeof validateCall === "function") {
    adapter.validateCall = validateCall as ToolCallAdapter["validateCall"];
  }
  return adapter;
}

export function buildToolRegistry(
  modules: readonly ToolModuleDeclaration[],
): ToolModule[] {
  if (!Array.isArray(modules)) {
    throw new Error("Tool registry modules must be an array");
  }

  const seenNames = new Set<string>();
  return modules.map((module, index) => {
    if (!module || typeof module !== "object") {
      throw new Error(`Invalid tool module entry at index ${index}`);
    }
    const rawDefinition = module.definition as unknown;
    const toolName = readToolDefinitionName(rawDefinition);
    const parsedNormalInvocation = parseToolNormalInvocationContract(
      toolName,
      module.normalInvocation,
    );
    if (!parsedNormalInvocation) {
      throw new Error(
        `Invalid tool module for ${toolName} (normalInvocation is required)`,
      );
    }
    const definition = parseToolDefinition(
      projectCanonicalDefinition({
        toolName,
        rawDefinition,
        normalInvocation: parsedNormalInvocation,
      }),
    );
    if (seenNames.has(definition.name)) {
      throw new Error(`Duplicate tool definition: ${definition.name}`);
    }
    seenNames.add(definition.name);
    if (typeof module.implementation !== "function") {
      throw new Error(
        `Invalid tool module for ${definition.name} (implementation)`,
      );
    }
    const adapter = parseToolAdapter(definition.name, module.adapter);
    const normalInvocation = parseToolNormalInvocationForDefinition(
      definition,
      parsedNormalInvocation,
    );
    return {
      definition,
      implementation: module.implementation,
      ...(adapter ? { adapter } : {}),
      normalInvocation: normalInvocation!,
    };
  });
}

export function validateToolModuleDeclarations(
  modules: readonly ToolModuleDeclaration[],
): ToolModuleDeclaration[] {
  const resolved = buildToolRegistry(modules);
  return resolved.map((tool, index) => {
    const source = modules[index]!;
    const {
      params: _projectedParams,
      executionEffect: _projectedEffect,
      ...definition
    } = tool.definition;
    void _projectedParams;
    void _projectedEffect;
    return {
      definition,
      implementation: tool.implementation,
      ...(tool.adapter ? { adapter: tool.adapter } : {}),
      normalInvocation: tool.normalInvocation,
    };
  });
}

function readToolDefinitionName(raw: unknown): string {
  if (!isObject(raw)) {
    throw new Error("Invalid tool definition entry (not an object)");
  }
  if (typeof raw.name !== "string" || raw.name.trim().length === 0) {
    throw new Error("Invalid tool definition entry (name)");
  }
  return raw.name;
}

function projectCanonicalDefinition(params: {
  toolName: string;
  rawDefinition: unknown;
  normalInvocation: NonNullable<ToolModule["normalInvocation"]>;
}): Record<string, unknown> {
  if (!isObject(params.rawDefinition)) {
    throw new Error("Invalid tool definition entry (not an object)");
  }
  if (params.rawDefinition.params !== undefined) {
    throw new Error(
      `Invalid tool definition for ${params.toolName} (params must be omitted when normalInvocation is canonical)`,
    );
  }
  if (params.rawDefinition.executionEffect !== undefined) {
    throw new Error(
      `Invalid tool definition for ${params.toolName} (executionEffect must be omitted when normalInvocation is canonical)`,
    );
  }
  const projection = projectNormalInvocationDefinition({
    toolName: params.toolName,
    contract: params.normalInvocation,
  });
  return {
    ...params.rawDefinition,
    params: { ...projection.params },
    executionEffect: projection.executionEffect,
  };
}
