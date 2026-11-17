import { beforeEach, describe, expect, test, vi } from "vitest";
import { observeSystemApplicationExecutables } from "../../computer-access/application-executable-resolution.js";
import { readDirectDesktopExecutable } from "../../computer-access/linux-application-executable.js";
import { isObservedRegularExecutable } from "../../computer-access/application-executable-file.js";
import type { SystemApplication, SystemProcessResult, SystemProcessRunner, SystemTarget } from "../../computer-access/contracts.js";

const files = vi.hoisted(() => ({ lstat: vi.fn(), access: vi.fn(), readFile: vi.fn() }));
vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof import("node:fs/promises")>(), ...files,
}));

const windows: SystemTarget = { id: "windows", transport: "wsl_interop", shell: "/observed/powershell.exe" };
function app(id: string, target = windows.id): SystemApplication {
  return { id, name: "Observed application", target };
}
function completed(value: unknown): SystemProcessResult {
  return { status: "completed", exitCode: 0, stdout: JSON.stringify(value), stderr: "", outputTruncated: false };
}
function regularFile() { return { isFile: () => true, isSymbolicLink: () => false, size: 100 }; }

beforeEach(() => {
  files.lstat.mockReset().mockResolvedValue(regularFile());
  files.access.mockReset().mockResolvedValue(undefined);
  files.readFile.mockReset().mockResolvedValue("[Desktop Entry]\nType=Application\nExec=/opt/observed/app %U\n");
});

describe("exact registered executable observations", () => {
  test("does no executable observation for an empty selection", async () => {
    const run = vi.fn<SystemProcessRunner>();
    expect(await observeSystemApplicationExecutables(windows, [], run)).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(files.lstat).not.toHaveBeenCalled();
  });

  test("Windows uses selected exact identities and keeps catalog authority", async () => {
    const selected = app("Observed.Identity");
    const path = "C:\\Program Files\\Observed\\app.exe";
    const run = vi.fn<SystemProcessRunner>().mockResolvedValue(completed([
      { id: selected.id, status: "resolved", path },
      { id: "Different.Identity", status: "resolved", path: "C:\\other.exe" },
    ]));
    const result = await observeSystemApplicationExecutables(windows, [selected], run);
    expect(result).toEqual([{ ...selected, executableResolution: {
      status: "resolved", source: "windows_apps_folder_target", path,
    } }]);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]![0].executable).toBe(windows.shell);
    expect(files.lstat).not.toHaveBeenCalled();
  });

  test.each([
    { failure: "source_absent", rows: [] },
    { failure: "wrong_identity", rows: [{ id: "Other.Id", status: "resolved", path: "C:\\app.exe" }] },
    { failure: "relative_target", rows: [{ id: "Exact.Id", status: "resolved", path: "\\app.exe" }] },
    { failure: "wrong_extension", rows: [{ id: "Exact.Id", status: "resolved", path: "C:\\app.url" }] },
    { failure: "duplicate_identity", rows: [
      { id: "Exact.Id", status: "resolved", path: "C:\\app.exe" },
      { id: "Exact.Id", status: "resolved", path: "C:\\app.exe" },
    ] },
  ])(
    "Windows $failure never supplies an executable by inference", async ({ rows }) => {
      const id = "Exact.Id";
      const run = vi.fn<SystemProcessRunner>().mockResolvedValue(completed(rows));
      const [result] = await observeSystemApplicationExecutables(windows, [app(id)], run);
      expect(result?.executableResolution).toMatchObject({ status: "unresolved" });
      expect(result?.executableResolution).not.toHaveProperty("path");
    },
  );

  test("Windows ambiguous registration preserves the app without a chosen path", async () => {
    const run = vi.fn<SystemProcessRunner>().mockResolvedValue(completed([
      { id: "Exact.Id", status: "ambiguous", reason: "multiple_registered_targets" },
    ]));
    const [result] = await observeSystemApplicationExecutables(windows, [app("Exact.Id")], run);
    expect(result?.executableResolution).toEqual({
      status: "ambiguous", source: "windows_apps_folder_target", reason: "multiple_registered_targets",
    });
  });

  test("failed or incomplete helper observation never erases the catalog", async () => {
    const run = vi.fn<SystemProcessRunner>().mockResolvedValue({ ...completed([]), outputTruncated: true });
    const selected = app("Exact.Id");
    const [result] = await observeSystemApplicationExecutables(windows, [selected], run);
    expect(result).toEqual({ ...selected, executableResolution: {
      status: "unresolved", source: "windows_apps_folder_target", reason: "source_unavailable",
    } });
  });

  test("macOS resolves only the exact bundle executable basename", async () => {
    const mac: SystemTarget = { id: "macos", transport: "native", shell: "/bin/bash" };
    const selected = app("/Applications/Observed.app", "macos");
    const run = vi.fn<SystemProcessRunner>().mockResolvedValue(completed([{ id: selected.id, executable: "Observed App" }]));
    const [result] = await observeSystemApplicationExecutables(mac, [selected], run);
    expect(result?.executableResolution).toEqual({
      status: "resolved", source: "macos_bundle_executable", path: "/Applications/Observed.app/Contents/MacOS/Observed App",
    });
    expect(run.mock.calls[0]![0].executable).toBe("/usr/bin/osascript");
    expect(files.lstat).toHaveBeenCalledWith("/Applications/Observed.app/Contents/MacOS/Observed App");
  });

  test.each(["../different", "/other/app", ".", "..", "sub\\app", ""])(
    "macOS does not reinterpret invalid bundle executable %s", async (name) => {
      const selected = app("/Applications/Observed.app", "macos");
      const run = vi.fn<SystemProcessRunner>().mockResolvedValue(completed([{ id: selected.id, executable: name }]));
      const [result] = await observeSystemApplicationExecutables({ ...windows, id: "macos" }, [selected], run);
      expect(result?.executableResolution).toMatchObject({ status: "unresolved" });
      expect(files.lstat).not.toHaveBeenCalled();
    },
  );

  test("Linux reads one selected desktop file and never searches PATH", async () => {
    const selected = app("/registered/observed.desktop", "linux");
    const run = vi.fn<SystemProcessRunner>();
    const [result] = await observeSystemApplicationExecutables({ ...windows, id: "linux" }, [selected], run);
    expect(result?.executableResolution).toEqual({ status: "resolved", source: "linux_desktop_exec", path: "/opt/observed/app" });
    expect(files.readFile).toHaveBeenCalledOnce();
    expect(files.readFile).toHaveBeenCalledWith(selected.id, { encoding: "utf8" });
    expect(run).not.toHaveBeenCalled();
  });

  test("Linux rejects changed or oversized metadata before reading it", async () => {
    files.lstat.mockResolvedValue({ ...regularFile(), size: 128_001 });
    const [result] = await observeSystemApplicationExecutables({ ...windows, id: "linux" }, [app("/registered/app.desktop", "linux")], vi.fn());
    expect(result?.executableResolution).toMatchObject({ status: "unresolved" });
    expect(files.readFile).not.toHaveBeenCalled();
  });

  test("registered symbolic links or non-executable files are not silently rebound", async () => {
    files.lstat.mockResolvedValue({ ...regularFile(), isSymbolicLink: () => true });
    expect(await isObservedRegularExecutable("/registered/app")).toBe(false);
    expect(files.access).not.toHaveBeenCalled();
    files.lstat.mockResolvedValue(regularFile());
    files.access.mockRejectedValue(new Error("EACCES"));
    expect(await isObservedRegularExecutable("/registered/app")).toBe(false);
  });
});

