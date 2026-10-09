import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  installCompanionInstallLinks,
  uninstallCompanionInstallLinks,
} from "../../computer-access/companion/install-link-registration.js";
import {
  renderWindowsInstallLinkLauncher,
  windowsInstallLinkRegistryScript,
} from "../../computer-access/companion/install-link-windows.js";
import {
  MAC_INSTALL_LINK_BUNDLE_ID,
  MAC_INSTALL_LINK_HANDLER_QUERY_SCRIPT,
  renderMacInstallLinkHandler,
} from "../../computer-access/companion/install-link-macos.js";
const processMocks = vi.hoisted(() => ({
  query: vi.fn(async () => ({ stdout: "", stderr: "" })),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const execFile = Object.assign(vi.fn(), {
    [promisify.custom]: processMocks.query,
  });
  return { ...actual, execFile };
});
beforeEach(() => {
  vi.stubEnv("XDG_DATA_HOME", undefined);
  processMocks.query.mockReset().mockResolvedValue({ stdout: "", stderr: "" });
});
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture(platform: NodeJS.Platform) {
  const base = join(
    process.cwd(),
    ".codex/artifacts/plugin-installation-20261006/registration",
  );
  await mkdir(base, { recursive: true });
  const homeDir = await mkdtemp(join(base, "native-"));
  roots.push(homeDir);
  return {
    platform,
    homeDir,
    stateDir: join(homeDir, "state"),
    nodePath: "/tools with spaces/node",
    cliPath: "/tools with spaces/companion.mjs",
    execute: vi.fn(async (_file: string, _args: readonly string[]) => {}),
  };
}
test("Linux install and remove only manage their own desktop file", async () => {
  const options = await fixture("linux");
  await installCompanionInstallLinks(options);
  const path = join(
    options.homeDir,
    ".local/share/applications/com.abot.install-links.desktop",
  );
  expect(await readFile(path, "utf8")).toContain(
    '"/tools with spaces/node" "/tools with spaces/companion.mjs" host open-link %u',
  );
  expect(options.execute).toHaveBeenCalledWith("xdg-mime", [
    "default",
    "com.abot.install-links.desktop",
    "x-scheme-handler/abot",
  ]);
  processMocks.query.mockResolvedValue({
    stdout: "com.abot.install-links.desktop\n",
    stderr: "",
  });
  await installCompanionInstallLinks(options);
  await uninstallCompanionInstallLinks(options);
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(path, "another owner");
  await expect(installCompanionInstallLinks(options)).rejects.toThrow(
    "not owned",
  );
  await expect(uninstallCompanionInstallLinks(options)).rejects.toThrow(
    "not owned",
  );
  expect(await readFile(path, "utf8")).toBe("another owner");
});
test("registration refuses an existing unowned or linked state directory", async () => {
  const options = await fixture("linux");
  await mkdir(options.stateDir);
  const outside = join(options.homeDir, "outside");
  await mkdir(outside);
  await symlink(outside, join(options.stateDir, "install-links"), "dir");
  await expect(installCompanionInstallLinks(options)).rejects.toThrow(
    "not owned",
  );
  expect(options.execute).not.toHaveBeenCalled();
});
test("Windows registration is per-user and ownership-checked, and URL arguments cannot break launcher quoting", async () => {
  const options = await fixture("win32");
  await installCompanionInstallLinks(options);
  const call = options.execute.mock.calls[0];
  expect(call[0]).toBe("powershell.exe");
  const script = Buffer.from(call[1].at(-1)!, "base64").toString("utf16le");
  expect(script).toContain("HKCU:");
  expect(script).toContain("ABotInstallLinkOwner");
  const launcher = renderWindowsInstallLinkLauncher(options);
  expect(launcher).toContain("Chr(34)");
  expect(launcher).toContain("0, False");
  expect(windowsInstallLinkRegistryScript("remove", "owned")).toContain(
    "if ($exists)",
  );
});
test.each(["", MAC_INSTALL_LINK_BUNDLE_ID])(
  "macOS registers a URL app when the preferred handler is %s",
  async (handler) => {
    const options = await fixture("darwin");
    processMocks.query.mockResolvedValue({
      stdout: handler + "\n",
      stderr: "",
    });
    await installCompanionInstallLinks(options);
    expect(processMocks.query).toHaveBeenCalledWith(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", MAC_INSTALL_LINK_HANDLER_QUERY_SCRIPT, "abot"],
      expect.objectContaining({ timeout: 30_000 }),
    );
    expect(processMocks.query.mock.invocationCallOrder[0]).toBeLessThan(
      options.execute.mock.invocationCallOrder[0],
    );
    expect(options.execute.mock.calls.map(([file]) => file)).toEqual([
      "/usr/bin/osacompile",
      "/usr/bin/osascript",
      "/usr/bin/codesign",
      "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
    ]);
    expect(options.execute.mock.calls[1][1].join(" ")).toContain(
      "initWithContentsOfFile",
    );
    expect(renderMacInstallLinkHandler(options)).toContain(
      "'host', 'open-link', String(url)",
    );
  },
);

test("Linux preserves a different default handler without writing a desktop file", async () => {
  const options = await fixture("linux");
  processMocks.query.mockResolvedValue({
    stdout: "another-app.desktop\n",
    stderr: "",
  });
  await expect(installCompanionInstallLinks(options)).rejects.toThrow(
    "belongs to another application",
  );
  expect(processMocks.query).toHaveBeenCalledWith(
    "xdg-mime",
    ["query", "default", "x-scheme-handler/abot"],
    expect.objectContaining({ timeout: 30_000 }),
  );
  expect(options.execute).not.toHaveBeenCalled();
  await expect(
    readFile(
      join(
        options.homeDir,
        ".local/share/applications/com.abot.install-links.desktop",
      ),
    ),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await uninstallCompanionInstallLinks(options);
  expect(options.execute).not.toHaveBeenCalled();
});

test("Linux leaves registrations untouched when the current handler cannot be read", async () => {
  const options = await fixture("linux");
  processMocks.query.mockRejectedValue(new Error("query failed"));
  await expect(installCompanionInstallLinks(options)).rejects.toThrow(
    "query failed",
  );
  expect(options.execute).not.toHaveBeenCalled();
  await expect(
    readFile(
      join(
        options.homeDir,
        ".local/share/applications/com.abot.install-links.desktop",
      ),
    ),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test.skipIf(process.platform === "win32")(
  "Linux installs and removes its handler in an absolute XDG_DATA_HOME",
  async () => {
    const options = await fixture("linux");
    const dataHome = join(options.homeDir, "custom-data");
    vi.stubEnv("XDG_DATA_HOME", dataHome);
    await installCompanionInstallLinks(options);
    const desktop = join(
      dataHome,
      "applications/com.abot.install-links.desktop",
    );
    expect(await readFile(desktop, "utf8")).toContain("host open-link %u");
    await expect(
      readFile(
        join(
          options.homeDir,
          ".local/share/applications/com.abot.install-links.desktop",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await uninstallCompanionInstallLinks(options);
    await expect(readFile(desktop)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test.each([undefined, "", "relative/data"])(
  "Linux uses the default data directory when XDG_DATA_HOME is %s",
  async (dataHome) => {
    const options = await fixture("linux");
    vi.stubEnv("XDG_DATA_HOME", dataHome);
    await installCompanionInstallLinks(options);
    const desktop = join(
      options.homeDir,
      ".local/share/applications/com.abot.install-links.desktop",
    );
    expect(await readFile(desktop, "utf8")).toContain("host open-link %u");
    await uninstallCompanionInstallLinks(options);
    await expect(readFile(desktop)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("macOS rejects a foreign preferred handler before creating its URL app", async () => {
  const options = await fixture("darwin");
  processMocks.query.mockResolvedValue({
    stdout: "com.other.app\n",
    stderr: "",
  });
  await expect(installCompanionInstallLinks(options)).rejects.toThrow(
    "belongs to another application",
  );
  expect(options.execute).not.toHaveBeenCalled();
  await expect(
    readFile(join(options.stateDir, "install-links", "handler.js")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["foreign handler", "query failure"])(
  "macOS preserves its existing app and source on %s",
  async (failure) => {
    const options = await fixture("darwin");
    await installCompanionInstallLinks(options);
    const directory = join(options.stateDir, "install-links");
    const source = join(directory, "handler.js");
    const app = join(directory, "ABot Install.app");
    await mkdir(app);
    const marker = join(app, "preserved");
    await writeFile(source, "original source");
    await writeFile(marker, "original app");
    options.execute.mockClear();
    if (failure === "query failure") {
      processMocks.query.mockRejectedValue(new Error("query failed"));
    } else {
      processMocks.query.mockResolvedValue({
        stdout: "com.other.app\n",
        stderr: "",
      });
    }
    const error =
      failure === "query failure"
        ? "query failed"
        : "belongs to another application";
    await expect(installCompanionInstallLinks(options)).rejects.toThrow(error);
    expect(options.execute).not.toHaveBeenCalled();
    expect(await readFile(source, "utf8")).toBe("original source");
    expect(await readFile(marker, "utf8")).toBe("original app");
  },
);

test.skipIf(process.platform !== "darwin")(
  "native macOS handler query reads a default and an unregistered scheme without changing registrations",
  async () => {
    const { execFile } =
      await vi.importActual<typeof import("node:child_process")>(
        "node:child_process",
      );
    const { promisify } = await import("node:util");
    const executeFile = promisify(execFile);
    const query = async (scheme: string) => {
      const { stdout } = await executeFile(
        "/usr/bin/osascript",
        [
          "-l",
          "JavaScript",
          "-e",
          MAC_INSTALL_LINK_HANDLER_QUERY_SCRIPT,
          scheme,
        ],
        { timeout: 30_000 },
      );
      return stdout.trim();
    };
    expect(await query("https")).toMatch(/^[A-Za-z0-9.-]+$/u);
    const { randomUUID } = await import("node:crypto");
    expect(await query("abot-test-" + randomUUID())).toBe("");
  },
  65_000,
);
