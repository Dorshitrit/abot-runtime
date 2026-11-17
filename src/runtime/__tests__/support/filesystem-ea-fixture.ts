import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolRegistry } from "../../../capabilities/registry.js";
import { createRuntimeToolPathResolver } from "../../capabilities/runtime-target-path.js";
import { RequestToolState } from "../../capabilities/request-tool-state.js";
import { prepareRequestToolModules } from "../../capabilities/request-module-preparation.js";
import { loadConfiguredRuntimePlugins, runtimePluginsToToolModules } from "../../plugins/loader.js";
import { prepareEaRequest } from "../../../../plugins/filesystem-ea/source/prepare-request.js";
import { loadPublicRuntimeConfig } from "../public-runtime-config-fixture.js";
import type { ToolRegistry } from "../../ports.js";
import { createRegisteredToolNormalInvocationExecutor } from "../../adapters/registered-tool-normal-invocations.js";

export async function eaFixture() {
  const root = await mkdtemp(join(tmpdir(), "ea-files-"));
  const config = loadPublicRuntimeConfig(["filesystem", "filesystem-ea"]);
  const paths = { ...config.paths, agentWorkDir: join(root, "work"), workspaceDir: join(root, "workspace") };
  await Promise.all([mkdir(paths.agentWorkDir), mkdir(paths.workspaceDir)]);
  const resolver = createRuntimeToolPathResolver(paths);
  const plugins = loadConfiguredRuntimePlugins(config);
  const modules = runtimePluginsToToolModules(plugins.filter((plugin) => plugin.id === "filesystem-ea"));
  const legacy = runtimePluginsToToolModules(plugins.filter((plugin) => plugin.id === "filesystem"));
  async function request(options: { requestId?: string; enabled?: boolean; rootContractId?: string; state?: unknown; permission?: "ask" | "full_access" } = {}) {
    const state = new RequestToolState();
    if (options.state) state.restore(options.state);
    const enabled = options.enabled ?? true;
    const owner = Object.hasOwn(options, "rootContractId") ? options.rootContractId : "execution_agent";
    const prepare = prepareEaRequest(enabled);
    const selected = modules.map((module) => ({ ...module, prepareRequest: prepare }));
    const prepared = await prepareRequestToolModules(selected, {
      requestId: options.requestId ?? "ea-request",
      rootContractId: owner, runtimePathResolver: resolver, requestState: state.port,
    });
    state.assertRestoredStateClaimed();
    const registry = createToolRegistry({ modules: prepared });
    const port: ToolRegistry = {
      listDefinitions: registry.getDefinitions, listNormalInvocations: registry.getNormalInvocations,
      getDefinition: registry.getByName, hasToolsAvailable: registry.hasToolsAvailable,
      getImplementations: registry.getImplementations,
      prepareSharedState: (sharedState) => ({ ...sharedState, runtimePaths: paths }),
      async execute(call, options) {
        const handler = registry.getImplementations()[call.tool];
        if (!handler) return { tool: call.tool, ok: false, output: "Unavailable", errorCode: "unavailable", producedNewInformation: false };
        return { tool: call.tool, ...await handler(call.params, { ...options, runtimePathResolver: resolver }) };
      },
    };
    const events: { name: string; [key: string]: unknown }[] = [];
    const executor = createRegisteredToolNormalInvocationExecutor({
      registrations: registry.getNormalInvocations(), toolRegistry: port,
      requestId: "ea-request", abortSignal: new AbortController().signal,
      toolPermissionMode: options.permission ?? "full_access", nextApprovalId: () => "ea-approval",
      onEvent: (name, event) => events.push({ name, ...event }),
    });
    async function prepareBody(tool: string, controls: Record<string, unknown>, body: string) {
      const projection = executor.operations.find((entry) => entry.operation.operationId === tool)!;
      const source = await projection.preparePayload!(controls);
      const payload = source.bind(body);
      const prepared = await executor.prepare({ handle: projection.handle, controls, payload });
      if (prepared.status !== "prepared") throw new Error(prepared.code);
      return { prepared, source, payload, projection };
    }
    return { state, registry, port, executor, prepareBody, events };
  }
  return { root, paths, resolver, modules, legacy, request, dispose: () => rm(root, { recursive: true, force: true }) };
}
