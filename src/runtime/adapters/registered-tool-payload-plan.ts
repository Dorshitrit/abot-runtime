import { readFile, stat } from "node:fs/promises";

import type {
  ToolDefinition,
  ToolExecutionSharedState,
  ToolNormalInvocationInput,
  ToolNormalInvocationOperation,
  ToolPayloadChannelSpec,
  ToolPayloadChannelStageSpec,
} from "../../capabilities/tool-types.js";
import { TOOL_PAYLOAD_STAGE_LITERAL_OUTPUT_MAX_BYTES } from "../../capabilities/tool-types.js";
import { resolveRuntimeTargetPath } from "../capabilities/runtime-target-path.js";
import {
  WORKER_CAPABILITY_RELATED_ARTIFACT_CONTEXT_MAX_CHARS,
  WORKER_CAPABILITY_RELATED_ARTIFACT_CONTEXT_MAX_COUNT,
  type WorkerCapabilityPayloadRelatedArtifactContext,
} from "../orchestration/worker-capabilities/payload-contracts.js";
import type { WorkerSettledCapabilityResult } from "../orchestration/worker-capabilities/contracts.js";

export type RegisteredToolPayloadStage = Readonly<{
  outputParam: string;
  instructions: string;
  minBytes: number;
  maxBytes: number;
  contextScope?: ToolPayloadChannelSpec["contextScope"];
  targetContext?: ToolPayloadChannelSpec["targetContext"];
  responseFormat?: ToolPayloadChannelSpec["responseFormat"];
  targetLineBoundProperties: readonly string[];
  includeMaterializedParams: readonly string[];
  minBytesOverride?: NonNullable<
    ToolPayloadChannelStageSpec["minBytesOverride"]
  >;
  literalOutput?: NonNullable<ToolPayloadChannelStageSpec["literalOutput"]>;
}>;

export type RegisteredToolStagedPayloadPlan = Readonly<{
  publicInput: ToolNormalInvocationInput;
  payloadParams: readonly string[];
  outputParam: string;
  payloadMinBytes: number;
  targetParam?: string;
  groundingWindow: number;
  stages: readonly RegisteredToolPayloadStage[];
}>;

export type RegisteredToolPayloadContextPlan = Readonly<{
  contextScope: NonNullable<ToolPayloadChannelSpec["contextScope"]>;
  targetParam?: string;
}>;

export type RegisteredToolPayloadTargetContext = Readonly<{
  targetParam: string;
  targetPath: string;
  presentation: "bounded" | "full" | "full_numbered";
  content: string;
  sourceRange?: Readonly<{
    contextStartLine: number;
    contextEndLine: number;
    writableStartLine: number;
    writableEndLine: number;
    totalLines: number;
  }>;
}>;

export function deriveRegisteredToolPayloadContextPlan(
  definition: ToolDefinition,
  operation: ToolNormalInvocationOperation,
): RegisteredToolPayloadContextPlan | undefined {
  const spec = definition.payloadChannelSpec;
  if (
    !operation.payload ||
    !spec?.contextScope ||
    spec.outputParam !== operation.payload.param
  ) {
    return undefined;
  }
  return Object.freeze({
    contextScope: spec.contextScope,
    ...(spec.targetParam ? { targetParam: spec.targetParam } : {}),
  });
}

/**
 * Bridges only explicitly staged tool metadata into the ordinary invocation
 * contract. Single-stage operations deliberately remain on their established
 * raw-payload path.
 */
