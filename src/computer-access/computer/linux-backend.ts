import type { SystemTarget } from "../contracts.js";
import type { NativeComputerBackend } from "./native-protocol.js";
import { createUnixNativeProcess } from "./unix-native-process.js";
import { unavailableUnixDesktop } from "./unix-native-results.js";
import { LINUX_COMPUTER_HELPER } from "./linux-helper.js";

export function createLinuxComputerBackend(
  target: SystemTarget,
): NativeComputerBackend {
  if (target.id !== "linux" || target.transport !== "native") {
    return {
      execute: async () =>
        unavailableUnixDesktop("linux", "computer_native_target_required"),
      close: async () => {},
    };
  }
  return createUnixNativeProcess({
    platform: "linux",
    file: "python3",
    args: ["-u", "-c", LINUX_COMPUTER_HELPER],
  });
}