describe("executable observation cancellation", () => {
  test.each(["windows", "macos"] as const)("%s forwards cancellation without converting it to unresolved metadata", async (id) => {
    const controller = new AbortController();
    const reason = new Error("request cancelled");
    const run = vi.fn<SystemProcessRunner>().mockImplementation(async (input) => {
      expect(input.abortSignal).toBe(controller.signal);
      controller.abort(reason);
      return { ...completed([]), status: "aborted" };
    });
    await expect(observeSystemApplicationExecutables({ ...windows, id }, [app("Exact.Id", id)], run, controller.signal)).rejects.toBe(reason);
    expect(files.lstat).not.toHaveBeenCalled();
  });

  test("already cancelled observations perform no additional work", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn<SystemProcessRunner>();
    await expect(observeSystemApplicationExecutables(windows, [app("Exact.Id")], run, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(run).not.toHaveBeenCalled();
    expect(files.lstat).not.toHaveBeenCalled();
  });

  test("Linux passes cancellation to its metadata read and does not validate an executable afterward", async () => {
    const controller = new AbortController();
    files.readFile.mockImplementation(async (_path, options) => {
      expect(options.signal).toBe(controller.signal);
      controller.abort();
      throw controller.signal.reason;
    });
    await expect(observeSystemApplicationExecutables({ ...windows, id: "linux" }, [app("/registered/app.desktop", "linux")], vi.fn(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(files.lstat).toHaveBeenCalledOnce();
    expect(files.access).not.toHaveBeenCalled();
  });
});

describe("conservative Linux desktop Exec metadata", () => {
  test.each(["/opt/app", "/opt/app %U", '"/opt/Observed App/app" %f'])("resolves direct metadata %s", (command) => {
    expect(readDirectDesktopExecutable(`[Desktop Entry]\nExec=${command}\n`)).toMatchObject({ status: "resolved" });
  });
  test.each(["app %U", "env VALUE=x /opt/app", "/usr/bin/env VALUE=x /opt/app", "/opt/app --profile other", "/opt/app %U %F", '"/opt/app\\name"', "/opt/app %c"])(
    "preserves ambiguous command semantics as unresolved: %s", (command) => {
      expect(readDirectDesktopExecutable(`[Desktop Entry]\nExec=${command}\n`)).toMatchObject({ status: "unresolved", reason: "desktop_exec_requires_interpretation" });
    },
  );
  test("duplicate Exec entries never choose an arbitrary executable", () => {
    expect(readDirectDesktopExecutable("[Desktop Entry]\nExec=/one\nExec=/two\n")).toMatchObject({ status: "ambiguous" });
  });
});
