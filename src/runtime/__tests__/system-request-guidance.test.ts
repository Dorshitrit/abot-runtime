import { expect, test, vi } from "vitest";
import {
  projectSystemCommandTargets,
  systemCommandGuidance,
  systemRequestTargetGuidance,
} from "../../../plugins/system/source/system-command-guidance.js";
import {
  computerActionGuidance,
  wholeNotchScrollTargets,
} from "../../../plugins/system/source/computer/action-guidance.js";
import type { SystemTargetSnapshot } from "../../../plugins/system/source/request-target-snapshot.js";
import type { ToolModuleDeclaration } from "../../plugin-sdk/index.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { createRegisteredToolNormalInvocationExecutor } from "../adapters/registered-tool-normal-invocations.js";
import {
  selectedSystemModules,
  systemRequestPluginFixture,
} from "./support/system-request-plugin-fixture.js";

const nativeRoutes = [
  { kind: "native", target: { id: "linux", transport: "native", shell: "/private/linux-shell" } },
  { kind: "native", target: { id: "macos", transport: "native", shell: "/private/mac-shell" } },
  { kind: "native", target: { id: "windows", transport: "native", shell: "C:\\private\\shell.exe" } },
] as const satisfies SystemTargetSnapshot;
const interopRoute = {
  kind: "native",
  target: { id: "windows", transport: "wsl_interop", shell: "/private/interop.exe" },
} as const;
const companionRoute = {
  kind: "companion",
  target: "windows",
  hostId: "fixture-host",
  connectionId: "fixture-connection",
  identity: { name: "Private host", os: "windows", user: "private-user", homeDir: "C:\\private" },
} as const;

test("command facts follow the captured route and the installed cwd adapter", () => {
  expect(projectSystemCommandTargets(nativeRoutes, false)).toEqual([
    { target: "linux", shell: "Bash", transport: "native", cwd: "absolute" },
    { target: "macos", shell: "Bash", transport: "native", cwd: "absolute" },
    { target: "windows", shell: "PowerShell", transport: "native", cwd: "absolute" },
  ]);
  expect(projectSystemCommandTargets(nativeRoutes, true)).toEqual([
    { target: "linux", shell: "Bash", transport: "native", cwd: "absolute" },
    { target: "macos", shell: "Bash", transport: "native", cwd: "absolute" },
    { target: "windows", shell: "PowerShell", transport: "native", cwd: "runtime_relative_or_absolute" },
  ]);
  expect(projectSystemCommandTargets([interopRoute, companionRoute], true)).toEqual([
    { target: "windows", shell: "PowerShell", transport: "wsl_interop", cwd: "absolute" },
    { target: "windows", shell: "PowerShell", transport: "host_companion", cwd: "absolute" },
  ]);
  expect(projectSystemCommandTargets([], true)).toEqual([]);
  const rendered = systemCommandGuidance([...nativeRoutes, companionRoute], true);
  for (const privateValue of ["/private", "C:\\private", "fixture-host", "fixture-connection", "Private host", "private-user"])
    expect(rendered).not.toContain(privateValue);
});

test("whole-notch scrolling follows offered platforms, including companion routes", () => {
  expect(wholeNotchScrollTargets([interopRoute, companionRoute])).toEqual([]);
  expect(wholeNotchScrollTargets([...nativeRoutes, nativeRoutes[0]])).toEqual(["linux", "macos"]);
  expect(wholeNotchScrollTargets([
    { ...companionRoute, target: "macos", identity: { ...companionRoute.identity, os: "macos" } },
  ])).toEqual(["macos"]);
  expect(computerActionGuidance("computer_click", nativeRoutes)).toBe("");
  expect(computerActionGuidance("computer_scroll", [interopRoute])).toBe("");
  expect(computerActionGuidance("computer_scroll", nativeRoutes)).not.toBe("");
});

test("non-command capabilities retain target availability without command route details", () => {
  const command = systemRequestTargetGuidance("system_command", nativeRoutes, true);
  expect(command).toBe(systemCommandGuidance(nativeRoutes, true));
  for (const name of ["system_targets", "system_applications", "system_launch"]) {
    const withoutResolver = systemRequestTargetGuidance(name, nativeRoutes, false);
    expect(systemRequestTargetGuidance(name, nativeRoutes, true)).toBe(withoutResolver);
    expect(withoutResolver).not.toBe(command);
    for (const { target } of nativeRoutes) expect(withoutResolver).toContain(target.id);
  }
});

