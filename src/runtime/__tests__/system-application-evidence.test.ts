import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readSystemApplications } from "../../../plugins/system/source/application-catalog.js";
import { systemApplicationObservation } from "../../../plugins/system/source/application-observation.js";
import { createSystemHandlers } from "../../../plugins/system/source/handlers.js";
import type {
  SystemApplication,
  SystemProcessInput,
  SystemProcessResult,
  SystemTarget,
  SystemTargetId,
} from "../../../plugins/system/source/contracts.js";

const filesystem = vi.hoisted(() => ({ readdir: vi.fn(), readFile: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  ...filesystem,
}));
vi.mock(
  "../../../plugins/system/source/targets.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../plugins/system/source/targets.js")
    >()),
    resolveSystemTarget: vi.fn(async (id: SystemTargetId) => targetFor(id)),
    findExecutable: vi.fn(async () => "/observed/gio"),
  }),
);

function targetFor(id: SystemTargetId): SystemTarget {
  return {
    id,
    transport: id === "windows" ? "wsl_interop" : "native",
    shell: id === "windows" ? "/observed/powershell.exe" : "/bin/bash",
  };
}
function completed(stdout = ""): SystemProcessResult {
  return {
    status: "completed",
    exitCode: 0,
    stdout,
    stderr: "",
    outputTruncated: false,
  };
}
const authority = {
  sharedState: {
    requestContext: {
      agentMode: "reasoning" as const,
      toolPermissionMode: "full_plus" as const,
    },
  },
};
const desktopEntry =
  "[Desktop Entry]\nType=Application\nName=Observed App\nExec=/observed/application\n";
function entry(name: string) {
  return { name, isDirectory: () => true };
}
function dataOf(value: unknown): Record<string, unknown> {
  expect(value).not.toBeNull();
  expect(typeof value).toBe("object");
  return value as Record<string, unknown>;
}

beforeEach(() => {
  vi.stubEnv("XDG_DATA_HOME", "/catalog/user");
  vi.stubEnv("XDG_DATA_DIRS", "/catalog/shared");
  filesystem.readdir.mockReset().mockResolvedValue([]);
  filesystem.readFile.mockReset().mockResolvedValue(desktopEntry);
});
afterEach(() => vi.unstubAllEnvs());

describe("scoped application discovery evidence", () => {
  test("empty complete Linux desktop enumeration cannot conclude installed absence or describe another target", async () => {
    const run = vi.fn(async () => completed());
    const receipt = await createSystemHandlers(run).system_applications!(
      { target: "linux", query: "missing" },
      authority,
    );
    expect(receipt).toMatchObject({
      ok: true,
      data: {
        target: "linux",
        absenceConclusionSupported: false,
        completenessMeaning: "declared_catalog_sources_only",
        catalogComplete: true,
        catalogScope: {
          source: "linux_desktop_entries",
          roots: ["/catalog/user/applications", "/catalog/shared/applications"],
          includesExecutableSearch: false,
          includesOtherTargets: false,
        },
        observedMatches: 0,
        applications: [],
      },
    });
    const output = String(receipt.output);
    expect(output.indexOf("absenceConclusionSupported")).toBeLessThan(
      output.indexOf('"applications"'),
    );
    expect(JSON.parse(output)).toMatchObject({
      absenceConclusionSupported: false,
      applications: [],
    });
    expect(run).not.toHaveBeenCalled();
  });

  test("macOS declared scope is the actual bundle roots read", async () => {
    const catalog = await readSystemApplications(
      targetFor("macos"),
      vi.fn(async () => completed()),
    );
    expect(catalog.scope.source).toBe("macos_application_bundles");
    expect(catalog.scope.roots).toEqual(
      filesystem.readdir.mock.calls.map(([path]) => path),
    );
    expect(catalog.scope.roots.slice(0, 2)).toEqual([
      "/Applications",
      "/System/Applications",
    ]);
    expect(catalog.scope.includesExecutableSearch).toBe(false);
  });

  test("Windows discovery is identified as its Start catalog, not arbitrary executable enumeration", async () => {
    const run = vi.fn(async () =>
      completed(
        JSON.stringify([
          { Name: "Observed App", AppID: "Registered.Identity" },
        ]),
      ),
    );
    const catalog = await readSystemApplications(targetFor("windows"), run);
    expect(catalog).toMatchObject({
      complete: true,
      scope: {
        source: "windows_start_apps",
        roots: [],
        includesExecutableSearch: false,
        includesOtherTargets: false,
      },
      applications: [{ id: "Registered.Identity", target: "windows" }],
    });
    expect(run).toHaveBeenCalledOnce();
    expect(filesystem.readdir).not.toHaveBeenCalled();
  });

  test("oversized unread desktop content makes declared enumeration incomplete", async () => {
    filesystem.readdir.mockImplementation(async (path: string) =>
      path === "/catalog/user/applications" ? [entry("oversized.desktop")] : [],
    );
    filesystem.readFile.mockResolvedValue(desktopEntry + "x".repeat(128_001));
    const catalog = await readSystemApplications(
      targetFor("linux"),
      vi.fn(async () => completed()),
    );
    expect(catalog.complete).toBe(false);
    expect(catalog.applications).toEqual([]);
  });

  test("a bounded summary declares omitted entries while raw catalog identities remain exact", () => {
    const applications: SystemApplication[] = Array.from(
      { length: 100 },
      (_, index) => ({
        id: `/catalog/${index}/` + "x".repeat(1_000),
        name: "App",
        target: "linux",
      }),
    );
    const observation = systemApplicationObservation(
      targetFor("linux"),
      {
        applications,
        complete: true,
        scope: {
          source: "linux_desktop_entries",
          roots: ["/catalog"],
          includesExecutableSearch: false,
          includesOtherTargets: false,
        },
      },
      "",
      100,
    );
    const summary = JSON.parse(observation.output);
    expect(observation.output.length).toBeLessThanOrEqual(7_000);
    expect(summary.summaryApplicationsOmitted).toBe(
      100 - summary.applications.length,
    );
    expect(summary.absenceConclusionSupported).toBe(false);
    expect(observation.data.applications).toEqual(applications);
    expect(summary.applications).toEqual(
      applications.slice(0, summary.applications.length),
    );
  });

  test("JSON escaping cannot overflow the receipt when catalog roots alone exceed the summary budget", () => {
    const roots = Array.from(
      { length: 20 },
      (_, index) => `/${index}/` + "\u0001".repeat(400),
    );
    const observation = systemApplicationObservation(
      targetFor("linux"),
      {
        applications: [],
        complete: true,
        scope: {
          source: "linux_desktop_entries",
          roots,
          includesExecutableSearch: false,
          includesOtherTargets: false,
        },
      },
      "",
      50,
    );
    const summary = JSON.parse(observation.output);
    expect(observation.output.length).toBeLessThanOrEqual(7_000);
    expect(summary.summaryRootsOmitted).toBe(
      roots.length - summary.catalogScope.roots.length,
    );
    const rawCharacters = roots.reduce((total, root) => total + root.length, 0);
    const summaryCharacters = summary.catalogScope.roots.reduce(
      (total: number, root: string) => total + root.length,
      0,
    );
    expect(summary.summaryRootCharactersOmitted).toBe(
      rawCharacters - summaryCharacters,
    );
    expect(observation.data.catalogScope.roots).toEqual(roots);
    expect(summary.absenceConclusionSupported).toBe(false);
  });
});

