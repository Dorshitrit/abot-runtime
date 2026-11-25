import { hasExactKeys, isPlainObject } from "./contract-fields.js";
import { TOOL_NORMAL_INVOCATION_INPUT_MAX_PROPERTIES, type ToolNormalInvocationInput } from "./contracts.js";

export type ToolInputPropertyMode = Readonly<{
  propertyNames: Readonly<{ enum: readonly string[] }>;
}>;
export type ToolInputPropertyModes = readonly ToolInputPropertyMode[];

type PropertyModesNormalization =
  | Readonly<{ ok: true; value?: ToolInputPropertyModes }>
  | Readonly<{ ok: false; issue: string }>;

/** A bounded standard-JSON-Schema relation over the existing flat inputs. */
export function normalizeToolInputPropertyModes(
  raw: unknown,
  propertyNames: readonly string[],
  required: readonly string[],
): PropertyModesNormalization {
  if (raw === undefined) return { ok: true };
  if (!Array.isArray(raw) || raw.length === 0 ||
      raw.length > TOOL_NORMAL_INVOCATION_INPUT_MAX_PROPERTIES) {
    return { ok: false, issue: "expected a bounded non-empty array of property-name modes" };
  }
  const declared = new Set(propertyNames);
  const covered = new Set<string>();
  const signatures = new Set<string>();
  const modes: ToolInputPropertyMode[] = [];
  for (const mode of raw) {
    if (!isPlainObject(mode) || !hasExactKeys(mode, ["propertyNames"]) ||
        !isPlainObject(mode.propertyNames) || !hasExactKeys(mode.propertyNames, ["enum"]) ||
        !Array.isArray(mode.propertyNames.enum)) {
      return { ok: false, issue: "each mode must contain exactly propertyNames.enum" };
    }
    const names = mode.propertyNames.enum;
    if (names.length === 0 || names.length > declared.size ||
        names.some((name) => typeof name !== "string" || !declared.has(name)) ||
        new Set(names).size !== names.length) {
      return { ok: false, issue: "each mode must contain unique declared property names" };
    }
    const allowed = new Set<string>(names);
    if (required.some((name) => !allowed.has(name))) {
      return { ok: false, issue: "each mode must include every required property" };
    }
    const signature = JSON.stringify([...allowed].sort());
    if (signatures.has(signature)) return { ok: false, issue: "property-name modes must be unique" };
    signatures.add(signature);
    for (const name of allowed) covered.add(name);
    modes.push(freezeMode(names));
  }
  if (propertyNames.some((name) => !covered.has(name))) {
    return { ok: false, issue: "property-name modes must cover every declared property" };
  }
  return { ok: true, value: Object.freeze(modes) };
}

/** The caller retains responsibility for scalar values and required properties. */
export function matchesToolInputPropertyModes(
  modes: ToolInputPropertyModes | undefined,
  suppliedNames: readonly string[],
): boolean {
  return modes === undefined || modes.some((mode) =>
    suppliedNames.every((name) => mode.propertyNames.enum.includes(name)));
}

/** Preserve the relation when controls are split; the merged input is revalidated. */
export function projectToolInputPropertyModes(
  modes: ToolInputPropertyModes | undefined,
  propertyNames: readonly string[],
): ToolInputPropertyModes | undefined {
  if (modes === undefined || propertyNames.length === 0) return undefined;
  const projected = modes.map((mode) => propertyNames.filter((name) =>
    mode.propertyNames.enum.includes(name)));
  if (projected.some((names) => names.length === propertyNames.length)) return undefined;
  const retained = projected.filter((names, index) => !projected.some((other, otherIndex) =>
    otherIndex !== index && names.every((name) => other.includes(name)) &&
    (other.length > names.length || otherIndex < index)));
  return Object.freeze(retained.map(freezeMode));
}

/** Select public inputs without losing their declared co-occurrence relation. */
export function projectToolNormalInvocationInput(
  input: ToolNormalInvocationInput,
  propertyNames: readonly string[],
): ToolNormalInvocationInput {
  const selected = new Set(propertyNames);
  const properties = Object.fromEntries(Object.entries(input.properties)
    .filter(([name]) => selected.has(name)));
  const modes = projectToolInputPropertyModes(input.anyOf, Object.keys(properties));
  return Object.freeze({
    type: "object" as const,
    additionalProperties: false as const,
    properties: Object.freeze(properties),
    required: Object.freeze(input.required.filter((name) => selected.has(name))),
    ...(modes ? { anyOf: modes } : {}),
  });
}

function freezeMode(names: readonly string[]): ToolInputPropertyMode {
  return Object.freeze({ propertyNames: Object.freeze({ enum: Object.freeze([...names]) }) });
}