export function deriveRegisteredToolStagedPayloadPlan(
  definition: ToolDefinition,
  operation: ToolNormalInvocationOperation,
): RegisteredToolStagedPayloadPlan | undefined {
  const spec = definition.payloadChannelSpec;
  if (!spec?.stages || spec.stages.length < 2) {
    return undefined;
  }
  if (
    !operation.payload ||
    spec.outputParam !== operation.payload.param ||
    spec.stages.at(-1)?.outputParam !== operation.payload.param
  ) {
    throw new TypeError("staged_payload_contract_mismatch");
  }

  const stageOutputParams = new Set(
    spec.stages.map((stage) => stage.outputParam),
  );
  const publicProperties = Object.fromEntries(
    Object.entries(operation.input.properties).filter(
      ([name]) => !stageOutputParams.has(name),
    ),
  );
  const publicRequired = operation.input.required.filter(
    (name) => !stageOutputParams.has(name),
  );
  if (spec.targetParam && !Object.hasOwn(publicProperties, spec.targetParam)) {
    throw new TypeError("staged_payload_target_not_public");
  }

  const stages = spec.stages.map((stage, stageIndex) => {
    const isFinalPayload = stage.outputParam === operation.payload!.param;
    const inputProperty = operation.input.properties[stage.outputParam];
    const maxBytes = isFinalPayload
      ? operation.payload!.maxBytes
      : inputProperty?.type === "string" && "maxLength" in inputProperty
        ? inputProperty.maxLength
        : 0;
    const operationMinBytes = operation.payload!.minBytes ?? 0;
    const minBytes = isFinalPayload ? (stage.minBytes ?? operationMinBytes) : 0;
    const minBytesOverride = stage.minBytesOverride;
    const literalOutput = stage.literalOutput;
    const instructions =
      stage.promptHint?.trim() ||
      (isFinalPayload ? operation.payload!.instructions.trim() : "");
    const targetContext = stage.targetContext ?? spec.targetContext;
    const targetLineBoundProperties = Object.freeze([
      ...(stage.targetLineBoundProperties ?? []),
    ]);
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      !Number.isSafeInteger(minBytes) ||
      minBytes < 0 ||
      (isFinalPayload && minBytes < operationMinBytes) ||
      minBytes > maxBytes ||
      (!isFinalPayload &&
        (stage.minBytes !== undefined || minBytesOverride !== undefined)) ||
      (minBytesOverride !== undefined &&
        (!stage.includeMaterializedParams?.includes(
          minBytesOverride.materializedParam,
        ) ||
          !Number.isSafeInteger(minBytesOverride.minBytes) ||
          minBytesOverride.minBytes < 0 ||
          minBytesOverride.minBytes < operationMinBytes ||
          minBytesOverride.minBytes > maxBytes)) ||
      (literalOutput !== undefined &&
        !validRegisteredToolPayloadStageLiteralOutput({
          spec,
          stage,
          stageIndex,
          isFinalPayload,
          operationMinBytes,
          operationMaxBytes: operation.payload!.maxBytes,
        })) ||
      instructions.length === 0 ||
      (targetContext === "bounded" &&
        !validBoundedTargetContextStage(spec.stages!, stageIndex)) ||
      !validTargetLineBoundProperties({
        responseFormat: stage.responseFormat ?? spec.responseFormat,
        targetContext,
        properties: targetLineBoundProperties,
      })
    ) {
      throw new TypeError("staged_payload_stage_unsupported");
    }
    return Object.freeze({
      outputParam: stage.outputParam,
      instructions,
      minBytes,
      maxBytes,
      ...((stage.contextScope ?? spec.contextScope)
        ? { contextScope: stage.contextScope ?? spec.contextScope }
        : {}),
      ...(targetContext ? { targetContext } : {}),
      ...((stage.responseFormat ?? spec.responseFormat)
        ? {
            responseFormat: immutableSnapshot(
              stage.responseFormat ?? spec.responseFormat,
            ),
          }
        : {}),
      targetLineBoundProperties,
      includeMaterializedParams: Object.freeze([
        ...(stage.includeMaterializedParams ?? []),
      ]),
      ...(minBytesOverride
        ? { minBytesOverride: immutableSnapshot(minBytesOverride) }
        : {}),
      ...(literalOutput
        ? { literalOutput: immutableSnapshot(literalOutput) }
        : {}),
    });
  });

  return Object.freeze({
    publicInput: Object.freeze({
      type: "object" as const,
      additionalProperties: false as const,
      properties: Object.freeze(publicProperties),
      required: Object.freeze(publicRequired),
    }),
    payloadParams: Object.freeze([...stageOutputParams]),
    outputParam: operation.payload.param,
    payloadMinBytes: operation.payload.minBytes ?? 0,
    ...(spec.targetParam ? { targetParam: spec.targetParam } : {}),
    groundingWindow: spec.groundingWindow ?? 0,
    stages: Object.freeze(stages),
  });
}

export type RegisteredToolPayloadStageLiteralResolution =
  | Readonly<{ status: "not_matched" }>
  | Readonly<{ status: "matched"; body: string }>
  | Readonly<{ status: "invalid_dependency" }>;

/** Resolves one trusted manifest literal from one validated prior stage value. */
export function resolveRegisteredToolPayloadStageLiteralOutput(
  params: Readonly<{
    stage: RegisteredToolPayloadStage;
    materializedParams?: Readonly<Record<string, string>>;
  }>,
): RegisteredToolPayloadStageLiteralResolution {
  const literal = params.stage.literalOutput;
  if (!literal) {
    return Object.freeze({ status: "not_matched" as const });
  }
  const source = params.materializedParams?.[literal.when.materializedParam];
  if (typeof source !== "string") {
    return Object.freeze({ status: "invalid_dependency" as const });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return Object.freeze({ status: "invalid_dependency" as const });
  }
  if (!isPlainRecord(parsed)) {
    return Object.freeze({ status: "invalid_dependency" as const });
  }
  const value = parsed[literal.when.property];
  if (typeof value !== "string") {
    return Object.freeze({ status: "invalid_dependency" as const });
  }
  return value === literal.when.equals
    ? Object.freeze({ status: "matched" as const, body: literal.value })
    : Object.freeze({ status: "not_matched" as const });
}

