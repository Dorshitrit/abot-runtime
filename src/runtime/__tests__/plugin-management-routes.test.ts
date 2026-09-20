import type { ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { PluginManagementRoutes } from "../../web-ui/local-runtime/plugin-management-routes.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "plugin-management-routes-"));
  roots.push(rootDir);
  const configPath = join(rootDir, "runtime.config.json");
  await writeFile(
    configPath,
    JSON.stringify({ plugins: { allow: ["system-probe"] } }),
  );
  let selectedConfigPath = configPath;
  const routes = new PluginManagementRoutes({
    rootDir,
    getConfigPath: () => selectedConfigPath,
  });
  return {
    rootDir,
    configPath,
    routes,
    setPath: (value: string) => {
      selectedConfigPath = value;
    },
  };
}

async function request(
  routes: PluginManagementRoutes,
  method: string,
  body: Record<string, unknown> | null = null,
  route = "runtime/plugins",
) {
  let status = 0;
  let payload: Record<string, any> = {};
  const response = {
    writeHead: vi.fn((value: number) => {
      status = value;
    }),
    end: vi.fn((value: string) => {
      payload = JSON.parse(value);
    }),
  } as unknown as ServerResponse;
  const handled = await routes.handle({ method, route, body, response });
  return { handled, status, payload };
}

describe("plugin management routes", () => {
  test("reads current dynamic config and returns only metadata", async () => {
    const { routes, rootDir, setPath } = await fixture();
    const first = await request(routes, "GET");
    expect(first.status).toBe(200);
    expect(first.payload.selection.allow).toEqual(["system-probe"]);
    expect(
      first.payload.plugins.find(
        (plugin: { id: string }) => plugin.id === "system-probe",
      ).state,
    ).toBe("enabled");

    const secondPath = join(rootDir, "next.config.json");
    await writeFile(
      secondPath,
      JSON.stringify({ plugins: { enabled: false } }),
    );
    setPath(secondPath);
    const second = await request(routes, "GET");
    expect(second.payload.selection.enabled).toBe(false);
  });

  test("PUT persists configured state and reports pending application", async () => {
    const { routes, configPath } = await fixture();
    const result = await request(routes, "PUT", {
      pluginId: "system-probe",
      enabled: false,
    });
    expect(result.status).toBe(200);
    expect(result.payload).toMatchObject({
      ok: true,
      restartRequired: true,
      application: "restart_required",
    });
    expect(JSON.parse(await readFile(configPath, "utf8")).plugins.deny).toEqual(
      ["system-probe"],
    );
    expect(result.payload).not.toHaveProperty("file");
  });

  test("reports validation errors without writing and does not claim unknown routes", async () => {
    const { routes } = await fixture();
    expect(
      (await request(routes, "PUT", { pluginId: "absent", enabled: true }))
        .status,
    ).toBe(404);
    expect(
      (await request(routes, "PUT", { pluginId: "system-probe", enabled: 1 }))
        .status,
    ).toBe(400);
    expect((await request(routes, "POST")).status).toBe(405);
    expect((await request(routes, "GET", null, "unrelated")).handled).toBe(
      false,
    );
  });

  test("unexpected parse failures do not expose source contents", async () => {
    const { routes, configPath } = await fixture();
    await writeFile(configPath, "{private-sensitive-config");
    const result = await request(routes, "GET");
    expect(result.status).toBe(500);
    expect(JSON.stringify(result.payload)).not.toContain(
      "private-sensitive-config",
    );
  });

  test("capability PUT returns the scoped projection and preserves unrelated selections", async () => {
    const { routes, configPath } = await fixture();
    const result = await request(routes, "PUT", {
      pluginId: "system-probe",
      capabilityId: "system_probe",
      enabled: false,
    });
    expect(result.status).toBe(200);
    expect(
      result.payload.plugins.find(
        (plugin: { id: string }) => plugin.id === "system-probe",
      ),
    ).toMatchObject({
      pluginEnabled: true,
      selectedCapabilityCount: 0,
      capabilities: [
        { id: "system_probe", enabled: false, blockedByPolicy: false },
      ],
    });
    expect(JSON.parse(await readFile(configPath, "utf8")).plugins).toEqual({
      allow: ["system-probe"],
      deny: ["system-probe.system_probe"],
    });
    const enabled = await request(routes, "PUT", {
      pluginId: "system-probe",
      capabilityId: "system_probe",
      enabled: true,
    });
    expect(enabled.status).toBe(200);
    expect(
      enabled.payload.plugins.find(
        (plugin: { id: string }) => plugin.id === "system-probe",
      ).capabilities[0].enabled,
    ).toBe(true);
  });

  test.each(["", null, 3])(
    "capability ID must be a non-empty string: %j",
    async (capabilityId) => {
      const { routes, configPath } = await fixture();
      const before = await readFile(configPath, "utf8");
      const result = await request(routes, "PUT", {
        pluginId: "system-probe",
        capabilityId,
        enabled: true,
      });
      expect(result.status).toBe(400);
      expect(await readFile(configPath, "utf8")).toBe(before);
    },
  );
});
