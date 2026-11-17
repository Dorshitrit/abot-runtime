import type {
  SystemApplication,
  SystemApplicationExecutableResolution,
  SystemProcessRunner,
  SystemTarget,
} from "./contracts.js";
import { observeWindowsApplicationExecutables } from "./windows-application-executable.js";
import { observeLinuxApplicationExecutable } from "./linux-application-executable.js";
import { observeMacApplicationExecutables } from "./macos-application-executable.js";

/** Enrich only the bounded selected catalog results. Never discover or launch another app. */
export async function observeSystemApplicationExecutables(
  target: SystemTarget,
  applications: readonly SystemApplication[],
  run: SystemProcessRunner,
  abortSignal?: AbortSignal,
): Promise<readonly SystemApplication[]> {
  abortSignal?.throwIfAborted();
  const resolutions = await observeSelectedExecutables(target, applications, run, abortSignal);
  abortSignal?.throwIfAborted();
  return applications.map((application, index) => ({
    ...application,
    executableResolution: resolutions[index]!,
  }));
}

async function observeSelectedExecutables(
  target: SystemTarget,
  applications: readonly SystemApplication[],
  run: SystemProcessRunner,
  abortSignal?: AbortSignal,
): Promise<readonly SystemApplicationExecutableResolution[]> {
  if (applications.length === 0) return [];
  if (target.id === "windows") return observeWindowsApplicationExecutables(target, applications, run, abortSignal);
  if (target.id === "macos") return observeMacApplicationExecutables(applications, run, abortSignal);
  return Promise.all(applications.map((application) => observeLinuxApplicationExecutable(application, abortSignal)));
}
