export type PluginParameterErrorCode =
  | "plugin_parameter_required"
  | "plugin_parameter_invalid";

export class PluginParameterError extends TypeError {
  readonly code: PluginParameterErrorCode;
  readonly parameter: string;

  constructor(params: {
    code: PluginParameterErrorCode;
    parameter: string;
    message?: string;
  }) {
    super(params.message ?? `${params.parameter}: ${params.code}`);
    this.name = "PluginParameterError";
    this.code = params.code;
    this.parameter = params.parameter;
  }
}

export function isPluginParameterError(
  error: unknown,
): error is PluginParameterError {
  return error instanceof PluginParameterError;
}

export type StringParameterOptions = Readonly<{
  name?: string;
  parameter?: string;
  trim?: boolean;
  minLength?: number;
  maxLength?: number;
}>;

type StringParameterInput = string | StringParameterOptions;

function stringOptions(input: StringParameterInput): StringParameterOptions {
  return typeof input === "string" ? { name: input } : input;
}

function parameterName(options: { name?: string; parameter?: string }): string {
  return options.name ?? options.parameter ?? "value";
}

function parseString(
  value: unknown,
  options: StringParameterOptions,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  const parameter = parameterName(options);
  if (typeof value !== "string") {
    throw new PluginParameterError({
      code: "plugin_parameter_invalid",
      parameter,
    });
  }
  const parsed = options.trim === false ? value : value.trim();
  if (
    (options.minLength !== undefined && parsed.length < options.minLength) ||
    (options.maxLength !== undefined && parsed.length > options.maxLength)
  ) {
    throw new PluginParameterError({
      code: "plugin_parameter_invalid",
      parameter,
    });
  }
  return parsed;
}

export function readOptionalString(
  value: unknown,
  input: StringParameterInput = {},
): string | undefined {
  return parseString(value, stringOptions(input));
}

export function readRequiredString(
  value: unknown,
  input: StringParameterInput = {},
): string {
  const options = stringOptions(input);
  const parameter = parameterName(options);
  const parsed = parseString(value, {
    ...options,
    minLength: Math.max(options.minLength ?? 1, 1),
  });
  if (parsed === undefined) {
    throw new PluginParameterError({
      code: "plugin_parameter_required",
      parameter,
    });
  }
  return parsed;
}

export function readBoundedInteger(
  value: unknown,
  options: Readonly<{
    name?: string;
    parameter?: string;
    minimum: number;
    maximum: number;
    defaultValue?: number;
  }>,
): number {
  const parameter = parameterName(options);
  const candidate = value === undefined ? options.defaultValue : value;
  if (
    !Number.isSafeInteger(candidate) ||
    (candidate as number) < options.minimum ||
    (candidate as number) > options.maximum
  ) {
    throw new PluginParameterError({
      code:
        candidate === undefined
          ? "plugin_parameter_required"
          : "plugin_parameter_invalid",
      parameter,
    });
  }
  return candidate as number;
}

export function readBoolean(
  value: unknown,
  options: Readonly<{
    name?: string;
    parameter?: string;
    defaultValue?: boolean;
  }> = {},
): boolean {
  const parameter = parameterName(options);
  const candidate = value === undefined ? options.defaultValue : value;
  if (typeof candidate !== "boolean") {
    throw new PluginParameterError({
      code:
        candidate === undefined
          ? "plugin_parameter_required"
          : "plugin_parameter_invalid",
      parameter,
    });
  }
  return candidate;
}

export function readStringArray(
  value: unknown,
  options: Readonly<{
    name?: string;
    parameter?: string;
    defaultValue?: readonly string[];
    minItems?: number;
    maxItems?: number;
    maxItemLength?: number;
    trim?: boolean;
    unique?: boolean;
  }> = {},
): readonly string[] {
  const parameter = parameterName(options);
  const candidate = value === undefined ? options.defaultValue : value;
  if (!Array.isArray(candidate)) {
    throw new PluginParameterError({
      code:
        candidate === undefined
          ? "plugin_parameter_required"
          : "plugin_parameter_invalid",
      parameter,
    });
  }
  if (
    (options.minItems !== undefined && candidate.length < options.minItems) ||
    (options.maxItems !== undefined && candidate.length > options.maxItems)
  ) {
    throw new PluginParameterError({
      code: "plugin_parameter_invalid",
      parameter,
    });
  }
  const parsed = candidate.map((entry) => {
    if (typeof entry !== "string") {
      throw new PluginParameterError({
        code: "plugin_parameter_invalid",
        parameter,
      });
    }
    const item = options.trim === false ? entry : entry.trim();
    if (
      item.length === 0 ||
      (options.maxItemLength !== undefined &&
        item.length > options.maxItemLength)
    ) {
      throw new PluginParameterError({
        code: "plugin_parameter_invalid",
        parameter,
      });
    }
    return item;
  });
  return Object.freeze(
    options.unique === false ? parsed : [...new Set(parsed)],
  );
}
