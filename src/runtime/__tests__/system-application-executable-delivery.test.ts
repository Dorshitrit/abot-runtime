import { describe, expect, test, vi } from "vitest";
import { createSystemHandlers } from "../../computer-access/handlers.js";
import { systemApplicationObservation } from "../../computer-access/application-observation.js";
import type { SystemApplication, SystemProcessResult, SystemProcessRunner, SystemTarget } from "../../computer-access/contracts.js";
import { systemProtectionOwners } from "./support/system-result-protection-fixture.js";

const target: SystemTarget = { id: "windows", transport: "wsl_interop", shell: "/observed/powershell.exe" };
const authority = { sharedState: { requestContext: {
  agentMode: "reasoning" as const, toolPermissionMode: "full_plus" as const,
} } };
function completed(value: unknown): SystemProcessResult {
  return { status: "completed", exitCode: 0, stdout: JSON.stringify(value), stderr: "", outputTruncated: false };
}
const path = "C:\\Program Files\\Observed\\app.exe";
function application(executablePath = path): SystemApplication {
  return {
    id: "Exact.Identity", name: "Observed", target: "windows",
    executableResolution: { status: "resolved", source: "windows_apps_folder_target", path: executablePath },
  };
}
const scope = {
  source: "windows_start_apps" as const, roots: [],
  includesExecutableSearch: false as const, includesOtherTargets: false as const,
};

describe("bounded application executable delivery", () => {
  test("query and limit run before executable observation and keep full coverage counts", async () => {
    const run = vi.fn<SystemProcessRunner>()
      .mockResolvedValueOnce(completed([
        { Name: "Other", AppID: "Other.Identity" },
        { Name: "Observed One", AppID: "Selected.One" },
        { Name: "Observed Two", AppID: "Omitted.Two" },
      ]))
      .mockResolvedValueOnce(completed([{ id: "Selected.One", status: "resolved", path }]));
    const handlers = createSystemHandlers(run, async () => target);
    const result = await handlers.system_applications!({ target: "windows", query: "observed", limit: 1 }, authority);
    expect(result).toMatchObject({ ok: true, data: {
      observedMatches: 2, omittedMatches: 1,
      applications: [{ id: "Selected.One", executableResolution: { status: "resolved", path } }],
    } });
    expect(run).toHaveBeenCalledTimes(2);
    const script = Buffer.from(run.mock.calls[1]![0].args.at(-1)!, "base64").toString("utf16le");
    expect(script).toContain('Selected.One');
    expect(script).not.toContain('Other.Identity');
    expect(script).not.toContain('Omitted.Two');
  });

  test("no match performs only the existing catalog read", async () => {
    const run = vi.fn<SystemProcessRunner>().mockResolvedValue(completed([{ Name: "Other", AppID: "Other.Identity" }]));
    const result = await createSystemHandlers(run, async () => target).system_applications!(
      { target: "windows", query: "unlisted" }, authority,
    );
    expect(result).toMatchObject({ ok: true, data: { applications: [], observedMatches: 0 } });
    expect(run).toHaveBeenCalledOnce();
  });

  test("cancellation during the catalog read starts no executable probe", async () => {
    const controller = new AbortController();
    const run = vi.fn<SystemProcessRunner>().mockImplementation(async () => {
      controller.abort();
      return completed([{ Name: "Observed", AppID: "Exact.Identity" }]);
    });
    const result = await createSystemHandlers(run, async () => target).system_applications!(
      { target: "windows" }, { ...authority, abortSignal: controller.signal },
    );
    expect(result.ok).toBe(false);
    expect(run).toHaveBeenCalledOnce();
    expect(result.data).toBeUndefined();
  });

  test("resolution failure retains a usable app identity and catalog completeness", async () => {
    const run = vi.fn<SystemProcessRunner>()
      .mockResolvedValueOnce(completed([{ Name: "Observed", AppID: "Exact.Identity" }]))
      .mockRejectedValueOnce(new Error("source failed"));
    const result = await createSystemHandlers(run, async () => target).system_applications!(
      { target: "windows", query: "Observed" }, authority,
    );
    expect(result).toMatchObject({ ok: true, data: { catalogComplete: true, applications: [{
      id: "Exact.Identity", executableResolution: { status: "unresolved", reason: "source_unavailable" },
    }] } });
  });

  test("old catalog records without resolution stay valid and summaries preserve omission semantics", () => {
    const legacy: SystemApplication = { id: "Old.Id", name: "Old", target: "windows" };
    const result = systemApplicationObservation(target, { applications: [legacy], complete: true, scope }, "", 10);
    expect(result.data.applications).toEqual([legacy]);
    expect(result.data.applications[0]).not.toHaveProperty("executableResolution");
  });
});

describe.each(systemProtectionOwners)("$owner executable path protection", ({ protection }) => {
  test("withholds sensitive actionable metadata instead of producing a fake executable path", () => {
    const unsafe = application("C:\\api_key=synthetic-private\\app.exe");
    const before = structuredClone(unsafe);
    const protectedApp = protection.protectApplication(unsafe);
    expect(protectedApp).toEqual({ ...unsafe, executableResolution: {
      status: "unresolved", source: "windows_apps_folder_target", reason: "sensitive_executable_withheld",
    } });
    expect(JSON.stringify(protectedApp)).not.toContain("synthetic-private");
    expect(JSON.stringify(protectedApp)).not.toContain("[REDACTED]");
    expect(unsafe).toEqual(before);
  });

  test("ordinary executable observations retain their exact catalog identity and path", () => {
    const safe = application();
    expect(protection.protectCatalog({ applications: [safe], complete: true, scope }).applications).toEqual([safe]);
  });
});
