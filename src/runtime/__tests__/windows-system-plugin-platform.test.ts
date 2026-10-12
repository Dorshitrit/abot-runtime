import { afterEach, expect, test, vi } from "vitest";
import { prepareComputerModules, unboundComputerHandlers } from "../../../plugins/system/source/computer/request-modules.js";
import { supportsRuntimeDesktopTools } from "../../../plugins/system/source/computer/runtime-platform.js";
import { COMPUTER_TOOLS } from "../../../plugins/system/source/computer/handlers.js";
import { HOST_OPERATIONS } from "../../computer-access/companion/protocol.js";
import { selectedSystemModules, systemRequestPluginFixture } from "./support/system-request-plugin-fixture.js";
import { computerRoute } from "./computer-plugin-fixtures.js";

const allTools = [...HOST_OPERATIONS, ...COMPUTER_TOOLS];
afterEach(() => vi.unstubAllGlobals());
function runtimePlatform(platform: NodeJS.Platform) { vi.stubGlobal("process", { ...process, platform }); }

test.each([false, true])("Windows Runtime exposes native commands and apps without desktop tools; paired=%s", async (paired) => {
  runtimePlatform("win32");
  const native = { id: "windows" as const, transport: "native" as const, shell: "C:\\Windows\\powershell.exe" };
  const f = systemRequestPluginFixture([native]);
  if (!paired) f.readHostStatus.mockResolvedValue({ paired: false, connected: false });
  const selected = selectedSystemModules(allTools);
  const prepared = await f.prepare(allTools);
  expect(prepared.map(module => module.definition.name).sort()).toEqual([...HOST_OPERATIONS].sort());
  for (const module of prepared) {
    const original = selected.find(candidate => candidate.definition.name === module.definition.name)!;
    expect(module.definition).toEqual(original.definition);
    expect(module.normalInvocation.operations.map(({ effect, approval }) => ({ effect, approval })))
      .toEqual(original.normalInvocation.operations.map(({ effect, approval }) => ({ effect, approval })));
  }
  const command = prepared.find(module => module.definition.name === "system_command")!;
  await command.implementation({ target: "windows", cwd: "C:\\", command: "Write-Output fixture" });
  expect(f.native).toHaveBeenCalledOnce();
  expect(f.resolvedNativeTargets).toEqual([native]);
  expect(f.executeHostOperation).not.toHaveBeenCalled();
});

test("Windows desktop preparation creates no bindings or continuation state, and direct handlers refuse", async () => {
  runtimePlatform("win32");
  const requestState = { read: vi.fn(), register: vi.fn() };
  const connection = { readHostStatus: vi.fn(), executeHostOperation: vi.fn() };
  const prepared = prepareComputerModules("/fixture", selectedSystemModules(COMPUTER_TOOLS),
    [computerRoute], connection, { requestState } as never);
  expect(prepared).toEqual([]);
  expect(requestState.read).not.toHaveBeenCalled();
  expect(requestState.register).not.toHaveBeenCalled();
  for (const handler of Object.values(unboundComputerHandlers()))
    expect(await handler({})).toMatchObject({ ok: false, errorCode: "computer_runtime_platform_unsupported" });
  expect(connection.executeHostOperation).not.toHaveBeenCalled();
});

test.each(["linux", "darwin"] as const)("%s Runtime preserves desktop tools and a paired Windows route", async platform => {
  runtimePlatform(platform);
  expect(supportsRuntimeDesktopTools()).toBe(true);
  const native = platform === "darwin"
    ? { id: "macos" as const, transport: "native" as const, shell: "/bin/bash" }
    : { id: "linux" as const, transport: "native" as const, shell: "/bin/bash" };
  const f = systemRequestPluginFixture([native]);
  const prepared = await f.prepare(allTools);
  expect(prepared.map(module => module.definition.name).sort()).toEqual([...allTools].sort());
  const observe = prepared.find(module => module.definition.name === "computer_observe")!;
  expect(observe.normalInvocation.operations[0]!.input.properties.desktop_ref)
    .toEqual({ type: "string", enum: [expect.any(String), expect.any(String)] });
  const applications = prepared.find(module => module.definition.name === "system_applications")!;
  await applications.implementation({ target: "windows" });
  expect(f.executeHostOperation).toHaveBeenCalledOnce();
  expect(f.native).not.toHaveBeenCalled();
  expect(await unboundComputerHandlers().computer_observe!({}))
    .toMatchObject({ errorCode: "computer_request_binding_required" });
});
