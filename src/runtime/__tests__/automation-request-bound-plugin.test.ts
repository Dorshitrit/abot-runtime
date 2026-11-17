import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { createRuntimeToolPathResolver } from "../capabilities/runtime-target-path.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { loadConfiguredRuntimePlugins, runtimePluginsToToolModules } from "../plugins/loader.js";
import type { AutomationDraftRecord } from "../automations/storage-records.js";
import { loadPublicRuntimeConfig } from "./public-runtime-config-fixture.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";

type RuntimeFixture = Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>;
type Studio = NonNullable<RuntimeFixture["application"]["services"]["automations"]>;
const fixtures: { runtime: RuntimeFixture; root: string }[] = [];
const operation = { toolName: "read_text", operationId: "read_text", contractVersion: 1 } as const;
beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async ({ runtime, root }) => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }));
  resetDebugLoggerConfig();
});

async function setup(policy: "execution-agent-v1" | "supervisor-worker-v1" = "execution-agent-v1") {
  const root = await mkdtemp(join(tmpdir(), "automation-request-bound-"));
  try {
    const base = loadPublicRuntimeConfig(["filesystem-ea"]);
    const config = { ...base, paths: { ...base.paths,
      agentWorkDir: join(root, "work"), workspaceDir: join(root, "workspace") } };
    await Promise.all([mkdir(config.paths.agentWorkDir), mkdir(config.paths.workspaceDir)]);
    const modules = runtimePluginsToToolModules(loadConfiguredRuntimePlugins(config));
    const registry = createConfiguredToolRegistry(config, modules);
    const prepare = vi.spyOn(registry, "prepareRequest");
    const runtime = await createSchedulerRuntimeFixture(policy, undefined, registry);
    fixtures.push({ runtime, root });
    return { runtime, config, registry, prepare,
      studio: runtime.application.services.automations! };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function createDraft(studio: Studio, workingDirectory: string) {
  const created = await studio.create("Request-bound file observation");
  return studio.updateDraft(created.automationId, created.revision, {
    kind: "update_definition", patch: { workingDirectory },
  });
}

async function addReader(studio: Studio, draft: AutomationDraftRecord, kind: "agent" | "tool") {
  return studio.updateDraft(draft.automationId, draft.revision, {
    kind: "add_node", parentSequenceId: draft.definition.body.id, index: 0,
    nodeWithoutId: kind === "tool"
      ? { kind: "tool", title: "Read", onFailure: "stop", operation,
          controls: { path: { kind: "literal", value: "notes.txt" } } }
      : { kind: "agent", title: "Read", onFailure: "stop",
          modelProfileId: "scheduled-model", agentMode: "reasoning",
          roleInstructions: "Read the selected file and report its content.",
          prompt: "Read notes.txt.", inputs: {},
          tools: [{ operation, usage: "required" }], result: { kind: "text" } },
  });
}

async function grantRead(studio: Studio, automationId: string) {
  await studio.replaceGrant({ automationId, expectedGrantRevision: 0,
    mode: "full_access", operations: [operation], actionId: "explicit-file-read-grant" });
}

test("real EA file operations are discoverable without binding and execute only within the Agent request", async () => {
  const { runtime, config, prepare, studio } = await setup();
  let draft = await createDraft(studio, config.paths.agentWorkDir);
  const catalog = await studio.catalog(draft.automationId);
  expect(catalog.operations).toEqual([]);
  expect(catalog.grantableOperations.map(({ operationId }) => operationId).sort())
    .toEqual(["create_text", "edit_text", "read_text"]);
  for (const entry of catalog.grantableOperations) {
    expect(entry).toMatchObject({ requiresRequestBinding: true, executionPolicies: ["execution-agent-v1"] });
  }
  expect(prepare).not.toHaveBeenCalled();
  expect(runtime.invoke).not.toHaveBeenCalled();
  expect(runtime.invokeRaw).not.toHaveBeenCalled();

  await grantRead(studio, draft.automationId);
  expect((await studio.catalog(draft.automationId)).operations)
    .toEqual([expect.objectContaining(operation)]);
  draft = await addReader(studio, draft, "agent");
  await studio.publish(draft.automationId, draft.revision);
  expect(prepare).not.toHaveBeenCalled();
  expect(runtime.invoke).not.toHaveBeenCalled();

  const content = "request-bound-read evidence\r\nsecond line\r\n";
  const file = join(config.paths.agentWorkDir, "notes.txt");
  await writeFile(file, content);
  let decisions = 0;
  runtime.invoke.mockImplementation(async (input) => {
    if (input.modelStep === "execution.response") return { text: "The file was read.", meta: {} };
    if (input.modelStep !== "execution.decision") throw new Error(`unexpected_model_step:${input.modelStep}`);
    const actions = [
      { action: "open_capability_scope", catalogGroupIds: ["read"] },
      { action: "invoke_capability", capabilityId: "read_text", workingDirectory: ".",
        selectionControls: { path: "notes.txt", start_line: null, end_line: null, locator: null, context_lines: null } },
      { action: "respond" },
    ];
    if (decisions === 2) expect(JSON.stringify(input.messages)).toContain("request-bound-read evidence");
    const decision = actions[decisions++];
    if (!decision) throw new Error("unexpected_additional_decision");
    return { text: JSON.stringify({ decision }), meta: {} };
  });
  const launched = await studio.runNow(draft.automationId);
  await expect.poll(async () => (await studio.getRun(launched.id)).status,
    { timeout: 8_000, interval: 10 }).toBe("succeeded");
  expect(await studio.getRun(launched.id)).toMatchObject({
    report: { outcome: "succeeded", toolCalls: 1,
      nodeResults: [{ status: "succeeded" }] },
  });
  expect(prepare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    requestId: expect.any(String), rootContractId: "execution_agent", executionPolicy: "execution-agent-v1",
  }));
  expect(decisions).toBe(3);
  expect(runtime.invokeRaw).not.toHaveBeenCalled();
  expect(await readFile(file)).toEqual(Buffer.from(content));
});

