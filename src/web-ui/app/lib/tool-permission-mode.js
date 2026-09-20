import { textOf } from "./text-format.js";

export const TOOL_PERMISSION_MODES = Object.freeze([
  "full_access", "full_plus", "ask",
]);

const permissionMetadata = Object.freeze({
  ask: {
    label: "Ask",
    description: "Require approval",
    title: "Ask before running tools",
  },
  full_access: {
    label: "Full",
    description: "Run tools directly",
    title: "Run tools without approval prompts",
  },
  full_plus: {
    label: "FULL+",
    description: "Full trust, including system actions",
    title: "Full trust, including system actions; OS permissions still apply",
  },
});

export function normalizeToolPermissionMode(value) {
  if (value === "full_plus") return "full_plus";
  const mode = textOf(value).trim().toLowerCase();
  if (mode === "ask" || mode === "approval_required") return "ask";
  return "full_access";
}

export function toolPermissionModeMeta(mode) {
  return permissionMetadata[normalizeToolPermissionMode(mode)];
}

export function supportsFullPlus(config) {
  if (config?.backend !== "runtime") return false;
  if (!Array.isArray(config.supportedToolPermissionModes)) return false;
  return config.supportedToolPermissionModes.includes("full_plus");
}

export function isKnownToolPermissionMode(mode) {
  if (mode === "approval_required") return true;
  return TOOL_PERMISSION_MODES.includes(mode);
}

export function toolPermissionRequestError(mode, config) {
  if (!isKnownToolPermissionMode(mode)) {
    return {
      code: "unsupported_tool_permission_mode",
      message: "The selected tool permission mode is not recognized. Select a supported mode before sending.",
    };
  }
  if (mode !== "full_plus") return null;
  if (supportsFullPlus(config)) return null;
  return {
    code: "full_plus_not_supported",
    message: "This server does not advertise FULL+ support. Update the server or explicitly select Ask or Full before sending.",
  };
}
