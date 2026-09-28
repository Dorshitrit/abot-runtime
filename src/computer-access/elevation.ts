import {
  SystemOperationError,
  type SystemProcessInput,
  type SystemProcessRunner,
  type SystemTarget,
} from "./contracts.js";
import {
  powershellArguments,
  shellLiteral,
  windowsSystemCommandScript,
} from "./targets.js";

const WINDOWS_ADMIN_PROBE =
  "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)";

/** Resolve real native authority. Missing human authorization is an explicit result. */
export async function elevatedSystemCommand(input: {
  target: SystemTarget;
  command: string;
  cwd: string;
  run: SystemProcessRunner;
}): Promise<SystemProcessInput> {
  const { target, command, cwd, run } = input;
  if (target.id === "windows")
    return windowsElevatedCommand(target, command, cwd, run);
  if (process.getuid?.() === 0)
    return { executable: target.shell, args: ["-lc", command], cwd };
  if (target.id === "macos") {
    const script = `cd ${shellLiteral(cwd)} && ${shellLiteral(target.shell)} -lc ${shellLiteral(command)}`;
    const appleScriptString = JSON.stringify(script);
    return {
      executable: "/usr/bin/osascript",
      args: [
        "-e",
        `do shell script ${appleScriptString} with administrator privileges`,
      ],
    };
  }
  const probe = await run({
    executable: "/usr/bin/sudo",
    args: ["-n", "--", "/usr/bin/true"],
    timeoutMs: 5_000,
  });
  if (!hasSuccessfulPrivilegeProbe(probe))
    throw new SystemOperationError(
      "system_authorization_required",
      "Linux sudo authorization requires a human or a configured native privilege policy. Authenticate in a native terminal or supply an authorized host; ABot does not request, invent or bypass passwords.",
    );
  return {
    executable: "/usr/bin/sudo",
    args: ["-n", "--", target.shell, "-lc", command],
    cwd,
  };
}

function hasSuccessfulPrivilegeProbe(
  probe: Awaited<ReturnType<SystemProcessRunner>>,
): boolean {
  if (probe.status !== "completed") return false;
  return probe.exitCode === 0;
}
function hasWindowsAdministratorAuthority(
  probe: Awaited<ReturnType<SystemProcessRunner>>,
): boolean {
  if (!hasSuccessfulPrivilegeProbe(probe)) return false;
  return probe.stdout.trim() === "True";
}
async function windowsElevatedCommand(
  target: SystemTarget,
  command: string,
  cwd: string,
  run: SystemProcessRunner,
): Promise<SystemProcessInput> {
  const probe = await run({
    executable: target.shell,
    args: powershellArguments(WINDOWS_ADMIN_PROBE),
    timeoutMs: 5_000,
  });
  if (!hasWindowsAdministratorAuthority(probe))
    throw new SystemOperationError(
      "system_authorization_required",
      "Windows Administrator authority is required. Approve UAC in a native Windows elevated host, then retry; this noninteractive transport cannot answer UAC or provide credentials.",
    );
  return {
    executable: target.shell,
    args: powershellArguments(windowsSystemCommandScript(command, cwd)),
  };
}
