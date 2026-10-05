import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { prepareMacPermissions } from "../../computer-access/companion/native-permissions.js";
import { resolveSystemTarget } from "../../computer-access/targets.js";
import { readNativePermissionInput, type NativePermissionStatus, type NativePermissionResult } from "../../computer-access/native-permission-contract.js";
import type { LocalRuntimePeer } from "./contracts.js";

export function isLocalNativePermissionMethod(method: string): boolean {
  if (method === "nativePermissions.status") return true;
  return method === "nativePermissions.prepare";
}

/** Runs beside the native SYSTEM executor, even when Web is only an attached client. */
export class LocalNativePermissions {
  private readonly ownerId = randomUUID();
  private active?: AbortController;
  private stopped = false;
  constructor(private readonly dependencies: {
    platform?: string;
    prepare?: typeof prepareMacPermissions;
    resolveTarget?: typeof resolveSystemTarget;
  } = {}) {}

  async status(): Promise<NativePermissionStatus> {
    if (this.stopped) return { available: false, reason: "runtime_owner_unavailable" };
    if ((this.dependencies.platform ?? process.platform) !== "darwin")
      return { available: false, reason: "native_macos_unavailable" };
    try {
      const target = await (this.dependencies.resolveTarget ?? resolveSystemTarget)("macos");
      if (target.transport !== "native") return { available: false, reason: "native_macos_unavailable" };
    } catch { return { available: false, reason: "native_macos_unavailable" }; }
    if (this.stopped) return { available: false, reason: "runtime_owner_unavailable" };
    return { available: true, ownerId: this.ownerId, computerName: hostname(), executablePath: process.execPath };
  }

  async call(method: string, args: readonly unknown[], peer: LocalRuntimePeer): Promise<unknown> {
    if (method === "nativePermissions.status" && args.length === 0) return this.status();
    if (method !== "nativePermissions.prepare") throw new Error("local_runtime_method_unknown");
    if (args.length !== 1) throw new Error("macos_permissions_input_invalid");
    const input = readNativePermissionInput(args[0]);
    if (!input) throw new Error("macos_permissions_input_invalid");
    if (input.ownerId !== this.ownerId) throw new Error("macos_permissions_owner_changed");
    if (!(await this.status()).available) throw new Error("macos_permissions_owner_unavailable");
    if (this.stopped) throw new Error("macos_permissions_owner_unavailable");
    if (this.active) throw new Error("macos_permissions_busy");
    const stop = new AbortController();
    this.active = stop;
    const disconnect = peer.onClose(() => stop.abort());
    const deadline = setTimeout(() => stop.abort(), 50_000);
    try {
      stop.signal.throwIfAborted();
      const { ownerId, ...action } = input;
      const result = await (this.dependencies.prepare ?? prepareMacPermissions)(action, stop.signal);
      stop.signal.throwIfAborted();
      return { ...result, ownerId } satisfies NativePermissionResult;
    } finally {
      clearTimeout(deadline);
      disconnect();
      this.active = undefined;
    }
  }

  stop(): void {
    this.stopped = true;
    this.active?.abort();
  }
}
