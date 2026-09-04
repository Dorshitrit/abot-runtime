import { describe, expect, test, vi } from "vitest";

import { createDefaultToolRegistry } from "../default-adapters.js";
import { loadPublicRuntimeConfig } from "./public-runtime-config-fixture.js";
import { loadBundledPluginEntrypoint } from "./public-plugin-test-support.js";

describe("system-probe plugin parity", () => {
  test("exposes the baseline system_probe contract from one plugin declaration", () => {
    const config = loadPublicRuntimeConfig(["system-probe"]);
    const registry = createDefaultToolRegistry({
      ...config,
      plugins: { enabled: true, allow: ["system-probe"] },
    });

    expect(registry.listDefinitions().map(({ name }) => name)).toEqual([
      "system_probe",
    ]);
    expect(registry.getDefinition("system_probe")).toMatchObject({
      routingCapability: "filesystem_inspection",
      developmentRoles: ["inspect", "verify"],
      controlsRefinement: "mechanical_when_complete",
      eventPresentation: {
        metadata: {
          path: { param: "path", kind: "string", default: "/" },
        },
      },
    });
    expect(Object.keys(registry.getImplementations())).toEqual([
      "system_probe",
    ]);

    const registrations = registry.listNormalInvocations?.() ?? [];
    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.toolName).toBe("system_probe");
    expect(registrations[0]?.contract).toEqual({
      version: 1,
      operations: [
        {
          operationId: "inspect_system_state",
          summary:
            "Inspect current uptime, load, memory, CPU and root-filesystem disk state.",
          input: {
            type: "object",
            additionalProperties: false,
            properties: {},
            required: [],
          },
          effect: "read_only",
          approval: "request_policy",
        },
        {
          operationId: "inspect_disk_state_for_path",
          summary:
            "Inspect machine state while scoping disk statistics to one explicit existing filesystem path.",
          input: {
            type: "object",
            additionalProperties: false,
            properties: {
              path: {
                type: "string",
                minLength: 1,
                maxLength: 4_096,
              },
            },
            required: ["path"],
          },
          effect: "read_only",
          approval: "request_policy",
        },
      ],
    });
  });

  test("delegates the default root-filesystem probe to the runtime path authority", async () => {
    const resolve = vi.fn(() => ({
      location: "host_system",
      rootPath: "/",
      absolutePath: "/",
      relativePath: "",
      logicalPath: "/",
    }));
    const createPlugin = loadBundledPluginEntrypoint<
      Readonly<Record<string, unknown>>,
      Readonly<{
        handlers: Readonly<{
          system_probe: (
            params: Record<string, unknown>,
          ) => Promise<Record<string, unknown>>;
        }>;
      }>
    >("system-probe");
    const handler = createPlugin({
      runtimePathResolver: { resolve },
    }).handlers.system_probe;

    const result = await handler({});
    expect(result).toMatchObject({
      ok: true,
      output: expect.stringContaining("disk_path: /"),
      data: {
        diskPath: "/",
        diskStatus: "available",
      },
    });
    expect(result.output).not.toContain("hostname:");
    expect(result.output).not.toContain("resolved_disk_path:");
    expect(resolve).toHaveBeenCalledWith("/", {
      requirePath: true,
      allowedLocations: ["agent_work", "workspace", "host_system"],
    });
  });
});
