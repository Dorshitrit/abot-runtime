import type { ModelParameterValue } from "../../shared/model-parameters.js";
import type { ProviderParameterCapabilities, ProviderParameterCapability } from "./parameter-capabilities.js";

/** Environment and native options retain adapter semantics; no browser provider knowledge. */
export function resolveProviderParameterDefault(capabilities: ProviderParameterCapabilities, capability: ProviderParameterCapability | undefined,
  options: Readonly<Record<string, unknown>> | undefined): { value?: ModelParameterValue; source: "configuration" | "provider"; nativeSentinel?: boolean } | undefined {
  if (!capability) return undefined;
  if (capability.environmentOverride) {
    const value = Number(process.env[capability.environmentOverride]);
    if (Number.isFinite(value) && value > 0) return { value: Math.trunc(value), source: "provider" };
  }
  if (capabilities.nativeOptions && options) {
    const value = options[capability.path.at(-1)!];
    if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
      return { value, source: "configuration", nativeSentinel: typeof value === "number" && capability.nativeSentinels?.includes(value) === true };
    }
  }
  if (capability.computedDefault) return { source: "provider" };
  return undefined;
}
