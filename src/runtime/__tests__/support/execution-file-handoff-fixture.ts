import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfiguredToolRegistry } from "../../capabilities/configured-tool-registry.js";
import { createRuntimeToolPathResolver } from "../../capabilities/runtime-target-path.js";
import { RequestToolState } from "../../capabilities/request-tool-state.js";
import { loadConfiguredRuntimePlugins, runtimePluginsToToolModules } from "../../plugins/loader.js";
import { createRequestWorkerCapabilityProvider } from "../../request/worker-capability-composition.js";
import { createTestRequestExecutionScopeWithCapabilities } from "./request-execution-scope.js";
import { loadPublicRuntimeConfig } from "../public-runtime-config-fixture.js";
import { filePayloadFixture } from "./execution-file-payload-fixture.js";
import { filePayloadOutput } from "./execution-file-output-fixture.js";
import type { ModelGatewayClient, ToolPermissionMode } from "../../ports.js";

export const toolSelection = (path = "dependency.txt") => ({
  action: "invoke_capability", capabilityId: "read_text", selectionControls: { path },
});
export const createSelection = (path = "target.txt") => ({
  action: "invoke_capability", capabilityId: "create_text", operationObjective: `Write ${path} using the exact dependency.`,
  selectionControls: { path },
});
export type HandoffModelInput = Parameters<ModelGatewayClient["invoke"]>[0];

export async function fileHandoffFixture(permission: ToolPermissionMode = "full_access") {
  const root = await mkdtemp(join(tmpdir(), "ea-handoff-"));
  const base = loadPublicRuntimeConfig(["filesystem-ea"]);
  const config = { ...base, paths: { ...base.paths, agentWorkDir: root, workspaceDir: join(root, "workspace") } };
  await mkdir(config.paths.workspaceDir, { recursive: true });
  const f = await filePayloadFixture();
  const states: RequestToolState[] = [];
  const inputs: HandoffModelInput[] = [];
  const events: { name: string; [key: string]: unknown }[] = [];
  let rootCalls = 0;
  const authors: Array<(input: HandoffModelInput) => string | Promise<string>> = [];
  f.invoke.mockImplementation(async (input) => {
    inputs.push(input);
    if (input.modelStep === "execution.file_payload.raw") {
      const author = authors.shift();
      if (!author) throw new Error("unexpected_file_author");
      return { text: await author(input), meta: {} };
    }
    if (input.modelStep === "execution.response") return { text: "Done.", meta: {} };
    if (input.modelStep !== "execution.decision") throw new Error(`unexpected_step:${input.modelStep}`);
    rootCalls++;
    const decision = rootCalls === 1 ? { action: "open_capability_scope", catalogGroupIds: ["read", "write"] }
      : rootCalls === 2 ? { ...createSelection(), workingDirectory: null } : { action: "respond" };
    return { text: JSON.stringify({ decision }), meta: {} };
  });
  async function compose(snapshot?: unknown) {
    const state = new RequestToolState();
    states.push(state);
    if (snapshot) state.restore(snapshot);
    const registry = createConfiguredToolRegistry(config, runtimePluginsToToolModules(loadConfiguredRuntimePlugins(config)));
    const preparedRegistry = await registry.prepareRequest!({
      requestId: f.request.requestId, rootContractId: "execution_agent",
      runtimePathResolver: createRuntimeToolPathResolver(config.paths), requestState: state.port,
    });
    state.assertRestoredStateClaimed();
    const request = createTestRequestExecutionScopeWithCapabilities({
      ...f.request, toolPermissionMode: permission,
      ...(permission === "ask" ? { approvalGate: { resolve: async () => ({ kind: "awaiting_approval" as const }) } } : {}),
      onEvent: (name, value) => events.push({ name, ...value }),
    }, (view) => createRequestWorkerCapabilityProvider({
      request: view, runtimeConfig: config, toolRegistryOverride: preparedRegistry,
      executionPolicyAuthority: f.request.executionPolicy.authority,
    }), { executionPolicy: f.request.executionPolicy });
    return { request, state };
  }
  const initial = await compose();
  return { ...f, ...initial, root, inputs, events, authors, compose,
    tool(input: HandoffModelInput, selection: unknown = toolSelection()) {
      return filePayloadOutput(input.messages, JSON.stringify({ decision: selection }), "tool");
    },
    async dispose() {
      await Promise.all(states.map((state) => state.dispose()));
      await rm(root, { recursive: true, force: true });
    },
  };
}
