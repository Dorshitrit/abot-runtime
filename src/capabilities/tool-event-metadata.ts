import type {
  ToolActionSummary,
  ToolCall,
  ToolDefinition,
  ToolEventMetadata,
  ToolExecutionResult,
} from "./tool-types.js";

function safeTrim(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function truncate(value: string, maxLength = 500): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function compactMeta(value: ToolEventMetadata): ToolEventMetadata | undefined {
  const entries = Object.entries(value).filter(
    ([, item]) => item !== undefined,
  );
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries);
}

function readStringParam(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = safeTrim(params[key]);
  if (!value) {
    return undefined;
  }
  return truncate(value);
}

function readNumberParam(
  params: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readStringArrayParam(
  params: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = params[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => safeTrim(item))
    .filter((item) => item.length > 0)
    .map((item) => truncate(item));
  return strings.length > 0 ? strings : undefined;
}

function summarizeParamValue(value: unknown): unknown {
  if (typeof value === "string") {
    return `string(len=${value.length})`;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return `array(len=${value.length})`;
  }
  if (value && typeof value === "object") {
    return `object(keys=${Object.keys(value as Record<string, unknown>)
      .sort()
      .join(",")})`;
  }
  return String(value);
}

function summarizeParams(
  params: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const entries = Object.keys(params)
    .sort()
    .map((key) => [key, summarizeParamValue(params[key])] as const);
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries);
}

function uniqueActionTypes(
  actions: ToolActionSummary[] | undefined,
): string[] | undefined {
  if (!Array.isArray(actions) || actions.length === 0) {
    return undefined;
  }
  const types = [
    ...new Set(actions.map((action) => action.type).filter(Boolean)),
  ];
  return types.length > 0 ? types : undefined;
}

function uniqueTargets(
  actions: ToolActionSummary[] | undefined,
): string[] | undefined {
  if (!Array.isArray(actions) || actions.length === 0) {
    return undefined;
  }
  const targets = [
    ...new Set(
      actions
        .map((action) => safeTrim(action.target))
        .filter((target) => target.length > 0),
    ),
  ];
  return targets.length > 0 ? targets : undefined;
}

function buildDeclaredCallMeta(
  call: ToolCall,
  definition?: ToolDefinition,
): ToolEventMetadata | undefined {
  const projections = definition?.eventPresentation?.metadata;
  if (!projections) return undefined;
  const values = Object.fromEntries(
    Object.entries(projections).flatMap(([key, projection]) => {
      let value: unknown;
      switch (projection.kind) {
        case "string":
          value = readStringParam(call.params, projection.param);
          break;
        case "number":
          value = readNumberParam(call.params, projection.param);
          break;
        case "string_array":
          value = readStringArrayParam(call.params, projection.param);
          break;
        case "length":
          {
            const raw = call.params[projection.param];
            value = typeof raw === "string" ? raw.length : undefined;
          }
          break;
      }
      const resolved = value ?? projection.default;
      return resolved === undefined ? [] : [[key, resolved]];
    }),
  );
  return compactMeta(values);
}

export function buildToolLifecycleEventCopy(
  definition: ToolDefinition | undefined,
  phase: "started" | "completed" | "failed",
): Readonly<{ status: string; message: string }> | undefined {
  return definition?.eventPresentation?.lifecycle?.[phase];
}

function buildCallMeta(
  call: ToolCall,
  definition?: ToolDefinition,
): ToolEventMetadata | undefined {
  const declared = buildDeclaredCallMeta(call, definition);
  if (declared) return declared;
  const params = summarizeParams(call.params);
  return params ? { params } : undefined;
}

function buildResultMeta(
  result: ToolExecutionResult,
  actions: ToolActionSummary[],
): ToolEventMetadata | undefined {
  const data = result.data || {};
  const actionTypes = uniqueActionTypes(actions);
  const targets = uniqueTargets(actions);
  return compactMeta({
    ...(typeof result.exitCode === "number"
      ? { exitCode: result.exitCode }
      : {}),
    ...(typeof result.errorCode === "string" &&
    result.errorCode.trim().length > 0
      ? { errorCode: result.errorCode.trim() }
      : {}),
    ...(typeof data.hasData === "boolean" ? { hasData: data.hasData } : {}),
    ...(typeof data.itemCount === "number"
      ? { itemCount: data.itemCount }
      : {}),
    ...(typeof data.mutationEvidence === "boolean"
      ? { mutationEvidence: data.mutationEvidence }
      : {}),
    ...(typeof data.currentStateEvidence === "boolean"
      ? { currentStateEvidence: data.currentStateEvidence }
      : {}),
    ...(typeof data.stateAlreadySatisfied === "boolean"
      ? { stateAlreadySatisfied: data.stateAlreadySatisfied }
      : {}),
    ...(actionTypes ? { actionTypes } : {}),
    ...(targets ? { targets } : {}),
  });
}

export function buildToolCompletedEventActions(
  call: ToolCall,
  result: ToolExecutionResult,
  definition?: ToolDefinition,
): ToolActionSummary[] {
  const logicalTarget = safeTrim(buildCallMeta(call, definition)?.path);
  return (result.actions ?? []).map((action) => ({
    type: action.type,
    ...(logicalTarget ? { target: logicalTarget } : {}),
  }));
}

export function buildToolStartEventMetadata(
  call: ToolCall,
  definition?: ToolDefinition,
): ToolEventMetadata | undefined {
  return buildCallMeta(call, definition);
}

export function buildToolCompletedEventMetadata(
  call: ToolCall,
  result: ToolExecutionResult,
  definition?: ToolDefinition,
): ToolEventMetadata | undefined {
  const toolResultData = asPlainRecord(result.data?.eventMeta) || {};
  const actions = buildToolCompletedEventActions(call, result, definition);
  return compactMeta({
    ...(buildCallMeta(call, definition) || {}),
    ...toolResultData,
    ...(buildResultMeta(result, actions) || {}),
  });
}
