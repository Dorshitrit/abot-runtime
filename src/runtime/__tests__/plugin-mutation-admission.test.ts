import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, expect, test, vi } from "vitest";
import { RuntimeEnvironmentRegistry } from "../../web-ui/local-runtime/environment-registry.js";
import { PluginManagementRoutes } from "../../web-ui/local-runtime/plugin-management-routes.js";
import type { RuntimeEnvironment } from "../../web-ui/local-runtime/contracts.js";
import { setRuntimePluginEnabled } from "../../web-ui/plugin-management-service.js";
import { removeRuntimePlugin } from "../../web-ui/plugin-removal-service.js";
import {
  installPluginPackage,
  inspectPluginPackage,
} from "../plugins/installation/service.js";
import { installedRemovalFixture } from "./support/plugin-removal-fixture.js";
import {
  communityArchive,
  communityManifest,
  pluginSource,
  sourceFetcher,
} from "./support/plugin-installation-fixture.js";

afterEach(() => vi.unstubAllGlobals());
function runtime() {
  const registry = new RuntimeEnvironmentRegistry({
    defaultEnvironmentId: "dev",
  });
  const environments = (
    registry as unknown as { environments: Map<string, RuntimeEnvironment> }
  ).environments;
  const activity = {
    idle: true,
    ownership: "owner" as "owner" | "client" | undefined,
    queued: false,
  };
  environments.set("dev", {
    getOwnership: () => "owner",
    isOwnerIdle: () => true,
  } as RuntimeEnvironment);
  environments.set("jobs", {
    getOwnership: () => activity.ownership,
    isOwnerIdle: () => activity.idle,
  } as RuntimeEnvironment);
  return {
    registry,
    activity,
    requireMutationIdle: () =>
      registry.requirePluginMutationIdle(activity.queued),
  };
}
async function request(
  routes: PluginManagementRoutes,
  method: string,
  route: string,
  body = {},
) {
  let status = 0;
  let payload: any;
  const response = {
    writeHead: (code: number) => {
      status = code;
    },
    end: (text: string) => {
      payload = JSON.parse(text);
    },
  } as unknown as ServerResponse;
  await routes.handle({
    method,
    route,
    body,
    response,
    request: {
      headers: { host: "localhost:5177", "content-type": "application/json" },
      socket: {},
    } as IncomingMessage,
  });
  return { status, payload };
}

test.each(["owner", "queued"])(
  "all plugin mutations reject %s activity without saving or applying",
  async (source) => {
    const f = await installedRemovalFixture();
    const rt = runtime();
    if (source === "owner") rt.activity.idle = false;
    else rt.activity.queued = true;
    const routes = new PluginManagementRoutes({
      rootDir: f.rootDir,
      getConfigPath: () => f.configPath,
      removalRuntime: f,
      requireMutationIdle: rt.requireMutationIdle,
    });
    const before = await readFile(f.configPath, "utf8");
    for (const enabled of [true, false]) {
      const result = await request(routes, "PUT", "runtime/plugins", {
        ...f.input,
        enabled,
      });
      expect(result).toMatchObject({
        status: 409,
        payload: { error: "plugin_runtime_busy" },
      });
    }
    for (const operation of ["install", "remove"]) {
      const result = await request(
        routes,
        "POST",
        "runtime/plugins/" + operation,
        f.input,
      );
      expect(result).toMatchObject({
        status: 409,
        payload: { error: "plugin_runtime_busy" },
      });
    }
    expect(await readFile(f.configPath, "utf8")).toBe(before);
    expect(existsSync(f.path)).toBe(true);
    expect(f.applyConfiguration).not.toHaveBeenCalled();
    expect((await request(routes, "GET", "runtime/plugins")).status).toBe(200);
    const archive = await communityArchive({
      manifest: communityManifest("other", "other_ping"),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("codeload")
          ? new Response(new Uint8Array(archive))
          : new Response(JSON.stringify({ sha: pluginSource.ref })),
      ),
    );
    expect(
      (await request(routes, "POST", "runtime/plugins/inspect", pluginSource))
        .status,
    ).toBe(200);
  },
);

test("idle open environments allow changes; external or unknown owners fail closed", async () => {
  const f = await installedRemovalFixture();
  const rt = runtime();
  const routes = new PluginManagementRoutes({
    rootDir: f.rootDir,
    getConfigPath: () => f.configPath,
    requireMutationIdle: rt.requireMutationIdle,
  });
  expect(
    (
      await request(routes, "PUT", "runtime/plugins", {
        ...f.input,
        enabled: false,
      })
    ).status,
  ).toBe(200);
  for (const ownership of ["client", undefined] as const) {
    rt.activity.ownership = ownership;
    expect(() => rt.requireMutationIdle()).toThrow("cannot verify");
  }
});

test.each(["selection", "removal"])(
  "%s rechecks activity inside the configuration write",
  async (operation) => {
    const f = await installedRemovalFixture();
    const rt = runtime();
    rt.activity.idle = false;
    const before = await readFile(f.configPath, "utf8");
    const options = { ...f, requireMutationIdle: rt.requireMutationIdle };
    await expect(
      operation === "selection"
        ? setRuntimePluginEnabled(options, { ...f.input, enabled: false })
        : removeRuntimePlugin(options, f.input),
    ).rejects.toMatchObject({ code: "plugin_runtime_busy" });
    expect(await readFile(f.configPath, "utf8")).toBe(before);
    expect(f.applyConfiguration).not.toHaveBeenCalled();
  },
);

test("a run starting during download prevents publication of the prepared package", async () => {
  const f = await installedRemovalFixture();
  const rt = runtime();
  const download = sourceFetcher(
    await communityArchive({
      manifest: communityManifest("other", "other_ping"),
    }),
  );
  const review = await inspectPluginPackage(f.rootDir, pluginSource, download);
  const saveSelection = vi.fn();
  await expect(
    installPluginPackage({
      rootDir: f.rootDir,
      input: { source: review.source, digest: review.digest },
      download: async (source) => {
        rt.activity.idle = false;
        return download(source);
      },
      requireMutationIdle: rt.requireMutationIdle,
      saveSelection,
    }),
  ).rejects.toMatchObject({ code: "plugin_runtime_busy" });
  expect(existsSync(join(f.rootDir, "plugins/other"))).toBe(false);
  expect(saveSelection).not.toHaveBeenCalled();
});
