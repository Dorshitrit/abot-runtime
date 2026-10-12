import { win32 } from "node:path";
import type {
  RuntimeToolPathResolver,
  ToolCall,
  ToolCallAdapter,
} from "../../../src/plugin-sdk/index.js";
import type { SystemTargetSnapshot } from "./request-target-snapshot.js";

/** Resolve before exact-action approval; execution consumes the captured absolute cwd. */
export function createSystemCommandPathAdapter(
  adapter: ToolCallAdapter | undefined,
  snapshot: SystemTargetSnapshot,
  resolver: RuntimeToolPathResolver | undefined,
): ToolCallAdapter | undefined {
  if (!resolver) return adapter;
  return {
    ...adapter,
    normalizeCall(input) {
      const call = adapter?.normalizeCall?.(input) ?? input;
      if (!hasNativeWindowsRelativeDirectory(call, snapshot)) return call;
      const directory = resolver.resolve(call.params.cwd, {
        requirePath: true,
        allowedLocations: ["agent_work", "workspace"],
      });
      return {
        ...call,
        params: { ...call.params, cwd: directory.absolutePath },
      };
    },
  };
}

function hasNativeWindowsRelativeDirectory(
  call: ToolCall,
  snapshot: SystemTargetSnapshot,
): boolean {
  if (call.tool !== "system_command") return false;
  if (call.params.target !== "windows") return false;
  if (typeof call.params.cwd !== "string") return false;
  if (win32.isAbsolute(call.params.cwd.trim())) return false;
  const route = snapshot.find((entry) => {
    if (entry.kind !== "native") return false;
    if (entry.target.id !== "windows") return false;
    return entry.target.transport === "native";
  });
  return route !== undefined;
}