test("command guidance fits the operation summary budget for every three-target route shape", () => {
  const operation = selectedSystemModules(["system_command"])[0]!.normalInvocation.operations[0]!;
  const companionRoutes = nativeRoutes.map(({ target }) => ({
    ...companionRoute,
    target: target.id,
    identity: { ...companionRoute.identity, os: target.id },
  }));
  for (const routes of [nativeRoutes, companionRoutes, [...nativeRoutes.slice(0, 2), interopRoute]]) {
    for (const hasResolver of [false, true])
      expect((operation.summary + systemCommandGuidance(routes, hasResolver)).length).toBeLessThanOrEqual(512);
  }
});

test("request projection adds only applicable guidance without probing or changing operation contracts", async () => {
  const names = ["system_command", "system_applications", "computer_act", "computer_observe"];
  const original = selectedSystemModules(names);
  const fixture = systemRequestPluginFixture(nativeRoutes.map(({ target }) => target));
  fixture.readHostStatus.mockResolvedValue({ paired: false, connected: false });
  const prepared = await fixture.prepare(names);
  const registry = createConfiguredToolRegistry(undefined, prepared);
  expect(registry.listNormalInvocations!()).toHaveLength(names.length);
  for (const module of prepared) {
    const source = original.find(({ definition }) => definition.name === module.definition.name)!;
    for (const operation of module.normalInvocation.operations) {
      const before = source.normalInvocation.operations.find(({ operationId }) => operationId === operation.operationId)!;
      const suffix = module.definition.name === "system_command"
        ? systemCommandGuidance(nativeRoutes, false)
        : computerActionGuidance(operation.operationId, nativeRoutes);
      if (module.definition.name.startsWith("computer_") || module.definition.name === "system_command")
        expect(operation.summary).toBe(before.summary + suffix);
      expect(operation.summary.length).toBeLessThanOrEqual(512);
      const { target: _target, desktop_ref: _desktop, ...other } = operation.input.properties;
      const { target: _beforeTarget, desktop_ref: _beforeDesktop, ...beforeOther } = before.input.properties;
      expect(other).toEqual(beforeOther);
      expect(operation.input.required).toEqual(before.input.required);
      expect(operation.fixedParams).toEqual(before.fixedParams);
      expect(operation.effect).toBe(before.effect);
      expect(operation.approval).toBe(before.approval);
    }
  }
  expect(fixture.observeTargets).toHaveBeenCalledOnce();
  expect(fixture.readHostStatus).toHaveBeenCalledOnce();
  expect(fixture.native).not.toHaveBeenCalled();
  expect(fixture.executeHostOperation).not.toHaveBeenCalled();
});

test("summary-only projection preserves a saved exact-action approval before dispatch", async () => {
  const fixture = systemRequestPluginFixture();
  fixture.readHostStatus.mockResolvedValue({ paired: false, connected: false });
  const current = await fixture.prepare(["system_command"]);
  const declared = selectedSystemModules(["system_command"])[0]!.normalInvocation.operations[0]!;
  const earlier = current.map((module) => ({
    ...module,
    normalInvocation: {
      ...module.normalInvocation,
      operations: module.normalInvocation.operations.map((operation) => ({
        ...operation,
        summary: declared.summary,
      })),
    },
  }));
  const execute = vi.fn(async () => { throw new Error("unexpected_dispatch"); });
  const executor = (modules: readonly ToolModuleDeclaration[]) => {
    const registry = createConfiguredToolRegistry(undefined, modules);
    return createRegisteredToolNormalInvocationExecutor({
      registrations: registry.listNormalInvocations!(),
      toolRegistry: { execute },
      requestId: "guidance-approval",
      abortSignal: new AbortController().signal,
      nextApprovalId: () => "guidance-approval-1",
      toolPermissionMode: "ask",
    });
  };
  const oldExecutor = executor(earlier);
  const prepared = await oldExecutor.prepare({
    handle: oldExecutor.operations[0]!.handle,
    controls: { target: "linux", command: "pwd", cwd: "/tmp" },
  });
  expect(prepared.status).toBe("prepared");
  if (prepared.status !== "prepared") throw new Error(prepared.code);
  const restored = await executor(current).restore(JSON.parse(JSON.stringify(prepared.snapshot)));
  expect(restored).toMatchObject({
    status: "prepared",
    actionFingerprint: prepared.actionFingerprint,
    approvalRequest: prepared.approvalRequest,
    acceptedControls: prepared.acceptedControls,
  });
  expect(execute).not.toHaveBeenCalled();
  expect(fixture.native).not.toHaveBeenCalled();
  expect(fixture.executeHostOperation).not.toHaveBeenCalled();
});
