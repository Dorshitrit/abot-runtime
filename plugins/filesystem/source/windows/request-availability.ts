import { AsyncLocalStorage } from "node:async_hooks";
import {
  failureResult,
  type ToolModuleRequestPreparation,
  type ToolModuleDeclaration,
} from "../../../../src/plugin-sdk/index.js";
import type { FilesystemToolError } from "../errors.js";
import { isWindowsHelperBlocked, runWindowsFilesystem } from "./process.js";

type RequestAvailability = { blocked?: FilesystemToolError };
const currentRequest = new AsyncLocalStorage<{
  availability: RequestAvailability;
  signal?: AbortSignal;
}>();

/** A detected helper block applies only to this request, never to another installation/request. */
export async function executeWindowsFilesystem(
  request: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const scope = currentRequest.getStore();
  if (scope?.availability.blocked) throw scope.availability.blocked;
  try {
    return await runWindowsFilesystem(request, scope?.signal);
  } catch (error) {
    if (scope && isWindowsHelperBlocked(error))
      scope.availability.blocked = error;
    throw error;
  }
}

export const prepareFilesystemRequest: ToolModuleRequestPreparation = async (
  modules,
) => {
  if (process.platform !== "win32" || modules.length === 0) return modules;
  try {
    const result = await runWindowsFilesystem({ operation: "probe" });
    if (
      !result ||
      typeof result !== "object" ||
      !("available" in result) ||
      result.available !== true
    )
      return Object.freeze([]);
  } catch {
    return Object.freeze([]);
  }
  const availability: RequestAvailability = {};
  return Object.freeze(
    modules.map<ToolModuleDeclaration>((module) => ({
      ...module,
      implementation: (params, context) => {
        if (availability.blocked)
          return Promise.resolve(
            failureResult({
              errorCode: availability.blocked.code,
              message: availability.blocked.message,
              data: availability.blocked.data,
            }),
          );
        return currentRequest.run(
          { availability, signal: context?.abortSignal },
          () => module.implementation(params, context),
        );
      },
    })),
  );
};
