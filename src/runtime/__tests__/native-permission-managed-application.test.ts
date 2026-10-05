import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
const prepare = vi.hoisted(() => vi.fn(async () => ({
  permissions: { screenRecording: "required", accessibility: "granted" } as const,
  executablePath: process.execPath, restartMayBeRequired: false,
})));
vi.mock("../local-host/app-native-permissions.js", async (load) => {
  const actual = await load<typeof import("../local-host/app-native-permissions.js")>();
  return { ...actual, LocalNativePermissions: class extends actual.LocalNativePermissions {
    constructor() { super({ platform: "darwin", prepare,
      resolveTarget: async () => ({ id: "macos", transport: "native", shell: "/bin/bash" }) }); }
  } };
});
import { createLocalRuntimeApplication } from "../local-application.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";

test("managed permission reads and requests cannot elect or start a missing Runtime owner", async () => {
  const fixture = await createSchedulerRuntimeFixture();
  const application = createLocalRuntimeApplication(fixture.config);
  try {
    expect((await application.nativePermissions.status()).available).toBe(false);
    await expect(application.nativePermissions.prepare({ ownerId: randomUUID(), action: "check" })).rejects.toThrow("local_runtime_not_started");
    expect(application.getOwnership()).toBeUndefined();
    expect(prepare).not.toHaveBeenCalled();
  } finally { await application.stop(); await fixture.dispose(); }
});

test("managed facade reaches the application owner's permission handler and preserves its identity for attached clients", async () => {
  const fixture = await createSchedulerRuntimeFixture();
  await fixture.application.stop();
  const owner = createLocalRuntimeApplication(fixture.config);
  const client = createLocalRuntimeApplication(fixture.config);
  try {
    await owner.start();
    await client.start();
    expect(owner.getOwnership()).toBe("owner");
    expect(client.getOwnership()).toBe("client");
    const status = await client.nativePermissions.status();
    if (!status.available) throw new Error("fixture unavailable");
    expect(await owner.nativePermissions.status()).toEqual(status);
    expect(await client.nativePermissions.prepare({ ownerId: status.ownerId, action: "check" })).toMatchObject({
      ownerId: status.ownerId, permissions: { screenRecording: "required", accessibility: "granted" },
    });
    expect(prepare).toHaveBeenCalledExactlyOnceWith({ action: "check" }, expect.any(AbortSignal));
  } finally { await client.stop(); await owner.stop(); await fixture.dispose(); }
});
