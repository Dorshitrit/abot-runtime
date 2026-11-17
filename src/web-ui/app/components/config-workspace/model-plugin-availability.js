import { isPluginPlatformUnavailable } from "../plugins/compatibility.js";
import { resolveModelExecutionRoute } from "./config-model.js";

export function modelPluginRouteBlockReason(config, plugin) {
  const route = resolveModelExecutionRoute(config.execution?.policy);
  if (!route.supported) return route.description;
  const policies = plugin.executionPolicies;
  if (!Array.isArray(policies) || policies.includes(route.policy)) return "";
  const supported = policies.map((policy) => resolveModelExecutionRoute(policy).label);
  return `Unavailable for ${route.label}. Available for ${supported.join(", ")}.`;
}

function inactivePluginReason({
  plugin,
  routeBlockedReason,
  globalBlockedReason,
  modelEnabled,
  selectedCapabilityCount,
}) {
  if (routeBlockedReason) return routeBlockedReason;
  if (isPluginPlatformUnavailable(plugin.compatibility))
    return plugin.compatibility.reason || "Unavailable on this host.";
  if (globalBlockedReason) return globalBlockedReason;
  if (!modelEnabled) return "Disabled for this model.";
  if (selectedCapabilityCount === 0) return "No tools are enabled for this model.";
  return "";
}

export function projectModelPluginAvailability(input) {
  const inactiveReason = inactivePluginReason(input);
  return {
    active: inactiveReason.length === 0,
    activeCapabilityCount: inactiveReason ? 0 : input.selectedCapabilityCount,
    inactiveReason,
  };
}
