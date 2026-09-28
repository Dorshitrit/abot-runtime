import type { SystemTarget } from "../contracts.js";
import type { NativeComputerBackend } from "./native-protocol.js";
import { createWindowsComputerBackend } from "./windows-backend.js";
import { createMacosComputerBackend } from "./macos-backend.js";
import { createLinuxComputerBackend } from "./linux-backend.js";

export function createNativeComputerBackend(
  target: SystemTarget,
): NativeComputerBackend {
  if (target.id === "windows") return createWindowsComputerBackend(target);
  if (target.id === "macos") return createMacosComputerBackend(target);
  return createLinuxComputerBackend(target);
}