test.each([
  { policy: "supervisor-worker-v1", kind: "agent" },
  { policy: "execution-agent-v1", kind: "tool" },
] as const)("$policy $kind cannot publish an incompatible request-bound operation", async ({ policy, kind }) => {
  const { runtime, config, prepare, studio } = await setup(policy);
  let draft = await createDraft(studio, config.paths.agentWorkDir);
  await grantRead(studio, draft.automationId);
  draft = await addReader(studio, draft, kind);
  await expect(studio.publish(draft.automationId, draft.revision)).rejects.toMatchObject({
    issues: expect.arrayContaining([expect.objectContaining({ code: "automation_operation_unavailable" })]),
  });
  expect(prepare).not.toHaveBeenCalled();
  expect(runtime.invoke).not.toHaveBeenCalled();
  expect(runtime.invokeRaw).not.toHaveBeenCalled();
});

test("globally disabled EA plugin contributes no discovered operations", async () => {
  const base = loadPublicRuntimeConfig(["filesystem-ea"]);
  const config = { ...base, plugins: { ...base.plugins, enabled: false } };
  const modules = runtimePluginsToToolModules(loadConfiguredRuntimePlugins(config));
  const registry = createConfiguredToolRegistry(config, modules);
  expect(await registry.discoverOperations!()).toEqual([]);
});

test("EA plugin settings disable discovery and request preparation while retaining raw declarations", async () => {
  const root = await mkdtemp(join(tmpdir(), "automation-plugin-settings-"));
  try {
    const base = loadPublicRuntimeConfig(["filesystem-ea"]);
    const config = { ...base, paths: { ...base.paths, rootDir: root,
      runtimeDir: join(root, ".runtime"), agentWorkDir: join(root, "work"),
      workspaceDir: join(root, "workspace") } };
    await Promise.all([
      mkdir(config.paths.runtimeDir, { mode: 0o700 }),
      mkdir(config.paths.agentWorkDir), mkdir(config.paths.workspaceDir),
    ]);
    await writeFile(join(config.paths.runtimeDir, "plugin-configuration.json"), JSON.stringify({
      version: 1, plugins: { "filesystem-ea": { settings: { enabled: false }, secrets: {} } },
    }), { mode: 0o600 });
    const modules = runtimePluginsToToolModules(loadConfiguredRuntimePlugins(config));
    expect(modules.map(({ definition }) => definition.name).sort())
      .toEqual(["create_text", "edit_text", "read_text"]);
    const registry = createConfiguredToolRegistry(config, modules);
    expect(registry.listNormalInvocations!()).toHaveLength(3);
    expect(await registry.discoverOperations!()).toEqual([]);
    const prepared = await registry.prepareRequest!({
      requestId: "disabled-plugin-request", rootContractId: "execution_agent",
      executionPolicy: "execution-agent-v1", runtimePathResolver: createRuntimeToolPathResolver(config.paths),
    });
    expect(prepared.listNormalInvocations!()).toEqual([]);
    expect(prepared.hasToolsAvailable()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
