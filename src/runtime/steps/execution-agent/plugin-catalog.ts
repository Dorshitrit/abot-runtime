import type { ChatMessage } from "../../../model-gateway/types.js";
import type { ToolAvailabilityEntry } from "../../../capabilities/tool-types.js";
import {
  buildPluginDiscoveryCatalogText,
  PLUGIN_DISCOVERY_CATALOG_HEADER,
} from "../../context/capability-descriptions.js";

export const EXECUTION_CAPABILITY_GROUP_CATALOG_HEADER = PLUGIN_DISCOVERY_CATALOG_HEADER;

export function buildExecutionCapabilityGroupCatalogMessage(
  catalogGroupIds: readonly string[],
  entries: readonly ToolAvailabilityEntry[] = [],
): ChatMessage {
  return Object.freeze({
    role: "user" as const,
    content: buildPluginDiscoveryCatalogText(catalogGroupIds, entries),
  });
}
