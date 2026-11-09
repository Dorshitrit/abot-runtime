import type { SparkHomeApplicationServices } from "../spark-home/application-contracts.js";

export const LOCAL_HOME_METHODS = {
  sparkHome: ["read"],
  sparkHomeSettings: ["read", "update", "readCalibrationOptions", "draftCalibration"],
  sparkHomeGeneration: ["start", "readRun", "cancel", "decideApproval"],
  sparkHomePreferences: ["read", "update"],
} as const;

export function isLocalSparkHomeService(method: string): boolean {
  return Object.hasOwn(LOCAL_HOME_METHODS, method.split(".")[0] ?? "");
}

/** RPC exposes feature actions, never publication, tool execution or scheduled authority. */
export async function dispatchLocalSparkHomeService(
  services: SparkHomeApplicationServices, method: string, args: readonly unknown[],
): Promise<unknown> {
  const [name, operation, extra] = method.split(".");
  if (!name || !operation || extra || !isLocalSparkHomeService(method))
    throw new Error("local_runtime_method_unknown");
  const serviceName = name as keyof typeof LOCAL_HOME_METHODS;
  if (!(LOCAL_HOME_METHODS[serviceName] as readonly string[]).includes(operation))
    throw new Error("local_runtime_method_unknown");
  const target = services[serviceName];
  if (!target) throw new Error("spark_home_unavailable");
  const selected = (target as unknown as Record<string, unknown>)[operation];
  if (typeof selected !== "function") throw new Error("local_runtime_method_unavailable");
  return selected.apply(target, args);
}
