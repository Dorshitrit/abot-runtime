import { describe, expect, test, vi } from "vitest";
import { createSystemHandlers } from "../../computer-access/handlers.js";
import { systemApplicationObservation, systemApplicationResult } from "../../computer-access/application-observation.js";
import { PLUGIN_RESULT_SERIALIZED_MAX_BYTES, successResult } from "../../plugin-sdk/index.js";
import type { SystemApplication, SystemProcessResult, SystemProcessRunner, SystemTarget } from "../../computer-access/contracts.js";

const target: SystemTarget = { id: "windows", transport: "wsl_interop", shell: "/observed/powershell.exe" };
const scope = {
  source: "windows_start_apps" as const, roots: [],
  includesExecutableSearch: false as const, includesOtherTargets: false as const,
};
function completed(value: unknown): SystemProcessResult {
  return { status: "completed", exitCode: 0, stdout: JSON.stringify(value), stderr: "", outputTruncated: false };
}

describe("executable metadata never displaces a deliverable catalog", () => {
  test("100 long valid paths fit the real SDK result limit by withholding optional detail", async () => {
    const path = `C:\\${"registered".repeat(390)}\\app.exe`;
    const identities = Array.from({ length: 100 }, (_, index) => ({ Name: `App ${index}`, AppID: `Exact.${index}` }));
    const run = vi.fn<SystemProcessRunner>()
      .mockResolvedValueOnce(completed(identities))
      .mockResolvedValueOnce(completed(identities.map(({ AppID }) => ({ id: AppID, status: "resolved", path }))));
    const result = await createSystemHandlers(run, async () => target).system_applications!({ target: "windows", limit: 100 });
    expect(result.ok).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(PLUGIN_RESULT_SERIALIZED_MAX_BYTES);
    expect(result.data).toMatchObject({ observedMatches: 100, omittedMatches: 0 });
    const applications = (result.data as { applications: SystemApplication[] }).applications;
    expect(applications.map(({ id }) => id)).toEqual(identities.map(({ AppID }) => AppID));
    expect(applications.every(({ executableResolution }) => executableResolution?.status === "unresolved" && executableResolution.reason === "output_budget_exceeded")).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });

  test("an almost full baseline retains all identities even when no optional metadata fits", () => {
    let identity: SystemApplication = { id: "Exact.Identity", name: "n".repeat(10_000), target: "windows" };
    const initial = systemApplicationObservation(target, { applications: [identity], complete: true, scope }, "", 1);
    const initialResult = successResult({ ...initial, data: {
      ...initial.data, observationMeta: { kind: "volatile_external", carryPolicy: "never" },
    } });
    const spare = PLUGIN_RESULT_SERIALIZED_MAX_BYTES - Buffer.byteLength(JSON.stringify(initialResult), "utf8");
    identity = { ...identity, name: identity.name + "n".repeat(spare) };
    const catalog = { applications: [identity], complete: true, scope };
    const selection = { observedMatches: 1, omittedMatches: 0, applications: [identity] };
    const baseline = systemApplicationResult(target, catalog, "", 1, selection);
    expect(baseline.ok).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(baseline), "utf8")).toBe(PLUGIN_RESULT_SERIALIZED_MAX_BYTES);
    const enriched: SystemApplication = { ...identity, executableResolution: {
      status: "resolved", source: "windows_apps_folder_target", path: "C:\\Observed\\app.exe",
    } };
    const delivered = systemApplicationResult(target, catalog, "", 1, { ...selection, applications: [enriched] });
    expect(delivered).toEqual(baseline);
  });

  test("the invocation assessor can withhold detail below the standalone byte limit", () => {
    const identity: SystemApplication = { id: "Exact.Identity", name: "Observed", target: "windows" };
    const catalog = { applications: [identity], complete: true, scope };
    const selection = { observedMatches: 1, omittedMatches: 0, applications: [identity] };
    const baseline = systemApplicationResult(target, catalog, "", 1, selection);
    const maxBytes = Buffer.byteLength(JSON.stringify(baseline), "utf8");
    const enriched: SystemApplication = { ...identity, executableResolution: {
      status: "resolved", source: "windows_apps_folder_target", path: "C:\\Observed\\app.exe",
    } };
    const assess = vi.fn((result: unknown) => {
      const serializedBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
      return { fits: serializedBytes <= maxBytes, serializedBytes, maxBytes };
    });
    expect(systemApplicationResult(target, catalog, "", 1, { ...selection, applications: [enriched] }, { assess })).toEqual(baseline);
    expect(assess).toHaveBeenCalled();
  });
});
