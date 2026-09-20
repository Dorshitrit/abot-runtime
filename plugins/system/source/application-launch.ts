import { readRequiredString } from "../../../src/plugin-sdk/index.js";
import { readSystemApplications } from "./application-catalog.js";
import {
  SystemOperationError,
  type SystemApplication,
  type SystemProcessResult,
  type SystemProcessRunner,
  type SystemTarget,
} from "./contracts.js";
import {
  findExecutable,
  powershellArguments,
  powershellLiteral,
} from "./targets.js";

function readApplicationArguments(value: unknown): string[] {
  if (value === undefined) return [];
  if (!hasBoundedArgumentArray(value))
    throw new SystemOperationError(
      "system_application_arguments_invalid",
      "arguments must be an array of at most 32 strings.",
    );
  for (const argument of value) {
    if (!isSupportedApplicationArgument(argument))
      throw new SystemOperationError(
        "system_application_arguments_invalid",
        "Each application argument must be a string without null bytes, at most 4096 characters.",
      );
  }
  return [...value] as string[];
}

export async function launchSystemApplication(input: {
  target: SystemTarget;
  params: Record<string, unknown>;
  run: SystemProcessRunner;
  abortSignal?: AbortSignal;
}): Promise<{ application: SystemApplication; process: SystemProcessResult }> {
  const { target, params, run } = input;
  const id = readRequiredString(params.application_id, {
    name: "application_id",
    maxLength: 4_096,
  });
  const args = readApplicationArguments(params.arguments);
  const catalog = await readSystemApplications(target, run);
  const application = catalog.applications.find((entry) => entry.id === id);
  if (!application)
    throw new SystemOperationError(
      "system_application_not_found",
      "The identity is absent from the current target catalog; this does not establish that the application is uninstalled. Inspect the correct OS target and use system_command for bounded executable discovery when this catalog is insufficient.",
    );
  const common = {
    timeoutMs: 30_000,
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
  };
  if (target.id === "macos")
    return {
      application,
      process: await run({
        ...common,
        executable: "/usr/bin/open",
        args: ["-a", id, ...(args.length ? ["--args", ...args] : [])],
      }),
    };
  if (hasUnsupportedTargetArguments(target, args))
    throw new SystemOperationError(
      "system_application_arguments_unsupported",
      "This target application catalog does not define generic raw arguments. Use system_command with the application's documented native invocation.",
    );
  if (target.id === "windows") {
    return {
      application,
      process: await run({
        ...common,
        executable: target.shell,
        args: powershellArguments(
          `$applicationPath=${powershellLiteral("shell:AppsFolder\\" + id)}; Start-Process -FilePath (Join-Path $env:SystemRoot 'explorer.exe') -ArgumentList ('"' + $applicationPath + '"'); Write-Output 'Launch request dispatched to Windows shell.'`,
        ),
      }),
    };
  }
  const launcher = await findExecutable("gio");
  if (!launcher)
    throw new SystemOperationError(
      "system_application_launcher_unavailable",
      "The installed desktop application catalog was read, but a native gio launcher is unavailable.",
    );
  return {
    application,
    process: await run({
      ...common,
      executable: launcher,
      args: ["launch", id],
    }),
  };
}

function hasBoundedArgumentArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  return value.length <= 32;
}
function isSupportedApplicationArgument(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length > 4_096) return false;
  return !value.includes("\0");
}
function hasUnsupportedTargetArguments(
  target: SystemTarget,
  args: readonly string[],
): boolean {
  if (target.id === "macos") return false;
  return args.length > 0;
}
