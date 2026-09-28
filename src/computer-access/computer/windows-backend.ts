import type { SystemTarget } from "../contracts.js";
import type { NativeComputerBackend, NativeComputerRequest, NativeComputerResult } from "./native-protocol.js";
import { readNativeComputerRequest } from "./native-validation.js";
import { runWindowsComputerHelper } from "./windows-helper-process.js";
import { WINDOWS_COMPUTER_SOURCE } from "./windows-helper-script.js";
import { decodeWindowsComputerResult, windowsHelperUnavailable } from "./windows-result.js";

/** Native Windows and WSL interop use the same target-owned PowerShell executable. */
export function createWindowsComputerBackend(
  target: SystemTarget,
  dependencies: { runHelper?: typeof runWindowsComputerHelper } = {},
): NativeComputerBackend {
  if (target.id !== "windows") throw new Error("Windows backend requires a Windows target.");
  const runHelper = dependencies.runHelper ?? runWindowsComputerHelper;
  const active = new Map<AbortController, Promise<NativeComputerResult>>();
  let closed = false;
  return {
    async execute(request, signal) {
      if (closed) return windowsHelperUnavailable(request, "computer_backend_closed", false);
      if (signal?.aborted) return windowsHelperUnavailable(request, "computer_helper_aborted", false);
      let validated: NativeComputerRequest;
      try { validated = readNativeComputerRequest(request); }
      catch { return windowsHelperUnavailable(request, "computer_input_invalid", false); }
      if (validated.operation === "act" && validated.deadlineEpochMs <= Date.now())
        return windowsHelperUnavailable(validated, "computer_action_expired", false);
      const controller = new AbortController();
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const pending = runHelper({
        executable: target.shell,
        source: WINDOWS_COMPUTER_SOURCE,
        request: validated,
        signal: combined,
      }).then((result) => decodeWindowsComputerResult(result, validated));
      active.set(controller, pending);
      try { return await pending; }
      finally { active.delete(controller); }
    },
    async close() {
      closed = true;
      for (const controller of active.keys()) controller.abort();
      await Promise.allSettled(active.values());
    },
  };
}
