import { describe, expect, test, vi } from "vitest";
import type { ToolModuleDeclaration } from "../../capabilities/tool-types.js";
import type { ToolPermissionMode } from "../../capabilities/tool-permission-mode.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import type { ToolRegistry } from "../ports.js";
import { findSparkHomeWidget } from "../spark-home/widgets/catalog.js";
import {
  assertAvailableSparkHomeCalibrationOptions,
  readSparkHomeCalibrationOptions,
} from "../spark-home/calibration/options.js";

function publicTool(
  name: string,
  pluginName: string,
  operationIds: readonly string[],
): ToolModuleDeclaration {
  return {
    definition: { name, pluginName, routingCapability: "semantic_lookup" },
    normalInvocation: {
      version: 1,
      operations: operationIds.map(operationId => ({
        operationId,
        summary: "Read one fixture observation.",
        input: { type: "object", additionalProperties: false, properties: {}, required: [] },
        effect: "read_only",
        approval: "request_policy",
      })),
    },
    implementation: vi.fn(async () => ({ ok: true, output: "fixture", producedNewInformation: true })),
  };
}

function publicTools() {
  return [
    publicTool("web_search", "web", ["search_one"]),
    publicTool("system_probe", "system-probe", ["inspect_system_state"]),
  ];
}

function readOptions(tools: ToolRegistry, mode: ToolPermissionMode = "ask", deny?: string[]) {
  return readSparkHomeCalibrationOptions({
    tools, toolPermissionMode: mode, ...(deny ? { modelPlugins: { deny } } : {}),
  });
}

