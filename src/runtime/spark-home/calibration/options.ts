import type { ToolPermissionMode } from "../../../capabilities/tool-permission-mode.js";
import type { RegisteredToolNormalInvocation } from "../../../capabilities/tool-types.js";
import { captureRequestPermissionCatalog } from "../../capabilities/request-permission-catalog.js";
import type { RuntimeModelPluginConfig } from "../../config/model-plugin-config.js";
import type { ToolRegistry } from "../../ports.js";
import { SparkHomeSettingsError } from "../settings/contracts.js";
import type { SparkHomeWidgetId } from "../widgets/catalog.js";

export type SparkHomeCalibrationOptionId = "calendar" | "clock" | "web_topics" | "system_status";

export type SparkHomeCalibrationOption = Readonly<{
  id: SparkHomeCalibrationOptionId;
  label: string;
  description: string;
  nativeWidgetId?: SparkHomeWidgetId;
  available: boolean;
  reason: string | null;
}>;

type PublicOperationRequirement = Readonly<{
  pluginName: string;
  toolName: string;
  operationIds: readonly string[];
}>;

type CalibrationOptionDefinition = Readonly<
  Pick<SparkHomeCalibrationOption, "id" | "label" | "description" | "nativeWidgetId"> & {
    requirement?: PublicOperationRequirement;
  }
>;

/** Product choices, not a general tool catalog or a preselected personal profile. */
const CALIBRATION_OPTIONS: readonly CalibrationOptionDefinition[] = Object.freeze([
  {
    id: "calendar",
    label: "Calendar",
    description: "Show a month calendar with today's date highlighted, without connected calendar events.",
  },
  {
    id: "clock",
    label: "Clock",
    description: "Show the current local time.",
  },
  {
    id: "web_topics",
    label: "Updates and reading",
    description: "Find sourced updates and useful reading about topics you choose. Search may cover a limited set of public sources; results are not guaranteed.",
    requirement: {
      pluginName: "web",
      toolName: "web_search",
      operationIds: ["search_one", "search_many"],
    },
  },
  {
    id: "system_status",
    label: "System monitor",
    description: "Show live CPU and memory usage, plus temperature where supported. Clearly identify computer, WSL or container metrics.",
    nativeWidgetId: "system-metrics",
  },
]);

function supportsPublicOperation(
  registrations: readonly RegisteredToolNormalInvocation[],
  requirement: PublicOperationRequirement,
): boolean {
  return registrations.some(registration =>
    registration.definition.pluginName === requirement.pluginName &&
    registration.toolName === requirement.toolName &&
    registration.contract.operations.some(operation =>
      requirement.operationIds.includes(operation.operationId)),
  );
}

/**
 * These public search operations have no request-time preparation hook.
 * Reuse the loaded registry and shared authority filter without preparing other
 * plugins, observing hosts, executing tools or widening the user's permissions.
 */
export function readSparkHomeCalibrationOptions(input: Readonly<{
  tools: ToolRegistry;
  toolPermissionMode: ToolPermissionMode;
  modelPlugins?: RuntimeModelPluginConfig;
}>): readonly SparkHomeCalibrationOption[] {
  const catalog = captureRequestPermissionCatalog(input.tools, input.toolPermissionMode, input.modelPlugins);
  const registrations = catalog.listNormalInvocations() ?? [];
  return Object.freeze(CALIBRATION_OPTIONS.map(({ requirement, ...option }) => {
    const available = requirement === undefined || supportsPublicOperation(registrations, requirement);
    return Object.freeze({
      ...option,
      available,
      reason: available ? null : "Unavailable with the current model, tools or permissions.",
    });
  }));
}

/** Revalidate saved selections against a fresh projection before drafting. */
export function assertAvailableSparkHomeCalibrationOptions(
  selectedIds: readonly string[],
  options: readonly SparkHomeCalibrationOption[],
): readonly SparkHomeCalibrationOption[] {
  if (new Set(selectedIds).size !== selectedIds.length)
    throw new SparkHomeSettingsError("spark_home_calibration_options_changed");
  return Object.freeze(selectedIds.map(id => {
    const option = options.find(candidate => candidate.id === id);
    if (!option?.available)
      throw new SparkHomeSettingsError("spark_home_calibration_options_changed");
    return option;
  }));
}
