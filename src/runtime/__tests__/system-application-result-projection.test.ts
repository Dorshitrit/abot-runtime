import { expect, test } from "vitest";
import { projectSystemApplicationResultForBudget } from "../../computer-access/application-result-budget.js";
import { systemApplicationResult } from "../../computer-access/application-observation.js";
import { attachHostEvidence } from "../../computer-access/host-evidence.js";
import type { ToolImplementationOutput, ToolResultBudget } from "../../plugin-sdk/index.js";

const target = { id: "windows" as const, transport: "native" as const, shell: "observed" };
const scope = { source: "windows_start_apps" as const, roots: [], includesExecutableSearch: false as const, includesOtherTargets: false as const };
function result(): ToolImplementationOutput {
  const application = { id: "Exact.App", name: "Observed", target: target.id, executableResolution: {
    status: "resolved" as const, source: "windows_apps_folder_target" as const, path: `C:\\${"registered".repeat(100)}\\app.exe`,
  } };
  return systemApplicationResult(target, { complete: true, scope, applications: [application] }, "", 1,
    { observedMatches: 3, omittedMatches: 2, applications: [application] });
}
function budget(maxBytes = 1_500): ToolResultBudget {
  return { assess(value) {
    const serializedBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    return { serializedBytes, maxBytes, fits: serializedBytes <= maxBytes };
  } };
}

test("reprojects data and canonical summary together while preserving exact host provenance", () => {
  const original = attachHostEvidence(result(), "private-host", { os: "windows", name: "Host", user: "test", homeDir: "C:\\Users\\test" });
  const summary = result().output;
  const prefix = original.output.slice(0, original.output.length - summary.length);
  const delivered = projectSystemApplicationResultForBudget(original, budget(2_000));
  expect(delivered).not.toBe(original);
  expect(delivered.data).toMatchObject({ transport: "host_companion", nativeTransport: "native", observedMatches: 3, omittedMatches: 2,
    applications: [{ id: "Exact.App", name: "Observed", executableResolution: { status: "unresolved", reason: "output_budget_exceeded" } }] });
  expect(delivered.output.startsWith(prefix)).toBe(true);
  const projectedSummary = JSON.parse(delivered.output.slice(prefix.length));
  expect(projectedSummary.transport).toBe("native");
  expect(projectedSummary.applications).toEqual(delivered.data!.applications);
  expect(original.data!.applications).not.toEqual(delivered.data!.applications);
});

test.each(["fits", "failed", "malformed", "unbound_summary", "legacy", "baseline_too_large"])(
  "preserves the original result for %s without claiming a new observation", (caseName) => {
    let original = result();
    let limit = 1_500;
    if (caseName === "fits") limit = 20_000;
    if (caseName === "failed") original = { ...original, ok: false };
    if (caseName === "malformed") original = { ...original, data: { ...original.data, observedMatches: "three" } };
    if (caseName === "unbound_summary") original = { ...original, output: original.output + "different observation" };
    if (caseName === "legacy") {
      const applications = (original.data!.applications as Array<Record<string, unknown>>).map(({ executableResolution: _resolution, ...identity }) => identity);
      original = { ...original, data: { ...original.data, applications } };
    }
    if (caseName === "baseline_too_large") limit = 1;
    expect(projectSystemApplicationResultForBudget(original, budget(limit))).toBe(original);
  },
);

test("a declared budget failure cannot promote a malformed summary to structured evidence", () => {
  const original = { ...result(), output: "unrelated result" };
  expect(projectSystemApplicationResultForBudget(original, budget(1))).toBe(original);
});

test("a coercible but non-string executable source is not a canonical observation", () => {
  const original = result();
  const applications = (original.data!.applications as Array<Record<string, unknown>>).map((application) => ({
    ...application, executableResolution: { ...(application.executableResolution as Record<string, unknown>), source: ["windows_apps_folder_target"] },
  }));
  const malformed = { ...original, data: { ...original.data, applications }, output: JSON.stringify({ ...JSON.parse(original.output), applications }) };
  expect(projectSystemApplicationResultForBudget(malformed, budget())).toBe(malformed);
});
