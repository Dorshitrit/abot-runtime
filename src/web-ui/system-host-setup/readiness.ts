import {
  observeSystemHost,
  readSystemHostFacts,
  type SystemHostFacts,
} from "../../../plugins/system/source/host-observation.js";
import { resolveSystemTarget } from "../../../plugins/system/source/targets.js";
import type { HostStatus } from "../../../plugins/system/source/companion/protocol.js";

export type HostSetupPlatform = "windows" | "macos";
export type HostReadiness = Readonly<{
  ready: boolean;
  route: "native" | "wsl_interop" | "companion" | "setup_required";
  environment: "native" | "wsl" | "container";
  platforms: readonly HostSetupPlatform[];
  restartRequired: boolean;
  distribution?: string;
  message?: string;
}>;

function classifyHostEnvironment(facts: SystemHostFacts): HostReadiness["environment"] {
  const observed = observeSystemHost(facts);
  if (observed.environment === "container") return "container";
  if (observed.environment === "wsl_guest") return "wsl";
  return "native";
}

export async function readHostReadiness(
  status: HostStatus,
  dependencies: {
    facts?: SystemHostFacts;
    distribution?: string;
    resolveTarget?: typeof resolveSystemTarget;
  } = {},
): Promise<HostReadiness> {
  const facts = dependencies.facts ?? readSystemHostFacts();
  const observed = observeSystemHost(facts);
  const environment = classifyHostEnvironment(facts);
  if (status.paired) return {
    ready: status.connected,
    route: "companion",
    environment,
    platforms: [],
    restartRequired: false,
    message: status.connected
      ? "Connected computer is ready."
      : "The paired computer is offline. Sign in on that computer to reconnect.",
  };
  if (environment === "container") return {
    ready: false,
    route: "setup_required",
    environment,
    platforms: ["windows", "macos"],
    restartRequired: false,
    message: "Install the connection on the Windows or Mac computer running Docker.",
  };
  const target = environment === "wsl" ? "windows" : observed.runtimeOs;
  const resolveTarget = dependencies.resolveTarget ?? resolveSystemTarget;
  try {
    if (target === "unsupported") throw new Error("unsupported_native_platform");
    await resolveTarget(target);
    return {
      ready: true,
      route: environment === "wsl" ? "wsl_interop" : "native",
      environment,
      platforms: [],
      restartRequired: false,
      message: "Direct system access is ready. No additional installation is needed.",
    };
  } catch {
    if (environment === "wsl") return {
      ready: false,
      route: "setup_required",
      environment,
      platforms: ["windows"],
      restartRequired: true,
      distribution: dependencies.distribution ?? process.env.WSL_DISTRO_NAME,
      message: "Windows interop is unavailable. Open the Windows setup script. It enables access and automatically restarts the selected WSL distribution, interrupting its running services.",
    };
    return {
      ready: false,
      route: "setup_required",
      environment,
      platforms: [],
      restartRequired: false,
      message: "The native execution target is unavailable. Restore the operating system shell, then refresh status.",
    };
  }
}
