import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { NATIVE_RUNTIME_INSTALLATION_FAILURE } from "./native-runtime-installation.js";

export type LocalCompanionSetupErrorCode =
  | "host_local_setup_unavailable"
  | "host_local_setup_unsafe_cache"
  | "host_local_setup_timeout"
  | "host_local_setup_failed";

const SETUP_MESSAGES: Record<LocalCompanionSetupErrorCode, string> = {
  host_local_setup_unavailable:
    "Local computer setup is available only on a Mac running ABot.",
  host_local_setup_unsafe_cache:
    "The companion installation could not be verified. Check its private installation folder before trying again.",
  host_local_setup_timeout:
    "Computer setup timed out. Check the computer connection in ABot Settings before trying again.",
  host_local_setup_failed:
    "Computer setup did not complete. Check the computer connection in ABot Settings before trying again.",
};

const KNOWN_SETUP_FAILURES = new Set([
  NATIVE_RUNTIME_INSTALLATION_FAILURE,
  "A Runtime is already paired. Use 'abot host disconnect' before pairing another.",
  "The paired computer connection is missing. Reconnect from ABot Settings.",
  "This upgrade belongs to a different paired computer connection.",
  "Pairing did not complete. Check ABot Settings and use a fresh pairing code.",
  "The updated host companion did not connect. The saved pairing is preserved; run setup again to retry.",
]);

export class LocalCompanionSetupError extends Error {
  constructor(
    readonly code: LocalCompanionSetupErrorCode,
    message = SETUP_MESSAGES[code],
  ) {
    super(message);
    this.name = "LocalCompanionSetupError";
  }
}

export type LocalSetupProcessDependencies = Readonly<{
  spawn?: typeof spawn;
  timeoutMs?: number;
  terminationTimeoutMs?: number;
  killProcessGroup?: (pid: number) => void;
}>;

function safeSetupFailure(stderr: string): LocalCompanionSetupError {
  const finalLine = stderr.trim().split(/\r?\n/u).at(-1);
  const knownMessage = finalLine && KNOWN_SETUP_FAILURES.has(finalLine);
  return new LocalCompanionSetupError(
    "host_local_setup_failed",
    knownMessage ? finalLine : undefined,
  );
}

function terminateSetupProcessGroup(
  child: ChildProcessWithoutNullStreams,
  dependencies: LocalSetupProcessDependencies,
): void {
  if (child.pid === undefined) {
    child.kill("SIGKILL");
    return;
  }
  const killGroup =
    dependencies.killProcessGroup ??
    ((pid: number) => {
      process.kill(-pid, "SIGKILL");
    });
  try {
    killGroup(child.pid);
  } catch {
    child.kill("SIGKILL");
  }
}

/** Only the bundled setup entry sees pairing data; the parent never logs output. */
export async function runLocalCompanionSetup(
  input: Readonly<{
    bundlePath: string;
    homeDir: string;
    payload: string;
  }>,
  dependencies: LocalSetupProcessDependencies,
): Promise<void> {
  const launch = dependencies.spawn ?? spawn;
  let child: ChildProcessWithoutNullStreams;
  try {
    child = launch(process.execPath, [input.bundlePath, "setup"], {
      cwd: input.homeDir,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: true,
    });
  } catch {
    throw new LocalCompanionSetupError("host_local_setup_failed");
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let outputBytes = 0;
    let stderr = "";
    let stoppingError: LocalCompanionSetupError | undefined;
    let terminationDeadline: NodeJS.Timeout | undefined;
    const deadline = setTimeout(
      () => stop(new LocalCompanionSetupError("host_local_setup_timeout")),
      dependencies.timeoutMs ?? 120_000,
    );
    function finish(error?: LocalCompanionSetupError): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(terminationDeadline);
      stderr = "";
      if (error) {
        reject(error);
        return;
      }
      resolve();
    }
    function stop(error: LocalCompanionSetupError): void {
      if (settled) return;
      if (stoppingError) return;
      stoppingError = error;
      clearTimeout(deadline);
      stderr = "";
      terminationDeadline = setTimeout(
        () => finish(error),
        dependencies.terminationTimeoutMs ?? 2_000,
      );
      terminateSetupProcessGroup(child, dependencies);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
    function acceptOutput(chunk: Buffer): boolean {
      if (settled) return false;
      if (stoppingError) return false;
      outputBytes += chunk.length;
      if (outputBytes <= 65_536) return true;
      stop(new LocalCompanionSetupError("host_local_setup_failed"));
      return false;
    }
    child.stdout.on("data", (chunk: Buffer) => acceptOutput(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      if (!acceptOutput(chunk)) return;
      stderr += chunk.toString("utf8");
    });
    child.once("error", () =>
      stop(new LocalCompanionSetupError("host_local_setup_failed")),
    );
    child.once("close", (code) => {
      if (stoppingError) {
        finish(stoppingError);
        return;
      }
      if (code === 0) {
        finish();
        return;
      }
      finish(safeSetupFailure(stderr));
    });
    child.stdin.on("error", () =>
      stop(new LocalCompanionSetupError("host_local_setup_failed")),
    );
    child.stdin.end(input.payload);
  });
}
