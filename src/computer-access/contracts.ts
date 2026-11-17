export type SystemTargetId = "linux" | "macos" | "windows";
export type SystemTarget = Readonly<{
  id: SystemTargetId;
  transport: "native" | "wsl_interop";
  shell: string;
}>;
export type SystemProcessInput = Readonly<{
  executable: string;
  args: readonly string[];
  cwd?: string;
  timeoutMs?: number;
  outputMaxChars?: number;
  abortSignal?: AbortSignal;
}>;
export type SystemSpawnObservation = Readonly<{
  pid: number;
  pidNamespace: "runtime_os";
  executable: string;
  identitySource: "spawn_arguments";
}>;
export type SystemProcessResult = Readonly<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  status: "completed" | "timeout" | "aborted" | "spawn_failed" | "output_failed";
  outputTruncated: boolean;
  spawnedProcess?: SystemSpawnObservation;
}>;
export type SystemProcessRunner = (
  input: SystemProcessInput,
) => Promise<SystemProcessResult>;
export type SystemApplication = Readonly<{
  id: string;
  name: string;
  target: SystemTargetId;
  executableResolution?: SystemApplicationExecutableResolution;
}>;
export type SystemApplicationExecutableSource =
  | "windows_apps_folder_target"
  | "macos_bundle_executable"
  | "linux_desktop_exec";
/** Registered executable observation, never a complete invocation or launch receipt. */
export type SystemApplicationExecutableResolution = Readonly<
  | {
      status: "resolved";
      source: SystemApplicationExecutableSource;
      path: string;
    }
  | {
      status: "unresolved" | "ambiguous";
      source: SystemApplicationExecutableSource;
      reason: string;
    }
>;
export class SystemOperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