describe("SPARK HOME calibration capability choices", () => {
  test("cold start offers local widgets and retains unavailable choices without personal defaults", () => {
    const options = readOptions(createConfiguredToolRegistry(undefined, []));
    expect(options.map(({ id, available }) => ({ id, available }))).toEqual([
      { id: "calendar", available: true },
      { id: "clock", available: true },
      { id: "web_topics", available: false },
      { id: "system_status", available: true },
    ]);
    expect(options.filter(option => !option.available).every(option => Boolean(option.reason))).toBe(true);
    expect(options.filter(option => option.available).every(option => option.reason === null)).toBe(true);
    expect(options.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(options)).toBe(true);
  });

  test("projects loaded public operations in ASK without preparing or executing plugins", () => {
    const modules = publicTools();
    const tools = createConfiguredToolRegistry(undefined, modules);
    const prepareRequest = vi.fn(async () => tools);
    const options = readOptions({ ...tools, prepareRequest });
    expect(options.every(option => option.available)).toBe(true);
    expect(prepareRequest).not.toHaveBeenCalled();
    for (const module of modules) expect(module.implementation).not.toHaveBeenCalled();
    expect(tools.listNormalInvocations?.().every(registration =>
      registration.contract.operations.every(operation => operation.approval === "request_policy"),
    )).toBe(true);
  });

  test.each(["web", "web_search", "web.web_search", "*"])(
    "uses shared selected-model restrictions for %s without mutating other requests",
    selector => {
      const tools = createConfiguredToolRegistry(undefined, publicTools());
      const restricted = readOptions(tools, "full_plus", [selector]);
      expect(restricted.find(option => option.id === "web_topics")?.available).toBe(false);
      expect(restricted.filter(option => ["calendar", "clock", "system_status"].includes(option.id))
        .every(option => option.available)).toBe(true);
      expect(readOptions(tools).every(option => option.available)).toBe(true);
      expect(tools.listNormalInvocations?.()).toHaveLength(2);
    },
  );

  test("private tools cannot enable public discovery or change native widget availability", () => {
    const tools = createConfiguredToolRegistry(undefined, [
      publicTool("rss_news", "private-rss", ["search_one"]),
      publicTool("web_search", "private-search", ["search_one"]),
      publicTool("system_probe", "private-probe", ["inspect_system_state"]),
    ]);
    expect(readOptions(tools).filter(option => option.available).map(option => option.id))
      .toEqual(["calendar", "clock", "system_status"]);
  });

  test("fetch-only access cannot promise discovery while native status needs no probe", () => {
    const tools = createConfiguredToolRegistry(undefined, [
      publicTool("web_fetch", "web", ["fetch_one"]),
      publicTool("system_probe", "system-probe", ["inspect_disk_state_for_path"]),
    ]);
    expect(readOptions(tools).filter(option => option.available).map(option => option.id))
      .toEqual(["calendar", "clock", "system_status"]);
  });

  test("supports either declared search operation and requires an invocation registration", () => {
    const tools = createConfiguredToolRegistry(undefined, [publicTool("web_search", "web", ["search_many"])]);
    expect(readOptions(tools).find(option => option.id === "web_topics")?.available).toBe(true);
    expect(readOptions({ ...tools, listNormalInvocations: undefined })
      .find(option => option.id === "web_topics")?.available).toBe(false);
  });

  test("preserves required permission modes and does not treat scheduled Full as Full+", () => {
    const module = publicTool("web_search", "web", ["search_one"]);
    module.definition.requiredPermissionMode = "full_plus";
    const tools = createConfiguredToolRegistry(undefined, [module]);
    for (const mode of ["ask", "full_access"] as const)
      expect(readOptions(tools, mode).find(option => option.id === "web_topics")?.available).toBe(false);
    expect(readOptions(tools, "full_plus").find(option => option.id === "web_topics")?.available).toBe(true);
    expect(readOptions(tools, "full_plus", ["web"])
      .find(option => option.id === "web_topics")?.available).toBe(false);
  });

  test.each(["ask", "full_access", "full_plus"] as const)("native status binds a registered widget even when all plugins are denied in %s", mode => {
    const modules = publicTools();
    const tools = createConfiguredToolRegistry(undefined, modules);
    const options = readOptions(tools, mode, ["*"]);
    const [selected] = assertAvailableSparkHomeCalibrationOptions(["system_status"], options);
    expect(selected).toMatchObject({ available: true, nativeWidgetId: "system-metrics", reason: null });
    expect(findSparkHomeWidget(selected.nativeWidgetId)).toMatchObject({ id: "system-metrics", group: "monitoring" });
    expect(options.filter(option => option.id !== "system_status").every(option => option.nativeWidgetId === undefined)).toBe(true);
    for (const module of modules) expect(module.implementation).not.toHaveBeenCalled();
    expect(tools.listNormalInvocations?.()).toHaveLength(2);
  });

  test("keeps a lost capability visible and rejects its selection at the fresh draft boundary", () => {
    const tools = createConfiguredToolRegistry(undefined, publicTools());
    const selectedIds = ["web_topics", "calendar"];
    expect(assertAvailableSparkHomeCalibrationOptions(selectedIds, readOptions(tools))
      .map(option => option.id)).toEqual(selectedIds);
    const changed = readOptions(tools, "ask", ["web"]);
    expect(changed.find(option => option.id === "web_topics"))
      .toMatchObject({ available: false, reason: expect.any(String) });
    expect(() => assertAvailableSparkHomeCalibrationOptions(selectedIds, changed))
      .toThrow("spark_home_calibration_options_changed");
    expect(selectedIds).toEqual(["web_topics", "calendar"]);
    expect(assertAvailableSparkHomeCalibrationOptions(["calendar"], changed))
      .toHaveLength(1);
  });

  test.each([{ selectedIds: ["weather"] }, { selectedIds: ["calendar", "calendar"] }])(
    "rejects unknown or duplicate selection $selectedIds", ({ selectedIds }) => {
      expect(() => assertAvailableSparkHomeCalibrationOptions(selectedIds, readOptions(createConfiguredToolRegistry(undefined, []))))
        .toThrow("spark_home_calibration_options_changed");
    },
  );
});
