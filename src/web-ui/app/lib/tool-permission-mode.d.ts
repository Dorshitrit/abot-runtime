import type { ToolPermissionMode } from "../../../runtime/ports.js";
export type { ToolPermissionMode } from "../../../runtime/ports.js";

export declare const TOOL_PERMISSION_MODES: readonly ToolPermissionMode[];
export declare function normalizeToolPermissionMode(value: unknown): ToolPermissionMode;
export declare function toolPermissionModeMeta(mode: unknown): Readonly<{
  label: string;
  description: string;
  title: string;
}>;
export declare function supportsFullPlus(config: unknown): boolean;
export declare function isKnownToolPermissionMode(mode: unknown): boolean;
export declare function toolPermissionRequestError(
  mode: unknown,
  config: unknown,
): { code: string; message: string } | null;
