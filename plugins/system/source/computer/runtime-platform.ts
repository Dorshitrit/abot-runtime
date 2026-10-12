import { failureResult } from "../../../../src/plugin-sdk/index.js";

/** Windows desktop images and input await the separate OCR rollout. */
export function supportsRuntimeDesktopTools(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

export function unboundComputerFailure() {
  if (!supportsRuntimeDesktopTools())
    return failureResult({
      errorCode: "computer_runtime_platform_unsupported",
      message: "Desktop observation and control are unavailable on Windows Runtime. System commands and applications remain available.",
    });
  return failureResult({
    errorCode: "computer_request_binding_required",
    message: "Computer control requires a prepared request.",
  });
}
