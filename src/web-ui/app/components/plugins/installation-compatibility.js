import { isPluginPlatformUnavailable } from "./compatibility.js";

export function pluginInstallationMessage(review) {
  if (isPluginPlatformUnavailable(review.compatibility))
    return `${review.id} installed. It will not load on this Runtime: ${review.compatibility.reason}`;
  return `${review.id} installed. Apply changes to make it available.`;
}
