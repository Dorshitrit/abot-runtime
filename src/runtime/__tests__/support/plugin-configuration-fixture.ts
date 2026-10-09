import { configureDebugLogger } from "../../observability/debug-logger.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { communityManifest } from "./plugin-installation-fixture.js";
import { PluginManagementRoutes } from "../../../web-ui/local-runtime/plugin-management-routes.js";
import {
  getRuntimePluginConfiguration,
  saveRuntimePluginConfiguration,
} from "../../../web-ui/plugin-configuration-service.js";
import {
  createPluginSelectionFixture,
  removePluginSelectionFixtures,
} from "../plugin-selection-fixture.js";

const roots: string[] = [];
beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await removePluginSelectionFixtures();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

export function configurableManifest() {
  const base = communityManifest();
  return {
    ...base,
    extensions: {
      "ai.abot.runtime": {
        ...base.extensions["ai.abot.runtime"],
        settings: {
          defaults: {
            query: "default query",
            url: "https://example.test",
            limit: 3,
            enabled: true,
            options: { language: "en" },
            tags: [],
            extra: null,
          },
        },
        secrets: {
          token: { env: "ABOT_CONFIGURATION_TEST_TOKEN", required: true },
          optional: {
            env: "ABOT_CONFIGURATION_OPTIONAL_TOKEN",
            required: false,
          },
        },
      },
    },
  };
}
export const configurationCode = `module.exports = (context) => ({ handlers: { community_ping: async () => ({ ok: true, output: JSON.stringify({ config: context.config, token: context.secrets.get('token'), optional: context.secrets.get('optional') }), producedNewInformation: true }) } });`;

export async function pluginConfigurationFixture(installed = true) {
  const base = join(
    process.cwd(),
    ".codex/artifacts/plugin-configuration-20261007/tests",
  );
  await mkdir(base, { recursive: true });
  const rootDir = await mkdtemp(join(base, "configuration-"));
  roots.push(rootDir);
  const configPath = join(rootDir, "runtime.config.json");
  await writeFile(
    configPath,
    JSON.stringify({ plugins: { allow: ["community-example"] } }),
  );
  const pluginRoot = join(rootDir, "plugins/community-example");
  if (installed) {
    await mkdir(join(pluginRoot, "src"), { recursive: true });
    await writeFile(
      join(pluginRoot, "plugin.json"),
      JSON.stringify(configurableManifest()),
    );
    await writeFile(join(pluginRoot, "src/index.cjs"), configurationCode);
  }
  const options = { rootDir, configPath };
  const config = await createPluginSelectionFixture({
    allow: ["community-example"],
  });
  return {
    ...options,
    pluginRoot,
    config: { ...config, paths: { ...config.paths, rootDir } },
    routes: new PluginManagementRoutes({
      rootDir,
      getConfigPath: () => configPath,
    }),
    view: () => getRuntimePluginConfiguration(options, "community-example"),
    save: (
      settings: Record<string, unknown>,
      secrets: Record<string, unknown> = {},
    ) =>
      saveRuntimePluginConfiguration(options, {
        pluginId: "community-example",
        input: {
          revision: getRuntimePluginConfiguration(options, "community-example")
            .revision,
          settings,
          secrets,
        },
      }),
  };
}

export async function configurationRequest(
  routes: PluginManagementRoutes,
  method: string,
  body: Record<string, unknown> | null = null,
  route = "runtime/plugins/configuration/community-example",
  headers: Record<string, string> = {},
) {
  let status = 0;
  let payload: any;
  const responseHeaders: Record<string, string> = {};
  await routes.handle({
    method,
    route,
    body,
    request: {
      headers: {
        host: "localhost:5177",
        "content-type": "application/json",
        ...headers,
      },
      socket: {},
    } as IncomingMessage,
    response: {
      setHeader: (key: string, value: string) => {
        responseHeaders[key] = value;
      },
      writeHead: (code: number) => {
        status = code;
      },
      end: (raw: string) => {
        payload = JSON.parse(raw);
      },
    } as unknown as ServerResponse,
  });
  return { status, payload, headers: responseHeaders };
}
