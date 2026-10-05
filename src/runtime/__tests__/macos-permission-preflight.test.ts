import { expect, test, vi } from "vitest";
import { createNativePermissionHandlers, prepareMacPermissions } from "../../computer-access/companion/native-permissions.js";
import { MACOS_PERMISSION_HELPER } from "../../computer-access/computer/macos-permission-helper.js";
import { isMacPermissionAction, readMacPermissionResult } from "../../computer-access/companion/permission-protocol.js";
import { isHostOperation, isHostWireOperation } from "../../computer-access/companion/protocol.js";
import { runHostPermissionsCli } from "../../cli/host-permissions.js";

const permissions = { screenRecording: "granted", accessibility: "required" } as const;
const result = { permissions, executablePath: "/private/runtime/node", restartMayBeRequired: false };

test("permission preparation is transport control, not a model SYSTEM operation", () => {
  expect(isHostWireOperation("macos_permissions")).toBe(true);
  expect(isHostOperation("macos_permissions")).toBe(false);
  expect(createNativePermissionHandlers("windows")).toEqual({});
  expect(createNativePermissionHandlers("linux")).toEqual({});
});

test.each([
  {}, { action: "request" }, { action: "check", permission: "accessibility" },
  { action: "request", permission: "anything" }, { action: "check", command: "arbitrary" },
])("rejects malformed permission actions %#", (input) => {
  expect(isMacPermissionAction(input)).toBe(false);
});

test("strict permission status drops unrelated result data and refuses invalid subjects", () => {
  expect(readMacPermissionResult({ ...result, windowTitle: "must not leak" })).toEqual(result);
  expect(readMacPermissionResult({ ...result, permissions: { ...permissions, pixels: "secret" } })).toBeUndefined();
  expect(readMacPermissionResult({ ...result, executablePath: "relative/node" })).toBeUndefined();
  expect(readMacPermissionResult({ ...result, permissions: { ...permissions, accessibility: "denied" } })).toBeUndefined();
  expect(readMacPermissionResult({ ...result, permissions: { ...permissions, screenRecording: ["granted"] } })).toBeUndefined();
  expect(readMacPermissionResult({ ...result, permissions: { ...permissions, screenRecording: {} } })).toBeUndefined();
});

test("check uses the permission-only helper under the caller and bounded process options", async () => {
  const execute = vi.fn(async () => ({ stdout: JSON.stringify(permissions), stderr: "" }));
  const prerequisite = vi.fn(async () => undefined);
  const signal = new AbortController().signal;
  const observed = await prepareMacPermissions({ action: "check" }, signal, {
    platform: "darwin", prerequisite, execute,
  });
  expect(observed).toEqual({ ...result, executablePath: process.execPath });
  expect(prerequisite).toHaveBeenCalledOnce();
  expect(execute).toHaveBeenCalledWith("/usr/bin/swift", ["-swift-version", "5", "-e", MACOS_PERMISSION_HELPER, "check"], {
    timeout: 45_000, maxBuffer: 16_384, encoding: "utf8", signal,
  });
});

test("missing native prerequisites never launch Swift or its developer installer", async () => {
  const execute = vi.fn();
  await expect(prepareMacPermissions({ action: "check" }, undefined, {
    platform: "darwin", execute,
    prerequisite: async () => "macos_swift_developer_tools_required",
  })).rejects.toThrow("macos_swift_developer_tools_required");
  expect(execute).not.toHaveBeenCalled();
});

test("non-Mac and aborted checks never run a native permission helper", async () => {
  const execute = vi.fn();
  await expect(prepareMacPermissions({ action: "check" }, undefined, {
    platform: "linux", execute,
  })).rejects.toThrow("macos_permissions_platform_required");
  await expect(prepareMacPermissions({ action: "check" }, AbortSignal.abort(), {
    platform: "darwin", execute,
  })).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
});

test("native transport rejects extra parameters before any prompt and forwards exact requested permission", async () => {
  const prepare = vi.fn(async () => result);
  const handler = createNativePermissionHandlers("macos", prepare).macos_permissions!;
  expect(await handler({ target: "macos", action: "check", command: "unused" })).toMatchObject({ ok: false });
  expect(prepare).not.toHaveBeenCalled();
  const signal = new AbortController().signal;
  expect(await handler({ target: "macos", action: "request", permission: "accessibility" }, { abortSignal: signal })).toMatchObject({ ok: true, data: result });
  expect(prepare).toHaveBeenCalledWith({ action: "request", permission: "accessibility" }, signal);
});

test("helper diagnostics never expose native paths or stderr to the browser", async () => {
  const handler = createNativePermissionHandlers("macos", async () => {
    throw new Error("compiler secret /private/user/location");
  }).macos_permissions!;
  const output = await handler({ target: "macos", action: "check" });
  expect(output).toMatchObject({ ok: false, errorCode: "macos_permissions_check_failed" });
  expect(JSON.stringify(output)).not.toContain("/private/user/location");
});

test.each([
  [[], { action: "check" }],
  [["--request", "screen-recording"], { action: "request", permission: "screen_recording" }],
  [["--request", "accessibility"], { action: "request", permission: "accessibility" }],
] as const)("CLI prepares permissions for only its caller %#", async (args, action) => {
  const prepare = vi.fn(async () => result);
  const print = vi.fn();
  await runHostPermissionsCli(args, { prepare, print, platform: "darwin" });
  expect(prepare).toHaveBeenCalledWith(action);
  expect(JSON.parse(print.mock.calls[0]![0])).toMatchObject({ scope: "calling_application", ...result });
});

test("CLI rejects unknown arguments and non-Mac invocations before effects", async () => {
  const prepare = vi.fn();
  await expect(runHostPermissionsCli(["--request", "anything"], { prepare, platform: "darwin" })).rejects.toThrow("Usage:");
  await expect(runHostPermissionsCli([], { prepare, platform: "linux" })).rejects.toThrow("only on macOS");
  expect(prepare).not.toHaveBeenCalled();
});
