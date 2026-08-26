import { describe, expect, test } from "vitest";

import { loadConfiguredRuntimePlugins } from "../plugins/loader.js";
import { loadPublicRuntimeConfig } from "./public-runtime-config-fixture.js";

function loadPublicProjectInspectionPlugins() {
  return loadConfiguredRuntimePlugins(
    loadPublicRuntimeConfig(["project-orientation", "code-outline"]),
  );
}

describe("project inspection manifest plugin parity", () => {
  test("compiles the public declarations into the existing capabilities", () => {
    const plugins = loadPublicProjectInspectionPlugins();

    expect(plugins.map(({ id }) => id)).toEqual([
      "code-outline",
      "project-orientation",
    ]);
    expect(
      plugins.map((plugin) => ({
        id: plugin.id,
        toolName: plugin.capabilities[0]?.definition.name,
        operationId:
          plugin.capabilities[0]?.normalInvocation.operations[0]?.operationId,
        routingCapability: plugin.capabilities[0]?.definition.routingCapability,
        runtimePathBindings:
          plugin.capabilities[0]?.definition.runtimePathBindings,
        effect: plugin.capabilities[0]?.normalInvocation.operations[0]?.effect,
        approval:
          plugin.capabilities[0]?.normalInvocation.operations[0]?.approval,
        skills: Object.keys(plugin.skills ?? {}),
      })),
    ).toEqual([
      {
        id: "code-outline",
        toolName: "inspect_code_outline",
        operationId: "inspect_code_outline",
        routingCapability: "semantic_lookup",
        runtimePathBindings: [
          {
            operationId: "inspect_code_outline",
            param: "path",
            base: "worker_working_directory",
          },
        ],
        effect: "read_only",
        approval: "request_policy",
        skills: ["code_outline_skill"],
      },
      {
        id: "project-orientation",
        toolName: "inspect_project",
        operationId: "inspect_project",
        routingCapability: "semantic_lookup",
        runtimePathBindings: [
          {
            operationId: "inspect_project",
            param: "path",
            base: "worker_working_directory",
            default: ".",
          },
        ],
        effect: "read_only",
        approval: "request_policy",
        skills: ["project_orientation_skill"],
      },
    ]);
  });
});
