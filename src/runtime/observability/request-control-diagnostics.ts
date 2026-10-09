import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { traceDebug } from "./debug-logger.js";

export { classifyRuntimeErrorType as diagnosticErrorType } from "./error-type.js";

export type RequestControlDiagnosticFields = Readonly<
  Record<string, string | number | boolean | null | undefined>
>;

let fallbackId = 0;

/** Diagnostic identity only; never used for request admission or ownership. */
export function createRequestControlDiagnosticId(prefix: string): string {
  try {
    return `${prefix}-${randomUUID()}`;
  } catch {
    return `${prefix}-${process.pid}-${Date.now()}-${++fallbackId}`;
  }
}

const processInstanceId = createRequestControlDiagnosticId("process");
let packageIdentity: RequestControlDiagnosticFields | undefined;

function readPackageIdentity(): RequestControlDiagnosticFields {
  // Source and compiled layouts. Installed packages do not require a Git checkout.
  for (const relative of [
    "../../../package.json",
    "../../../../package.json",
  ]) {
    try {
      const value = JSON.parse(
        readFileSync(new URL(relative, import.meta.url), "utf8"),
      );
      if (value.name !== "@abot-ai/runtime") continue;
      return {
        runtimeVersion:
          typeof value.version === "string" ? value.version : "unknown",
        packageRevision:
          typeof value.gitHead === "string" ? value.gitHead : null,
      };
    } catch {
      // Metadata may be absent in an embedded host; it cannot block execution.
    }
  }
  return { runtimeVersion: "unknown", packageRevision: null };
}

/** Best-effort, content-free diagnostics must never change a control result. */
export function traceRequestControl(
  scope: string,
  event: string,
  fields: RequestControlDiagnosticFields = {},
): void {
  try {
    packageIdentity ??= readPackageIdentity();
    traceDebug(scope, event, {
      ...packageIdentity,
      pid: process.pid,
      processInstanceId,
      ...fields,
    });
  } catch {
    // Includes synchronous serialization/console failures; disk writes are best effort.
  }
}
