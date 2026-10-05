import { randomUUID } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { LocalNativePermissions } from "../../local-host/app-native-permissions.js";
import { createLocalNativePermissionClient } from "../../local-host/client-native-permissions.js";
import { isNativePermissionStatus } from "../../../computer-access/native-permission-contract.js";
import type { LocalRuntimePeer } from "../../local-host/contracts.js";
import type { MacPermissionAction } from "../../../computer-access/companion/permission-protocol.js";

const result = { permissions: { screenRecording: "required", accessibility: "granted" } as const,
  executablePath: "/private/runtime/node", restartMayBeRequired: false };
function fixture() {
  const listeners = new Set<() => void>();
  const peer: LocalRuntimePeer = { id: randomUUID(), callClient: async () => undefined,
    onClose(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const prepare = vi.fn(async (_action: MacPermissionAction, _signal?: AbortSignal) => result);
  const owner = new LocalNativePermissions({ platform: "darwin", prepare,
    resolveTarget: async () => ({ id: "macos", transport: "native", shell: "/bin/bash" }) });
  return { owner, prepare, peer, disconnect: () => { for (const listener of listeners) listener(); } };
}
afterEach(() => vi.useRealTimers());

test("status reads the owner route and identity without checking permissions or invoking Swift", async () => {
  const { owner, prepare } = fixture();
  const status = await owner.status();
  expect(status).toMatchObject({ available: true, ownerId: expect.any(String), executablePath: process.execPath });
  expect(await owner.status()).toEqual(status);
  expect(prepare).not.toHaveBeenCalled();
  expect(await new LocalNativePermissions({ platform: "linux", prepare }).status()).toEqual({ available: false, reason: "native_macos_unavailable" });
  expect(prepare).not.toHaveBeenCalled();
});

test("only exact RPC methods and current owner inputs can reach the permission executor", async () => {
  const { owner, prepare, peer } = fixture();
  const status = await owner.status();
  if (!status.available) throw new Error("fixture unavailable");
  for (const method of ["nativePermissions.execute", "nativePermissions.prepare.extra", "system_command"])
    await expect(owner.call(method, [], peer)).rejects.toThrow("local_runtime_method_unknown");
  await expect(owner.call("nativePermissions.status", ["extra"], peer)).rejects.toThrow();
  await expect(owner.call("nativePermissions.prepare", [{ ownerId: randomUUID(), action: "check" }], peer)).rejects.toThrow("macos_permissions_owner_changed");
  await expect(owner.call("nativePermissions.prepare", [{ ownerId: status.ownerId, action: "check", command: "extra" }], peer)).rejects.toThrow("macos_permissions_input_invalid");
  expect(prepare).not.toHaveBeenCalled();
  expect(await owner.call("nativePermissions.prepare", [{ ownerId: status.ownerId, action: "check" }], peer)).toEqual({ ...result, ownerId: status.ownerId });
  expect(prepare).toHaveBeenCalledOnce();
});

test.each(["stop", "disconnect"])("%s aborts the owner helper and never reports a stale grant", async (action) => {
  const { owner, prepare, peer, disconnect } = fixture();
  let settle!: () => void;
  let signal: AbortSignal | undefined;
  prepare.mockImplementationOnce(async (_action?: unknown, executionSignal?: AbortSignal) => {
    signal = executionSignal;
    await new Promise<void>((resolve) => { settle = resolve; });
    return result;
  });
  const status = await owner.status();
  if (!status.available) throw new Error("fixture unavailable");
  const input = { ownerId: status.ownerId, action: "check" };
  const pending = owner.call("nativePermissions.prepare", [input], peer);
  const failed = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
  await expect(owner.call("nativePermissions.prepare", [input], peer)).rejects.toThrow("macos_permissions_busy");
  if (action === "stop") owner.stop();
  else disconnect();
  expect(signal?.aborted).toBe(true);
  settle();
  await failed;
  if (action === "stop") expect((await owner.status()).available).toBe(false);
});

test("an owner stopped after status resolves rejects preparation before native effects", async () => {
  const { owner, prepare, peer } = fixture();
  const status = await owner.status();
  if (!status.available) throw new Error("fixture unavailable");
  vi.spyOn(owner, "status").mockImplementationOnce(async () => { queueMicrotask(() => owner.stop()); return status; });
  await expect(owner.call("nativePermissions.prepare", [{ ownerId: status.ownerId, action: "check" }], peer)).rejects.toThrow("macos_permissions_owner_unavailable");
  expect(prepare).not.toHaveBeenCalled();
});

test("old and unresponsive owners leave metadata unavailable without polling more RPC calls", async () => {
  vi.useFakeTimers();
  const call = vi.fn(async () => new Promise(() => {}));
  const client = createLocalNativePermissionClient(call);
  const first = client.status();
  await vi.advanceTimersByTimeAsync(2001);
  expect(await first).toEqual({ available: false, reason: "runtime_owner_unavailable" });
  const second = client.status();
  await vi.advanceTimersByTimeAsync(2001);
  expect(await second).toEqual({ available: false, reason: "runtime_owner_unavailable" });
  expect(call).toHaveBeenCalledOnce();
  const old = createLocalNativePermissionClient(async () => { throw new Error("local_runtime_method_unknown"); });
  expect((await old.status()).available).toBe(false);
});

test("a response for another owner or malformed identity is not displayed as native ready", async () => {
  const ownerId = randomUUID();
  const client = createLocalNativePermissionClient(async () => ({ ...result, ownerId: randomUUID() }));
  await expect(client.prepare({ ownerId, action: "check" })).rejects.toThrow("macos_permissions_owner_changed");
  expect(isNativePermissionStatus({ available: true, ownerId, computerName: "Mac\nSpoofed", executablePath: "/bin/node" })).toBe(false);
  expect(isNativePermissionStatus({ available: true, ownerId, computerName: "Mac", executablePath: "/bin/node\u0000" })).toBe(false);
});
