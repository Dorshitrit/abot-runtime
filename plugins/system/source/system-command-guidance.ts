import type { SystemTargetId } from "../../../src/plugin-sdk/computer-access.js";
import {
  routeTargetId,
  type SystemRequestRoute,
  type SystemTargetSnapshot,
} from "./request-target-snapshot.js";

type CommandTargetGuidance = Readonly<{
  target: SystemTargetId;
  shell: "Bash" | "PowerShell";
  transport: "native" | "wsl_interop" | "host_companion";
  cwd: "absolute" | "runtime_relative_or_absolute";
}>;

/** Derived from captured routes and the installed adapter; never probes a target. */
export function projectSystemCommandTargets(
  snapshot: SystemTargetSnapshot,
  hasRuntimePathResolver: boolean,
): readonly CommandTargetGuidance[] {
  return Object.freeze(snapshot.map((route) => {
    const target = routeTargetId(route);
    return Object.freeze({
      target,
      shell: target === "windows" ? "PowerShell" : "Bash",
      transport: route.kind === "native" ? route.target.transport : "host_companion",
      cwd: supportsRuntimeRelativeCommandDirectory(route, hasRuntimePathResolver)
        ? "runtime_relative_or_absolute"
        : "absolute",
    });
  }));
}

export function systemCommandGuidance(
  snapshot: SystemTargetSnapshot,
  hasRuntimePathResolver: boolean,
): string {
  const targets = projectSystemCommandTargets(snapshot, hasRuntimePathResolver);
  if (targets.length === 0) return "";
  return ` Command targets: ${targets.map(describeCommandTarget).join("; ")}.`;
}

function supportsRuntimeRelativeCommandDirectory(
  route: SystemRequestRoute,
  hasRuntimePathResolver: boolean,
): boolean {
  if (!hasRuntimePathResolver) return false;
  if (route.kind !== "native") return false;
  if (route.target.id !== "windows") return false;
  return route.target.transport === "native";
}

function describeCommandTarget(target: CommandTargetGuidance): string {
  const transport = target.transport === "host_companion"
    ? "companion, command readiness unprobed"
    : target.transport;
  const cwd = target.cwd === "runtime_relative_or_absolute"
    ? "cwd absolute or agent-work-relative; workspace/ uses workspace root"
    : "cwd absolute in target OS";
  return `${target.target} (${target.shell}; ${transport}; ${cwd})`;
}

/** Keep command contracts scoped to commands; other tools retain target availability only. */
export function systemRequestTargetGuidance(
  toolName: string,
  snapshot: SystemTargetSnapshot,
  hasRuntimePathResolver: boolean,
): string {
  if (usesCommandTargetContract(toolName))
    return systemCommandGuidance(snapshot, hasRuntimePathResolver);
  return ` Available targets for this request: ${snapshot.map(routeTargetId).join(", ")}.`;
}

function usesCommandTargetContract(toolName: string): boolean {
  return toolName === "system_command";
}
