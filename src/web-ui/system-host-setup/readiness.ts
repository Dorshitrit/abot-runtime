import {
  observeSystemHost,
  readSystemHostFacts,
  type SystemHostFacts,
} from "../../computer-access/host-observation.js";
import { resolveSystemTarget } from "../../computer-access/targets.js";
import type { HostStatus } from "../../computer-access/companion/protocol.js";
import { OBSERVATION_CAPABILITY } from "../../computer-access/companion/observation-protocol.js";
import { COMPUTER_CAPABILITY } from "../../computer-access/computer/native-validation.js";

export type HostSetupPlatform = "windows" | "macos" | "linux";
export type HostReadiness = Readonly<{
  ready: boolean;
  route: "native" | "wsl_interop" | "companion" | "setup_required";
  environment: "native" | "wsl" | "container";
  platforms: readonly HostSetupPlatform[];
  restartRequired: boolean;
  companionUpdateRequired?: boolean;
  directAccessReady?: boolean;
  localSetupAvailable?: boolean;
  localComputerName?: string;
  distribution?: string;
  message?: string;
}>;

function classifyHostEnvironment(
  facts: SystemHostFacts,
): HostReadiness["environment"] {
  const observed = observeSystemHost(facts);
  if (observed.environment === "container") return "container";
  if (observed.environment === "wsl_guest") return "wsl";
  return "native";
}

function isCompanionComputerControlReady(status: HostStatus): boolean {
  if (!status.connected) return false;
  if (status.companion?.updateAvailable) return false;
  if (!status.capabilities?.includes(OBSERVATION_CAPABILITY)) return false;
  return status.capabilities.includes(COMPUTER_CAPABILITY);
}

function isCompanionNewerThanRuntime(status: HostStatus): boolean {
  const release = status.companion;
  if (!release?.installedVersion) return false;
  return release.installedVersion > release.availableVersion;
}

function readPairedCompanionReadiness(
  status: HostStatus,
  environment: HostReadiness["environment"],
): HostReadiness {
  const base = {
    route: "companion" as const,
    environment,
    platforms: [],
    restartRequired: false,
  };
  if (isCompanionComputerControlReady(status))
    return { ...base, ready: true, message: "Connected computer is ready." };
  if (isCompanionNewerThanRuntime(status))
    return {
      ...base,
      ready: false,
      message:
        "This companion is newer than this Runtime. Update ABot before setting up computer access again.",
    };
  if (!status.connected)
    return {
      ...base,
      ready: false,
      companionUpdateRequired: true,
      platforms: status.identity ? [status.identity.os] : [],
      message:
        "The paired computer is offline. Sign in to reconnect, or use Computer access setup to repair its connection. Your existing pairing is kept.",
    };
  return {
    ...base,
    ready: false,
    companionUpdateRequired: true,
    platforms: status.identity ? [status.identity.os] : [],
    message:
      status.companion?.updateAvailable === false
        ? "Reinstall this computer's connection for computer tools and background collection. Your existing pairing is kept."
        : "Update this computer's connection for computer tools and background collection. Your existing pairing is kept.",
  };
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
  if (status.paired) return readPairedCompanionReadiness(status, environment);
  if (environment === "container")
    return {
      ready: false,
      route: "setup_required",
      environment,
      platforms: ["windows", "macos", "linux"],
      restartRequired: false,
      message:
        "Install the connection on the Windows, Mac or Linux computer running Docker.",
    };
  const target = environment === "wsl" ? "windows" : observed.runtimeOs;
  const resolveTarget = dependencies.resolveTarget ?? resolveSystemTarget;
  let directAccessReady = false;
  try {
    if (target !== "unsupported") {
      await resolveTarget(target);
      directAccessReady = true;
    }
  } catch {
    // The shared companion also serves hosts without native shell/WSL interop.
  }
  return {
    ready: false,
    route: "setup_required",
    environment,
    platforms: target === "unsupported" ? [] : [target],
    restartRequired: false,
    directAccessReady,
    message: directAccessReady
      ? "Direct commands are available. Set up Computer access once to also connect desktop tools and ABot Spark."
      : "Set up Computer access once for desktop tools and ABot Spark. The connection does not require WSL interop or a WSL restart.",
  };
}
