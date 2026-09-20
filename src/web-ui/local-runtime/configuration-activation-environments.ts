import type { LocalRuntimeApplication } from "../../runtime/local-application.js";

export type EnvironmentEntry = readonly [string, LocalRuntimeApplication];

export type ActivationEnvironmentOptions = {
  environments: Map<string, LocalRuntimeApplication>;
  canContinue?: () => boolean;
};

export function requireActivationIntakeOpen(
  options: ActivationEnvironmentOptions,
): void {
  if (options.canContinue?.() === false) throw new Error("web_runtime_stopped");
}

async function disposeFailedEnvironment(
  options: ActivationEnvironmentOptions,
  entry: EnvironmentEntry,
  startupError: unknown,
): Promise<void> {
  const [id, environment] = entry;
  try {
    await environment.stop();
  } catch (stopError) {
    // LocalApplication.stop closes in finally, then may rethrow its original startup error.
    if (stopError !== startupError)
      throw new AggregateError(
        [startupError, stopError],
        "Failed runtime startup could not be cleaned up.",
      );
  }
  if (options.environments.get(id) === environment)
    options.environments.delete(id);
}

export async function settleExistingEnvironments(
  options: ActivationEnvironmentOptions,
): Promise<EnvironmentEntry[]> {
  const current = [...options.environments];
  const starts = await Promise.allSettled(
    current.map(([, environment]) => environment.start()),
  );
  requireActivationIntakeOpen(options);
  for (const [index, result] of starts.entries()) {
    if (result.status !== "rejected") continue;
    await disposeFailedEnvironment(options, current[index]!, result.reason);
  }
  return current.filter(
    ([id, environment]) => options.environments.get(id) === environment,
  );
}

export type IdleEnvironmentShutdown =
  | { status: "closed"; closed: readonly EnvironmentEntry[] }
  | {
      status: "failed";
      closed: readonly EnvironmentEntry[];
      error: unknown;
      hasUncertainOwners: boolean;
    };

function requestIdleEnvironmentShutdown([
  ,
  environment,
]: EnvironmentEntry): Promise<boolean> {
  try {
    return environment.stopIfIdle();
  } catch (error) {
    return Promise.reject(error);
  }
}

function isConfirmedIdleShutdown(
  result: PromiseSettledResult<boolean>,
): boolean {
  if (result.status !== "fulfilled") return false;
  return result.value;
}

function isRefusedIdleShutdown(result: PromiseSettledResult<boolean>): boolean {
  if (result.status !== "fulfilled") return false;
  return !result.value;
}

/** Every outcome settles before reporting a partial shutdown to Apply. */
export async function closeIdleEnvironments(
  options: ActivationEnvironmentOptions,
  current: readonly EnvironmentEntry[],
): Promise<IdleEnvironmentShutdown> {
  // No await separates the complete idle snapshot from closing every owner's intake.
  const closes = current.map(requestIdleEnvironmentShutdown);
  const results = await Promise.allSettled(closes);
  const closed = current.filter((_, index) =>
    isConfirmedIdleShutdown(results[index]!),
  );
  for (const [id, environment] of closed) {
    if (options.environments.get(id) === environment)
      options.environments.delete(id);
  }
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") {
    return {
      status: "failed",
      closed,
      error: failed.reason,
      hasUncertainOwners: true,
    };
  }
  if (results.some(isRefusedIdleShutdown)) {
    return {
      status: "failed",
      closed,
      error: new Error(
        "Runtime ownership changed while applying configuration.",
      ),
      hasUncertainOwners: false,
    };
  }
  return { status: "closed", closed };
}

export async function startReplacementEnvironments(
  options: ActivationEnvironmentOptions,
  replacements: readonly EnvironmentEntry[],
): Promise<void> {
  requireActivationIntakeOpen(options);
  for (const [id, replacement] of replacements)
    options.environments.set(id, replacement);
  const starts = await Promise.allSettled(
    replacements.map(async (entry) => {
      try {
        await entry[1].start();
      } catch (error) {
        await disposeFailedEnvironment(options, entry, error);
        throw error;
      }
    }),
  );
  const failed = starts.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  requireActivationIntakeOpen(options);
}

/** Retire candidate owners before restoring the previous gateway policy. */
export async function closeReplacementEnvironments(
  options: ActivationEnvironmentOptions,
  previous: readonly EnvironmentEntry[],
): Promise<void> {
  const previousOwners = new Map(previous);
  const candidates = [...options.environments].filter(
    ([id, environment]) => previousOwners.get(id) !== environment,
  );
  const stops = await Promise.allSettled(
    candidates.map(async ([id, environment]) => {
      await environment.stop();
      if (options.environments.get(id) === environment)
        options.environments.delete(id);
    }),
  );
  const errors = stops.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (errors.length > 0)
    throw new AggregateError(errors, "Candidate runtime cleanup failed.");
}
