import type { ModelParameterKey, ResolvedModelParameters } from "../../shared/model-parameters.js";
import { getProviderParameterCapabilities } from "./parameter-capabilities.js";

/** Only adapter-declared paths are writable; arbitrary profile fields never become wire keys. */
export function projectResolvedModelParameters(
  payload: Record<string, unknown>, provider: string, parameters: ResolvedModelParameters | undefined,
): void {
  if (!parameters) return;
  for (const [key, capability] of Object.entries(getProviderParameterCapabilities(provider).parameters)) {
    if (key === "reasoning_effort" || key === "thinking_budget") continue;
    const field = parameters.fields[key as ModelParameterKey];
    if (!field) continue;
    const shouldRemove = field.control?.mode === "omit" || !field.supported || field.warnings.length > 0;
    if (field.value === undefined && !shouldRemove) continue;
    let target = payload;
    for (const segment of capability.path.slice(0, -1)) {
      const nested = target[segment];
      if (nested && typeof nested === "object" && !Array.isArray(nested)) {
        target = nested as Record<string, unknown>;
        continue;
      }
      const next: Record<string, unknown> = {};
      target[segment] = next;
      target = next;
    }
    const wireKey = capability.path.at(-1)!;
    if (field.value === undefined || !field.supported) delete target[wireKey];
    else target[wireKey] = field.value;
  }
}
