import type {
  RuntimeSelectionControllerDependencies,
  createRuntimeSelectionController,
} from "./runtime-selection-controller.js";

type SelectionDependencies = RuntimeSelectionControllerDependencies;

export declare function createToolPermissionModeController(options: {
  state: Pick<SelectionDependencies["state"],
    "config" | "sessionModes" | "permissionModeMenuOpen">;
  dom: Pick<SelectionDependencies["dom"],
    "permissionModeButton" | "permissionModeMenu">;
  preferences: Pick<SelectionDependencies["preferences"],
    "saveSessionModes" | "loadLastToolPermissionMode" | "saveLastToolPermissionMode">;
  recordControlEvent: SelectionDependencies["recordControlEvent"];
  getComposerSessionId: () => string;
}): Pick<ReturnType<typeof createRuntimeSelectionController>,
  "clearSessionMode" | "currentToolPermissionMode" | "initializeSessionMode" |
  "renderPermissionMode" | "setToolPermissionMode"
>;
