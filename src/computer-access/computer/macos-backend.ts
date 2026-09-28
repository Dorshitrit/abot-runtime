import type { SystemTarget } from "../contracts.js";
import type { NativeComputerBackend } from "./native-protocol.js";
import { createUnixNativeProcess } from "./unix-native-process.js";
import { unavailableUnixDesktop } from "./unix-native-results.js";
import { MACOS_COMPUTER_HELPER } from "./macos-helper.js";
import { missingMacosComputerPrerequisite } from "./macos-prerequisites.js";

export function createMacosComputerBackend(
  target: SystemTarget,
): NativeComputerBackend {
  if (target.id !== "macos" || target.transport !== "native") {
    return {
      execute: async () =>
        unavailableUnixDesktop("macos", "computer_native_target_required"),
      close: async () => {},
    };
  }
  const native = createUnixNativeProcess({
    platform: "macos",
    file: "/usr/bin/swift",
    args: ["-swift-version", "5", "-e", MACOS_COMPUTER_HELPER],
  });
  let prerequisites: Promise<string | undefined> | undefined;
  return {
    async execute(request, signal) {
      prerequisites ??= missingMacosComputerPrerequisite();
      const reason = await prerequisites;
      if (reason) return unavailableUnixDesktop("macos", reason);
      return native.execute(request, signal);
    },
    close: () => native.close(),
  };
}
