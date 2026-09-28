import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readSystemApplications } from "../../computer-access/application-catalog.js";
import type {
  SystemProcessRunner,
  SystemTarget,
} from "../../computer-access/contracts.js";

const filesystem = vi.hoisted(() => ({ readdir: vi.fn(), readFile: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  ...filesystem,
}));

const target: SystemTarget = {
  id: "linux",
  transport: "native",
  shell: "/bin/bash",
};
const run = vi.fn<SystemProcessRunner>();
const application = "[Desktop Entry]\nType=Application\nName=Available App\n";
function failure(code: string): Error {
  return Object.assign(new Error(`catalog read failed: ${code}`), { code });
}
function entry(name: string, directory = false) {
  return { name, isDirectory: () => directory };
}

beforeEach(() => {
  vi.stubEnv("XDG_DATA_HOME", "/catalog/user");
  vi.stubEnv("XDG_DATA_DIRS", "/catalog/shared");
  filesystem.readdir.mockReset();
  filesystem.readFile.mockReset();
  filesystem.readFile.mockResolvedValue(application);
  run.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("application catalog completeness reflects filesystem evidence", () => {
  test("absent optional catalog roots do not make an otherwise readable catalog incomplete", async () => {
    filesystem.readdir.mockImplementation(async (path: string) => {
      if (path === "/catalog/user/applications") throw failure("ENOENT");
      return [entry("available.desktop")];
    });
    const catalog = await readSystemApplications(target, run);
    expect(catalog).toMatchObject({
      complete: true,
      applications: [
        {
          id: "/catalog/shared/applications/available.desktop",
          name: "Available App",
          target: "linux",
        },
      ],
    });
    expect(run).not.toHaveBeenCalled();
  });

  test.each(["EACCES", "EIO"])(
    "%s from a catalog root preserves readable applications but reports incomplete evidence",
    async (code) => {
      filesystem.readdir.mockImplementation(async (path: string) => {
        if (path === "/catalog/user/applications") throw failure(code);
        return [entry("available.desktop")];
      });
      const catalog = await readSystemApplications(target, run);
      expect(catalog.complete).toBe(false);
      expect(catalog.applications).toEqual([
        {
          id: "/catalog/shared/applications/available.desktop",
          name: "Available App",
          target: "linux",
        },
      ]);
    },
  );

  test("a discovered subdirectory disappearing is incomplete evidence, not an absent optional root", async () => {
    filesystem.readdir.mockImplementation(async (path: string) => {
      if (path === "/catalog/user/applications")
        return [entry("vanished", true), entry("available.desktop")];
      if (path.endsWith("/vanished")) throw failure("ENOENT");
      return [];
    });
    const catalog = await readSystemApplications(target, run);
    expect(catalog.complete).toBe(false);
    expect(catalog.applications).toHaveLength(1);
  });

  test.each(["EACCES", "EIO", "ENOENT"])(
    "%s reading a discovered desktop entry cannot produce a complete catalog",
    async (code) => {
      filesystem.readdir.mockImplementation(async (path: string) =>
        path === "/catalog/user/applications"
          ? [entry("unreadable.desktop"), entry("available.desktop")]
          : [],
      );
      filesystem.readFile.mockImplementation(async (path: string) => {
        if (path.endsWith("/unreadable.desktop")) throw failure(code);
        return application;
      });
      const catalog = await readSystemApplications(target, run);
      expect(catalog.complete).toBe(false);
      expect(catalog.applications).toEqual([
        {
          id: "/catalog/user/applications/available.desktop",
          name: "Available App",
          target: "linux",
        },
      ]);
    },
  );

  test("macOS catalog directory failures also report incomplete evidence", async () => {
    filesystem.readdir.mockImplementation(async (path: string) => {
      if (path === "/Applications") return [entry("Available.app", true)];
      if (path === "/System/Applications") throw failure("EACCES");
      throw failure("ENOENT");
    });
    const catalog = await readSystemApplications(
      { ...target, id: "macos" },
      run,
    );
    expect(catalog).toMatchObject({
      complete: false,
      applications: [
        {
          id: "/Applications/Available.app",
          name: "Available",
          target: "macos",
        },
      ],
    });
    expect(filesystem.readFile).not.toHaveBeenCalled();
  });
});
