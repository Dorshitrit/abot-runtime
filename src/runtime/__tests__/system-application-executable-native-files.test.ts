import { afterEach, expect, test, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeSystemApplicationExecutables } from "../../computer-access/application-executable-resolution.js";
import { observeLinuxApplicationExecutable } from "../../computer-access/linux-application-executable.js";
import { runSystemProcess } from "../../computer-access/process-runner.js";
import type { SystemApplication } from "../../computer-access/contracts.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureRoot(): Promise<string> {
  const parent = process.platform === "darwin" ? "/private/tmp" : await realpath(tmpdir());
  const root = await mkdtemp(join(parent, "abot-app-"));
  roots.push(root);
  return root;
}

async function emptyExecutable(root: string, name = "registered app"): Promise<string> {
  const path = join(root, name);
  await writeFile(path, "", { mode: 0o700 });
  return path;
}

async function desktopApplication(root: string, command: string): Promise<SystemApplication> {
  const id = join(root, "observed.desktop");
  await writeFile(id, `[Desktop Entry]\nType=Application\nName=Observed\nExec=${command}\n`);
  return { id, name: "Observed", target: "linux" };
}

test.skipIf(process.platform === "win32")("Linux metadata resolves the exact registered file without launching it", async () => {
  const root = await fixtureRoot();
  const path = await emptyExecutable(root);
  const application = await desktopApplication(root, `"${path}" %U`);
  expect(await observeLinuxApplicationExecutable(application)).toEqual({
    status: "resolved", source: "linux_desktop_exec", path,
  });
  expect(await readFile(path, "utf8")).toBe("");
});

test.skipIf(process.platform === "win32")("Linux metadata does not reinterpret a wrapper or raw arguments", async () => {
  const root = await fixtureRoot();
  const path = await emptyExecutable(root, "registered-app");
  const application = await desktopApplication(root, `${path} --profile other`);
  expect(await observeLinuxApplicationExecutable(application)).toEqual({
    status: "unresolved", source: "linux_desktop_exec", reason: "desktop_exec_requires_interpretation",
  });
});

test.skipIf(process.platform === "win32")("Linux metadata rejects executable and desktop-entry symbolic links", async () => {
  const root = await fixtureRoot();
  const executable = await emptyExecutable(root, "registered-app");
  const link = join(root, "alias-app");
  await symlink(executable, link);
  const application = await desktopApplication(root, link);
  expect(await observeLinuxApplicationExecutable(application)).toMatchObject({
    status: "unresolved", reason: "registered_target_unavailable",
  });
  const desktopLink = join(root, "alias.desktop");
  await symlink(application.id, desktopLink);
  expect(await observeLinuxApplicationExecutable({ ...application, id: desktopLink })).toMatchObject({
    status: "unresolved", reason: "desktop_entry_unavailable",
  });
});

test.skipIf(process.platform === "win32")("Linux metadata withholds missing execute permission and oversized source", async () => {
  const root = await fixtureRoot();
  const executable = await emptyExecutable(root, "registered-app");
  await chmod(executable, 0o600);
  const application = await desktopApplication(root, executable);
  expect(await observeLinuxApplicationExecutable(application)).toMatchObject({
    status: "unresolved", reason: "registered_target_unavailable",
  });
  await writeFile(application.id, "x".repeat(128_001));
  expect(await observeLinuxApplicationExecutable(application)).toMatchObject({
    status: "unresolved", reason: "desktop_entry_unavailable",
  });
});

async function macApplication(root: string, name: string, executableName: string): Promise<SystemApplication> {
  const id = join(root, `${name}.app`);
  const executables = join(id, "Contents", "MacOS");
  await mkdir(executables, { recursive: true });
  await writeFile(join(id, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>${executableName}</string></dict></plist>`);
  return { id, name, target: "macos" };
}

test.skipIf(process.platform !== "darwin")("macOS reads real bundle metadata and validates only its registered executable", async () => {
  const root = await fixtureRoot();
  const application = await macApplication(root, "Observed 'quoted' שלום", "registered app");
  const path = await emptyExecutable(join(application.id, "Contents", "MacOS"));
  const run = vi.fn(runSystemProcess);
  const result = await observeSystemApplicationExecutables(
    { id: "macos", transport: "native", shell: "/bin/bash" }, [application], run,
  );
  expect(result).toEqual([{ ...application, executableResolution: {
    status: "resolved", source: "macos_bundle_executable", path,
  } }]);
  expect(run).toHaveBeenCalledOnce();
  expect(run.mock.calls[0]![0].executable).toBe("/usr/bin/osascript");
  expect(await readFile(path, "utf8")).toBe("");
});

test.skipIf(process.platform !== "darwin")("macOS invalid or absent executable metadata preserves the selected identities", async () => {
  const root = await fixtureRoot();
  const invalid = await macApplication(root, "Invalid", "../outside");
  const missing = await macApplication(root, "Missing", "not-installed");
  const run = vi.fn(runSystemProcess);
  const result = await observeSystemApplicationExecutables(
    { id: "macos", transport: "native", shell: "/bin/bash" }, [invalid, missing], run,
  );
  expect(result.map(({ id }) => id)).toEqual([invalid.id, missing.id]);
  expect(result.map(({ executableResolution }) => executableResolution)).toEqual([
    { status: "unresolved", source: "macos_bundle_executable", reason: "bundle_executable_unavailable" },
    { status: "unresolved", source: "macos_bundle_executable", reason: "registered_target_unavailable" },
  ]);
  expect(run).toHaveBeenCalledOnce();
  expect(run.mock.calls[0]![0].executable).toBe("/usr/bin/osascript");
});
