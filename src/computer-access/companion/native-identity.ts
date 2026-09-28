import { homedir, hostname, userInfo } from "node:os";
import { isHostIdentity, type HostIdentity } from "./protocol.js";

export function readNativeHostIdentity(): HostIdentity {
  const os = nativeOperatingSystem(process.platform);
  const identity = {
    name: hostname(),
    os,
    user: userInfo().username,
    homeDir: homedir(),
  };
  if (!isHostIdentity(identity))
    throw new Error(
      "The native user identity cannot be represented by the host protocol.",
    );
  return identity;
}

function nativeOperatingSystem(platform: NodeJS.Platform): HostIdentity["os"] {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  throw new Error(
    "This operating system is not supported by the host companion.",
  );
}