/** Resolves one manifest-declared conditional minimum from prior stage data. */
export function resolveRegisteredToolPayloadStageMinBytes(
  params: Readonly<{
    stage: RegisteredToolPayloadStage;
    materializedParams?: Readonly<Record<string, string>>;
  }>,
): number | undefined {
  const override = params.stage.minBytesOverride;
  if (!override) return params.stage.minBytes;
  const source = params.materializedParams?.[override.materializedParam];
  if (typeof source !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return undefined;
  }
  if (!isPlainRecord(parsed)) return undefined;
  const value = parsed[override.property];
  if (typeof value !== "string") return undefined;
  return value === override.equals ? override.minBytes : params.stage.minBytes;
}

export async function resolveRegisteredToolPayloadTargetContext(params: {
  plan: RegisteredToolStagedPayloadPlan;
  stage: RegisteredToolPayloadStage;
  controls: Readonly<Record<string, unknown>>;
  sharedState: ToolExecutionSharedState;
  materializedParams?: Readonly<Record<string, string>>;
}): Promise<RegisteredToolPayloadTargetContext | undefined> {
  if (!params.stage.targetContext) {
    return undefined;
  }
  const targetParam = params.plan.targetParam;
  const rawTarget =
    targetParam && typeof params.controls[targetParam] === "string"
      ? params.controls[targetParam].trim()
      : "";
  if (!targetParam || rawTarget.length === 0) {
    return undefined;
  }

  let resolvedTarget: string;
  try {
    resolvedTarget = resolveRuntimeTargetPath(rawTarget, params.sharedState);
    const targetStat = await stat(resolvedTarget);
    if (!targetStat.isFile()) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  const rawContent = await readFile(resolvedTarget, "utf8");
  const presentation = params.stage.targetContext;
  if (presentation === "bounded") {
    return resolveBoundedTargetContext({
      plan: params.plan,
      stage: params.stage,
      targetParam,
      targetPath: rawTarget,
      rawContent,
      materializedParams: params.materializedParams,
    });
  }
  if (presentation !== "full" && presentation !== "full_numbered") {
    return undefined;
  }
  const content =
    presentation === "full_numbered"
      ? rawContent
          .split(/\r?\n/u)
          .map((line, index) => `${index + 1} | ${line}`)
          .join("\n")
      : rawContent;
  return Object.freeze({
    targetParam,
    targetPath: rawTarget,
    presentation,
    content,
  });
}

export async function resolveRegisteredToolPayloadRelatedArtifactContexts(params: {
  contextScope?: ToolPayloadChannelSpec["contextScope"];
  targetParam?: string;
  controls: Readonly<Record<string, unknown>>;
  sharedState: ToolExecutionSharedState;
  settledCapabilityResults: readonly WorkerSettledCapabilityResult[];
}): Promise<readonly WorkerCapabilityPayloadRelatedArtifactContext[]> {
  if (params.contextScope !== "target_with_artifacts") {
    return Object.freeze([]);
  }

  const currentTarget = resolveCurrentTarget(params);
  const resolvedTargets = new Set<string>();
  const artifacts: WorkerCapabilityPayloadRelatedArtifactContext[] = [];
  let totalCharacters = 0;

  for (const result of params.settledCapabilityResults) {
    if (result.outcome !== "succeeded") continue;
    for (const reference of result.references ?? []) {
      let resolvedTarget: string;
      try {
        resolvedTarget = resolveRuntimeTargetPath(
          reference.target,
          params.sharedState,
        );
      } catch {
        continue;
      }
      if (
        resolvedTarget === currentTarget ||
        resolvedTargets.has(resolvedTarget)
      ) {
        continue;
      }
      resolvedTargets.add(resolvedTarget);

      try {
        const targetStat = await stat(resolvedTarget);
        if (!targetStat.isFile()) continue;
        const content = await readFile(resolvedTarget, "utf8");
        if (
          content.length + totalCharacters >
          WORKER_CAPABILITY_RELATED_ARTIFACT_CONTEXT_MAX_CHARS
        ) {
          continue;
        }
        artifacts.push(
          Object.freeze({
            sourceExecutionId: result.executionId,
            targetPath: reference.target,
            presentation: "full" as const,
            content,
          }),
        );
        totalCharacters += content.length;
        if (
          artifacts.length >=
          WORKER_CAPABILITY_RELATED_ARTIFACT_CONTEXT_MAX_COUNT
        ) {
          return Object.freeze(artifacts);
        }
      } catch {
        continue;
      }
    }
  }
  return Object.freeze(artifacts);
}

function resolveCurrentTarget(params: {
  targetParam?: string;
  controls: Readonly<Record<string, unknown>>;
  sharedState: ToolExecutionSharedState;
}): string | undefined {
  const rawTarget = params.targetParam
    ? params.controls[params.targetParam]
    : undefined;
  if (typeof rawTarget !== "string" || rawTarget.trim().length === 0) {
    return undefined;
  }
  try {
    return resolveRuntimeTargetPath(rawTarget.trim(), params.sharedState);
  } catch {
    return undefined;
  }
}

function resolveBoundedTargetContext(params: {
  plan: RegisteredToolStagedPayloadPlan;
  stage: RegisteredToolPayloadStage;
  targetParam: string;
  targetPath: string;
  rawContent: string;
  materializedParams?: Readonly<Record<string, string>>;
}): RegisteredToolPayloadTargetContext | undefined {
  const stageIndex = params.plan.stages.indexOf(params.stage);
  const priorStages = params.plan.stages
    .slice(0, stageIndex)
    .filter(
      (stage) =>
        params.stage.includeMaterializedParams.includes(stage.outputParam) &&
        stage.targetLineBoundProperties.length > 0,
    );
  if (stageIndex < 1 || priorStages.length !== 1) {
    return undefined;
  }
  const sourceStage = priorStages[0]!;
  const materialized = params.materializedParams?.[sourceStage.outputParam];
  if (typeof materialized !== "string") {
    return undefined;
  }
  let selection: unknown;
  try {
    selection = JSON.parse(materialized);
  } catch {
    return undefined;
  }
  if (!isPlainRecord(selection)) {
    return undefined;
  }
  const lines = params.rawContent.split(/\r?\n/u);
  const bounds = sourceStage.targetLineBoundProperties.map(
    (property) => selection[property],
  );
  if (
    bounds.some(
      (value) =>
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > lines.length,
    )
  ) {
    return undefined;
  }
  const writableStartLine = Math.min(...(bounds as number[]));
  const writableEndLine = Math.max(...(bounds as number[]));
  const contextStartLine = Math.max(
    1,
    writableStartLine - params.plan.groundingWindow,
  );
  const contextEndLine = Math.min(
    lines.length,
    writableEndLine + params.plan.groundingWindow,
  );
  return Object.freeze({
    targetParam: params.targetParam,
    targetPath: params.targetPath,
    presentation: "bounded" as const,
    content: lines.slice(contextStartLine - 1, contextEndLine).join("\n"),
    sourceRange: Object.freeze({
      contextStartLine,
      contextEndLine,
      writableStartLine,
      writableEndLine,
      totalLines: lines.length,
    }),
  });
}

function validBoundedTargetContextStage(
  stages: readonly NonNullable<ToolPayloadChannelSpec["stages"]>[number][],
  stageIndex: number,
): boolean {
  const current = stages[stageIndex];
  const included = current?.includeMaterializedParams ?? [];
  const sources = stages
    .slice(0, stageIndex)
    .filter(
      (stage) =>
        included.includes(stage.outputParam) &&
        (stage.targetLineBoundProperties?.length ?? 0) > 0,
    );
  return sources.length === 1;
}

function validRegisteredToolPayloadStageLiteralOutput(params: {
  spec: ToolPayloadChannelSpec;
  stage: ToolPayloadChannelStageSpec;
  stageIndex: number;
  isFinalPayload: boolean;
  operationMinBytes: number;
  operationMaxBytes: number;
}): boolean {
  const literal = params.stage.literalOutput;
  if (!literal || !isPlainRecord(literal) || !isPlainRecord(literal.when)) {
    return false;
  }
  if (
    Object.keys(literal).length !== 2 ||
    Object.keys(literal).some((key) => !["when", "value"].includes(key)) ||
    Object.keys(literal.when).length !== 3 ||
    Object.keys(literal.when).some(
      (key) => !["materializedParam", "property", "equals"].includes(key),
    ) ||
    typeof literal.when.materializedParam !== "string" ||
    typeof literal.when.property !== "string" ||
    typeof literal.when.equals !== "string" ||
    typeof literal.value !== "string" ||
    !params.isFinalPayload ||
    params.stage.minBytesOverride !== undefined ||
    (params.stage.responseFormat ?? params.spec.responseFormat) !== undefined ||
    (params.stage.targetLineBoundProperties?.length ?? 0) !== 0 ||
    !params.stage.includeMaterializedParams?.includes(
      literal.when.materializedParam,
    )
  ) {
    return false;
  }
  const literalBytes = Buffer.byteLength(literal.value, "utf8");
  if (
    literalBytes < params.operationMinBytes ||
    literalBytes > params.operationMaxBytes ||
    literalBytes > TOOL_PAYLOAD_STAGE_LITERAL_OUTPUT_MAX_BYTES
  ) {
    return false;
  }
  const sources = params.spec
    .stages!.slice(0, params.stageIndex)
    .filter((stage) => stage.outputParam === literal.when.materializedParam);
  if (sources.length !== 1) return false;
  const responseFormat =
    sources[0]!.responseFormat ?? params.spec.responseFormat;
  return validPayloadStageStringConditionSchema(
    responseFormat,
    literal.when.property,
    literal.when.equals,
  );
}

function validPayloadStageStringConditionSchema(
  input: unknown,
  property: string,
  equals: string,
): boolean {
  if (!isPlainRecord(input) || input.type !== "object") return false;
  const properties = input.properties;
  const required = input.required;
  if (
    !isPlainRecord(properties) ||
    !Array.isArray(required) ||
    !required.includes(property)
  ) {
    return false;
  }
  const propertySchema = properties[property];
  return (
    isPlainRecord(propertySchema) &&
    propertySchema.type === "string" &&
    Array.isArray(propertySchema.enum) &&
    propertySchema.enum.length > 0 &&
    propertySchema.enum.every((value) => typeof value === "string") &&
    propertySchema.enum.includes(equals)
  );
}

export function materializeRegisteredToolPayloadStageResponseFormat(params: {
  stage: RegisteredToolPayloadStage;
  targetContext?: RegisteredToolPayloadTargetContext;
}): ToolPayloadChannelSpec["responseFormat"] | undefined {
  const responseFormat = params.stage.responseFormat;
  if (params.stage.targetLineBoundProperties.length === 0) {
    return responseFormat;
  }
  if (
    !responseFormat ||
    responseFormat === "json" ||
    params.targetContext?.presentation !== "full_numbered"
  ) {
    throw new TypeError("staged_payload_target_line_bound_unavailable");
  }
  const lineCount = targetLineCount(params.targetContext);
  const materialized = structuredClone(responseFormat);
  const properties = materialized.properties as Record<
    string,
    Record<string, unknown>
  >;
  for (const property of params.stage.targetLineBoundProperties) {
    properties[property] = {
      ...properties[property],
      maximum: lineCount,
    };
  }
  return deepFreeze(materialized);
}

export function validateRegisteredToolPayloadStageTargetLineBounds(params: {
  stage: RegisteredToolPayloadStage;
  targetContext?: RegisteredToolPayloadTargetContext;
  body: string;
}): boolean {
  if (params.stage.targetLineBoundProperties.length === 0) {
    return true;
  }
  if (params.targetContext?.presentation !== "full_numbered") {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(params.body);
  } catch {
    return false;
  }
  if (!isPlainRecord(parsed)) {
    return false;
  }
  const lineCount = targetLineCount(params.targetContext);
  return params.stage.targetLineBoundProperties.every((property) => {
    const value = parsed[property];
    return (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 1 &&
      value <= lineCount
    );
  });
}

function validTargetLineBoundProperties(params: {
  responseFormat?: ToolPayloadChannelSpec["responseFormat"];
  targetContext?: ToolPayloadChannelSpec["targetContext"];
  properties: readonly string[];
}): boolean {
  if (params.properties.length === 0) {
    return true;
  }
  if (
    params.targetContext !== "full_numbered" ||
    !params.responseFormat ||
    params.responseFormat === "json" ||
    new Set(params.properties).size !== params.properties.length
  ) {
    return false;
  }
  const schemaProperties = params.responseFormat.properties;
  return (
    isPlainRecord(schemaProperties) &&
    params.properties.every((property) => {
      const schema = schemaProperties[property];
      return (
        property.trim().length > 0 &&
        isPlainRecord(schema) &&
        schema.type === "integer"
      );
    })
  );
}

function targetLineCount(
  targetContext: RegisteredToolPayloadTargetContext,
): number {
  return targetContext.content.split("\n").length;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function immutableSnapshot<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}
