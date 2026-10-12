import { mkdir } from "node:fs/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createSystemCommandPathAdapter } from "../../../plugins/system/source/command-working-directory.js";
import { prepareSystemRequestModules } from "../../../plugins/system/source/request-system-modules.js";
import type { SystemTargetSnapshot } from "../../../plugins/system/source/request-target-snapshot.js";
import { createRegisteredToolNormalInvocationExecutor } from "../adapters/registered-tool-normal-invocations.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import type { ToolApprovalController, ToolApprovalDecision } from "../ports.js";
import {
  selectedSystemModules,
  systemRequestPluginFixture,
} from "./support/system-request-plugin-fixture.js";
import {
  createPortablePluginFixture,
  removePortablePluginFixtures,
} from "./windows-portable-plugins-fixture.js";

const nativeWindows = {
  kind: "native",
  target: { id: "windows", transport: "native", shell: "powershell.exe" },
} as const;
const command = "& '.\\generate-project.ps1'";
afterEach(removePortablePluginFixtures);

async function fixture(snapshot: SystemTargetSnapshot = [nativeWindows]) {
  const context = await createPortablePluginFixture("system");
  await mkdir(context.runtimePaths.agentWorkDir, { recursive: true });
  await mkdir(context.runtimePaths.workspaceDir, { recursive: true });
  const resolve = vi.fn(context.runtimePathResolver.resolve);
  const adapter = createSystemCommandPathAdapter(undefined, snapshot, {
    resolve,
  });
  return {
    context,
    resolve,
    normalize: (cwd: string, target = "windows", tool = "system_command") =>
      adapter!.normalizeCall!({ tool, params: { target, command, cwd } }),
  };
}

describe("SYSTEM native Windows filesystem directory handoff", () => {
  test.each([
    ".",
    "project/subdirectory",
    "workspace",
    "workspace/project with spaces",
  ])(
    "resolves %s through the same filesystem authority without rewriting the command",
    async (cwd) => {
      const f = await fixture();
      const expected = f.context.runtimePathResolver.resolve(cwd).absolutePath;
      expect(f.normalize(cwd)).toEqual({
        tool: "system_command",
        params: { target: "windows", command, cwd: expected },
      });
    },
  );

  test.each([
    "C:\\other project",
    "D:/independent",
    "  D:/independent  ",
    "\\\\server\\share\\folder",
    "/not-a-windows-directory",
  ])(
    "leaves the explicit target path %s to the existing SYSTEM validator",
    async (cwd) => {
      const f = await fixture();
      expect(f.normalize(cwd).params.cwd).toBe(cwd);
      expect(f.resolve).not.toHaveBeenCalled();
    },
  );

  test.each([
    {
      kind: "native",
      target: { id: "linux", transport: "native", shell: "/bin/bash" },
    },
    {
      kind: "native",
      target: { id: "macos", transport: "native", shell: "/bin/bash" },
    },
    {
      kind: "native",
      target: {
        id: "windows",
        transport: "wsl_interop",
        shell: "/mnt/c/powershell.exe",
      },
    },
    {
      kind: "companion",
      target: "windows",
      hostId: "host",
      connectionId: "connection",
      identity: {
        name: "Remote",
        os: "windows",
        user: "owner",
        homeDir: "C:\\Users\\owner",
      },
    },
  ] satisfies SystemTargetSnapshot)(
    "preserves the existing path contract for $kind $target",
    async (route) => {
      const f = await fixture([route]);
      const target = route.kind === "native" ? route.target.id : route.target;
      for (const cwd of [".", "/tmp/work", "C:\\work"])
        expect(f.normalize(cwd, target).params.cwd).toBe(cwd);
      expect(f.resolve).not.toHaveBeenCalled();
    },
  );

  test("does not use a different available target or normalize other tools", async () => {
    const f = await fixture();
    expect(f.normalize(".", "linux").params.cwd).toBe(".");
    expect(f.normalize(".", "windows", "system_launch").params.cwd).toBe(".");
    expect(f.resolve).not.toHaveBeenCalled();
    expect(
      createSystemCommandPathAdapter(undefined, [nativeWindows], undefined),
    ).toBeUndefined();
  });

  test("rejects traversal outside filesystem roots before any invocation", async () => {
    const f = await fixture();
    expect(() => f.normalize("../outside")).toThrow();
    expect(() => f.normalize("workspace/../../outside")).toThrow();
  });

  test.each(["ask", "full_access"] as const)(
    "%s binds approval, restored action and dispatch to the same resolved directory",
    async (mode) => {
      const f = await fixture();
      const h = systemRequestPluginFixture([nativeWindows.target]);
      h.readHostStatus.mockResolvedValue({ paired: false, connected: false });
      const modules = await prepareSystemRequestModules(
        f.context.rootDir,
        selectedSystemModules(["system_command"]),
        {
          observeTargets: h.observeTargets,
          connection: {
            readHostStatus: h.readHostStatus,
            executeHostOperation: h.executeHostOperation,
          },
          createNativeHandlers: () => ({ system_command: h.native }),
        },
        { runtimePathResolver: f.context.runtimePathResolver },
      );
      const registry = createConfiguredToolRegistry(undefined, modules);
      let decide!: (decision: ToolApprovalDecision) => void;
      const requestToolApproval = vi.fn<
        ToolApprovalController["requestToolApproval"]
      >(
        () =>
          new Promise((resolve) => {
            decide = resolve;
          }),
      );
      const executor = createRegisteredToolNormalInvocationExecutor({
        registrations: registry.listNormalInvocations!(),
        toolRegistry: registry,
        requestId: "directory-handoff",
        abortSignal: new AbortController().signal,
        nextApprovalId: () => "directory-approval",
        toolPermissionMode: mode,
        toolApprovalController: { requestToolApproval },
      });
      const prepared = executor.prepare({
        handle: executor.operations[0]!.handle,
        controls: { target: "windows", command, cwd: "." },
        intent: "Run the requested generated script.",
      });
      expect(prepared.status).toBe("prepared");
      if (prepared.status !== "prepared") throw new Error(prepared.code);
      const restored = executor.restore(
        JSON.parse(JSON.stringify(prepared.snapshot)),
      );
      expect(restored.status).toBe("prepared");
      if (restored.status !== "prepared") throw new Error(restored.code);
      expect(restored.actionFingerprint).toBe(prepared.actionFingerprint);
      const pending = restored.execute();
      expect(h.native).not.toHaveBeenCalled();
      const approvedCall = requestToolApproval.mock.calls[0]![0].call;
      expect(approvedCall.params).toMatchObject({
        target: "windows",
        command,
        cwd: f.context.runtimePaths.agentWorkDir,
      });
      decide({ approved: true });
      expect(await pending).toMatchObject({
        status: "executed",
        result: { ok: true },
      });
      expect(h.native).toHaveBeenCalledOnce();
      expect(h.native.mock.calls[0]![0]).toEqual(approvedCall.params);
      expect(h.executeHostOperation).not.toHaveBeenCalled();
    },
  );
});
