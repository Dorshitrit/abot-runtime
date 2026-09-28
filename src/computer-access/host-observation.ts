import { existsSync } from "node:fs";
import { release } from "node:os";
import type { SystemTargetId } from "./contracts.js";

export type SystemHostFacts = Readonly<{
  platform: NodeJS.Platform;
  kernelRelease: string;
  containerMarker?: boolean;
}>;

export function readSystemHostFacts(): SystemHostFacts {
  return {
    platform: process.platform,
    kernelRelease: release(),
    containerMarker: hasSystemContainerMarker(),
  };
}

function hasSystemContainerMarker(): boolean {
  if (existsSync("/.dockerenv")) return true;
  return existsSync("/run/.containerenv");
}

function isContainerHostRuntime(facts: SystemHostFacts): boolean {
  if (facts.platform !== "linux") return false;
  return facts.containerMarker === true;
}

export function isWslHostRuntime(facts: SystemHostFacts): boolean {
  if (facts.platform !== "linux") return false;
  if (isContainerHostRuntime(facts)) return false;
  return /microsoft/iu.test(facts.kernelRelease);
}

function runtimeOs(platform: NodeJS.Platform): SystemTargetId | "unsupported" {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  return "unsupported";
}

export function observeSystemHost(
  facts: SystemHostFacts = readSystemHostFacts(),
) {
  const runtime = runtimeOs(facts.platform);
  if (isContainerHostRuntime(facts)) return {
    runtimeOs: runtime,
    kernelRelease: facts.kernelRelease,
    environment: "container",
    inferredHostOs: "unknown",
    hostInferenceSource: "container_marker",
    windowsExecutionRequiresProbe: false,
    guiSessionStatus: "not_checked",
  } as const;
  const wsl = isWslHostRuntime(facts);
  const inferredHostOs = wsl ? "windows" : runtime;
  return {
    runtimeOs: runtime,
    kernelRelease: facts.kernelRelease,
    environment: wsl ? "wsl_guest" : "not_identified_as_wsl",
    inferredHostOs,
    hostInferenceSource: wsl ? "wsl_kernel_signature" : "runtime_platform_only",
    windowsExecutionRequiresProbe: inferredHostOs === "windows",
    guiSessionStatus: "not_checked",
  } as const;
}
