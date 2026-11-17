/** Canonical model controls. Provider wire names never enter saved controls. */
export type ModelParameterKey =
  | "temperature" | "top_p" | "top_k" | "min_p" | "max_output_tokens"
  | "repeat_penalty" | "reasoning_effort" | "thinking_budget" | "seed";

export type ModelParameterValue = number | string | boolean;
export type ModelParameterControl = Readonly<
  | { mode: "omit" }
  | { mode: "inherit" }
  | { mode: "value"; value: ModelParameterValue }
>;
export type ModelParameterControls = Partial<Record<ModelParameterKey, ModelParameterControl>>;
export type ModelParameterDiagnostic = Readonly<{ code: string; profileId?: string; key?: ModelParameterKey; message: string }>;
export type ModelParameterProfileDiagnostic = ModelParameterDiagnostic;
export type ModelParameterConstraint = Readonly<{
  supported?: boolean;
  min?: number;
  max?: number;
  values?: readonly ModelParameterValue[];
  requires?: Readonly<{ key: ModelParameterKey; values: readonly ModelParameterValue[]; allowMissing?: boolean }>;
}>;
export type ModelParameterProfile = Readonly<{
  schemaVersion: 1;
  id: string;
  priority?: number;
  match: readonly Readonly<{ provider?: string; kind: "exact" | "glob" | "regex"; pattern: string }>[];
  defaults?: Partial<Record<ModelParameterKey, ModelParameterValue>>;
  reasoning?: Readonly<{
    efforts: readonly string[];
    mappings?: Readonly<Record<string, string | null>>;
    canDisableThinking?: boolean;
  }>;
  constraints?: Partial<Record<ModelParameterKey, ModelParameterConstraint>>;
  notes?: string;
}>;
export type ModelParameterProfileCatalog = Readonly<{
  schemaVersion: 1;
  profiles: readonly ModelParameterProfile[];
  revision: string;
  diagnostics: readonly ModelParameterDiagnostic[];
}>;
export type ModelParameterDefinition = Readonly<{
  key: ModelParameterKey;
  label: string;
  group: "sampling" | "reasoning";
  type: "number" | "int" | "enum" | "bool";
  min?: number;
  max?: number;
  step?: number;
  values?: readonly ModelParameterValue[];
  advanced?: boolean;
  description: string;
}>;
export type ModelParameterSource = "manual" | "configuration" | "profile" | "provider" | "server";
export type ResolvedModelParameter = Readonly<{
  key: ModelParameterKey;
  control?: ModelParameterControl;
  value?: ModelParameterValue;
  recommended?: ModelParameterValue;
  source: ModelParameterSource;
  /** Transport support is known even when model-specific support is unknown. */
  supported: boolean;
  modelSupport: "supported" | "unsupported" | "unknown";
  omitted: boolean;
  explicit: boolean;
  note?: string;
  warnings: readonly ModelParameterDiagnostic[];
}>;
export type ModelParameterPresentation = Readonly<{
  parameters: readonly (ResolvedModelParameter & ModelParameterDefinition)[];
  profileId?: string;
  notes?: string;
  warnings: readonly ModelParameterDiagnostic[];
}>;
export type ResolvedModelParameters = Readonly<{
  values: Partial<Record<ModelParameterKey, ModelParameterValue>>;
  controls: ModelParameterControls;
  fields: Partial<Record<ModelParameterKey, ResolvedModelParameter>>;
  profileId?: string;
  canDisableThinking?: boolean;
  warnings: readonly ModelParameterDiagnostic[];
}>;
