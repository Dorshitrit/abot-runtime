import { enforcePluginResultByteBudget, type ToolImplementationOutput, type ToolResultBudget } from "../plugin-sdk/index.js";
import { formatSystemApplicationSummary, type SystemApplicationObservationData } from "./application-summary.js";
import type { SystemApplication } from "./contracts.js";

/** Reproject optional app metadata only; unchanged results keep their boundary's existing handling. */
export function projectSystemApplicationResultForBudget(
  result: ToolImplementationOutput,
  budget?: ToolResultBudget,
): ToolImplementationOutput {
  const assessed = enforcePluginResultByteBudget(result, budget);
  if (assessed === result) return result;
  if (assessed.errorCode !== "plugin_result_too_large") return result;
  const observation = readCanonicalApplicationObservation(result);
  if (!observation) return result;
  if (!hasOptionalExecutableMetadata(observation.applications)) return result;
  const originalSummary = formatSystemApplicationSummary(observation);
  if (!result.output.endsWith(originalSummary)) return result;
  const prefix = result.output.slice(0, result.output.length - originalSummary.length);
  const present = (applications: readonly SystemApplication[]): ToolImplementationOutput => ({
    ...result,
    output: prefix + formatSystemApplicationSummary({ ...observation, applications }),
    data: { ...result.data, applications },
  });
  const withheld = present(observation.applications.map((application): SystemApplication => {
    if (!application.executableResolution) return application;
    return { ...application, executableResolution: {
      status: "unresolved", source: application.executableResolution.source, reason: "output_budget_exceeded",
    } };
  }));
  if (enforcePluginResultByteBudget(withheld, budget) === withheld) return withheld;
  const identities = present(observation.applications.map(({ executableResolution: _resolution, ...identity }) => identity));
  if (enforcePluginResultByteBudget(identities, budget) === identities) return identities;
  return result;
}

function readCanonicalApplicationObservation(result: ToolImplementationOutput): SystemApplicationObservationData | undefined {
  if (!result.ok) return undefined;
  if (!isApplicationObservationRecord(result.data)) return undefined;
  const data = result.data;
  const transport = data.transport === "host_companion" ? data.nativeTransport : data.transport;
  if (!isSystemApplicationTarget(data.target)) return undefined;
  if (!isApplicationObservationTransport(transport)) return undefined;
  if (data.absenceConclusionSupported !== false) return undefined;
  if (data.completenessMeaning !== "declared_catalog_sources_only") return undefined;
  if (typeof data.catalogComplete !== "boolean") return undefined;
  if (!isApplicationMatchCount(data.observedMatches)) return undefined;
  if (!isApplicationMatchCount(data.omittedMatches)) return undefined;
  if (!Array.isArray(data.applications)) return undefined;
  if (data.applications.length > 100) return undefined;
  if (!data.applications.every(isCanonicalSystemApplication)) return undefined;
  const scope = data.catalogScope;
  if (!isApplicationObservationRecord(scope)) return undefined;
  if (!isDeclaredApplicationCatalogSource(scope.source)) return undefined;
  if (scope.includesExecutableSearch !== false) return undefined;
  if (scope.includesOtherTargets !== false) return undefined;
  if (!Array.isArray(scope.roots)) return undefined;
  if (!scope.roots.every((root) => typeof root === "string")) return undefined;
  return {
    target: data.target,
    transport,
    absenceConclusionSupported: false,
    completenessMeaning: "declared_catalog_sources_only",
    catalogScope: { source: scope.source, roots: scope.roots, includesExecutableSearch: false, includesOtherTargets: false },
    catalogComplete: data.catalogComplete,
    observedMatches: data.observedMatches,
    omittedMatches: data.omittedMatches,
    applications: data.applications,
  };
}

function isApplicationObservationRecord(value: unknown): value is Record<string, unknown> {
  if (value === null) return false;
  if (typeof value !== "object") return false;
  return !Array.isArray(value);
}
function isSystemApplicationTarget(value: unknown): value is SystemApplication["target"] {
  return value === "windows" || value === "linux" || value === "macos";
}
function isApplicationObservationTransport(value: unknown): value is SystemApplicationObservationData["transport"] {
  return value === "native" || value === "wsl_interop";
}
function isDeclaredApplicationCatalogSource(value: unknown): value is SystemApplicationObservationData["catalogScope"]["source"] {
  return value === "windows_start_apps" || value === "macos_application_bundles" || value === "linux_desktop_entries";
}
function isApplicationMatchCount(value: unknown): value is number {
  if (typeof value !== "number") return false;
  if (!Number.isSafeInteger(value)) return false;
  return value >= 0;
}
function isCanonicalSystemApplication(value: unknown): value is SystemApplication {
  if (!isApplicationObservationRecord(value)) return false;
  if (typeof value.id !== "string") return false;
  if (typeof value.name !== "string") return false;
  if (!isSystemApplicationTarget(value.target)) return false;
  const resolution = value.executableResolution;
  if (resolution === undefined) return true;
  if (!isApplicationObservationRecord(resolution)) return false;
  if (typeof resolution.source !== "string") return false;
  if (!["windows_apps_folder_target", "macos_bundle_executable", "linux_desktop_exec"].includes(resolution.source)) return false;
  if (resolution.status === "resolved") return typeof resolution.path === "string";
  if (resolution.status !== "unresolved" && resolution.status !== "ambiguous") return false;
  return typeof resolution.reason === "string";
}

function hasOptionalExecutableMetadata(applications: readonly SystemApplication[]): boolean {
  return applications.some((application) => application.executableResolution !== undefined);
}