describe("catalog-bound launch dispatch receipts", () => {
  test.each(["linux", "macos", "windows"] as const)(
    "%s binds revalidated identity without converting a helper PID into application success",
    async (targetId) => {
      const applicationId =
        targetId === "windows"
          ? "Registered.Identity"
          : targetId === "macos"
            ? "/Applications/Observed.app"
            : "/catalog/user/applications/observed.desktop";
      filesystem.readdir.mockImplementation(async (path: string) => {
        if (path === "/Applications") return [entry("Observed.app")];
        if (path === "/catalog/user/applications")
          return [entry("observed.desktop")];
        return [];
      });
      const run = vi.fn(
        async (input: SystemProcessInput): Promise<SystemProcessResult> => {
          const stdout =
            targetId === "windows"
              ? JSON.stringify([{ Name: "Observed App", AppID: applicationId }])
              : "dispatch accepted";
          return {
            ...completed(stdout),
            spawnedProcess: {
              pid: 123,
              executable: input.executable,
              pidNamespace: "runtime_os",
              identitySource: "spawn_arguments",
            },
          };
        },
      );
      const receipt = await createSystemHandlers(run).system_launch!(
        { target: targetId, application_id: applicationId },
        authority,
      );
      expect(receipt).toMatchObject({
        ok: true,
        data: {
          evidenceScope: "launch_request_dispatch",
          independentOutcomeCheck: "not_performed",
          catalogApplication: { id: applicationId, target: targetId },
          spawnedProcess: {
            pid: 123,
            pidNamespace: "runtime_os",
            identitySource: "spawn_arguments",
          },
        },
      });
      const data = dataOf(receipt.data);
      expect(data).not.toHaveProperty("mutationEvidence");
      expect(data).not.toHaveProperty("applicationPid");
      expect(data).not.toHaveProperty("windowVisible");
      const spawned = dataOf(data.spawnedProcess);
      expect(spawned.executable).toBe(run.mock.calls.at(-1)![0].executable);
      expect(spawned.executable).not.toBe(applicationId);
      if (targetId === "macos")
        expect(run.mock.calls.at(-1)![0].args).toEqual(["-a", applicationId]);
      if (targetId === "linux")
        expect(run.mock.calls.at(-1)![0].args).toEqual([
          "launch",
          applicationId,
        ]);
    },
  );

  test("a raw path missing from the catalog is not dispatched as if it were a catalog identity", async () => {
    const run = vi.fn(async () => completed());
    const receipt = await createSystemHandlers(run).system_launch!(
      { target: "linux", application_id: "/some/executable" },
      authority,
    );
    expect(receipt).toMatchObject({
      ok: false,
      errorCode: "system_application_not_found",
    });
    expect(run).not.toHaveBeenCalled();
  });
});
