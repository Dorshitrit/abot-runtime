import { cp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveRegisteredToolCapabilityCatalog } from "../adapters/registered-tool-worker-capabilities/catalog.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createDefaultSkillProvider,
  createDefaultToolRegistry,
} from "../default-adapters.js";
import type { AutomationService } from "../automations/service.js";
import type { SchedulerService } from "../scheduler/contracts.js";
import type { RuntimeConfig } from "../ports.js";
import {
  loadBundledRuntimePlugins,
  loadConfiguredRuntimePlugins,
} from "../plugins/loader.js";
import {
  createPluginSelectionFixture,
  removePluginSelectionFixtures,
} from "./plugin-selection-fixture.js";

const bundled = vi.hoisted(() => ({ root: "" }));
vi.mock("../plugins/bundled-root.js", () => ({
  resolveBundledRuntimeRoot: () => bundled.root,
}));

const coreNames = ["abot_skills", "schedules", "automations", "automation_builder"] as const;
const collisionId = "fixture-collision";
const operationCollisions = [
  ["list_skills", "abot_skills"],
  ["read_skill", "abot_skills"],
  ["read_skills", "abot_skills"],
  ["create_skill", "abot_skills"],
  ["update_skill", "abot_skills"],
  ["list", "schedules"],
  ["browse_catalog", "automations"],
  ["create_automation_draft", "automation_builder"],
] as const;

afterEach(async () => {
  vi.unstubAllGlobals();
  await removePluginSelectionFixtures();
});

async function fixture(
  capabilityName: string, throwingEntrypoint = true, pluginId = collisionId,
  operationId?: string,
) {
  const config = await createPluginSelectionFixture({ allow: ["*"] });
  bundled.root = config.paths.rootDir;
  const runtimeProcess = Object.create(process) as NodeJS.Process;
  Object.defineProperty(runtimeProcess, "cwd", { value: () => config.paths.rootDir });
  vi.stubGlobal("process", runtimeProcess);
  const pluginRoot = join(config.paths.rootDir, "plugins", pluginId);
  await cp(join(config.paths.rootDir, "plugins", "fixture-active"), pluginRoot, {
    recursive: true,
  });
  const manifestPath = join(pluginRoot, "plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.name = pluginId;
  const original = manifest.extensions["ai.abot.runtime"].capabilities.fixture_ping;
  const operation = original.operations.inspect_fixture;
  manifest.extensions["ai.abot.runtime"].capabilities = Object.fromEntries(
    [capabilityName, "collision_sibling"].map((name) => [name, {
      ...original,
      skills: ["collision-skill"],
      operations: { [name === capabilityName && operationId ? operationId : `inspect_${name}`]: operation },
    }]),
  );
  await writeFile(manifestPath, JSON.stringify(manifest));
  const entrypoint = join(pluginRoot, "src", "index.cjs");
  await writeFile(entrypoint, throwingEntrypoint
    ? 'throw new Error("colliding plugin entrypoint executed");'
    : `module.exports = { handlers: {
        ${JSON.stringify(capabilityName)}: async () => ({ ok: true, output: "plugin-owned", producedNewInformation: true }),
        collision_sibling: async () => ({ ok: true, output: "sibling", producedNewInformation: true })
      } };`);
  await rename(join(pluginRoot, "skills", "fixture-skill"), join(pluginRoot, "skills", "collision-skill"));
  const skillPath = join(pluginRoot, "skills", "collision-skill", "SKILL.md");
  await writeFile(skillPath, "Ignored plugin guidance must never reach native tools.");
  const snapshot = () => Promise.all(
    [manifestPath, entrypoint, skillPath].map((path) => readFile(path, "utf8")),
  );
  return { config, entrypoint, snapshot };
}

const loaders = [
  {
    name: "configured",
    load: loadConfiguredRuntimePlugins,
    registry: (config: RuntimeConfig) => createDefaultToolRegistry(config),
    skillConfig: (config: RuntimeConfig) => config,
  },
  {
    name: "bundled",
    load: (_config: RuntimeConfig) => loadBundledRuntimePlugins(),
    registry: (_config: RuntimeConfig) => createDefaultToolRegistry(),
    skillConfig: (_config: RuntimeConfig) => undefined,
  },
] as const;

describe.each(loaders)("$name core tool collision isolation", ({ name: loadingMode, load, registry, skillConfig }) => {
  test.each(coreNames)(
    "ignores the entire plugin declaring %s without executing or modifying it",
    async (name) => {
      const f = await fixture(name);
      const filesBefore = await f.snapshot();
      const selectionBefore = structuredClone(f.config.plugins);
      const catalog = load(f.config);
      expect(catalog.map(({ id }) => id)).toEqual(["fixture-active"]);
      expect(load(f.config)).toBe(catalog);
      const tools = registry(f.config);
      expect(tools.listDefinitions().map(({ name: toolName }) => toolName))
        .toEqual(["abot_skills", "fixture_ping"]);
      await expect(tools.execute({ tool: "fixture_ping", params: {} }))
        .resolves.toMatchObject({ ok: true, output: "fixture:1" });
      await expect(tools.execute({ tool: "abot_skills", params: { action: "list_skills" } }))
        .resolves.toMatchObject({ ok: true });
      const skills = createDefaultSkillProvider(skillConfig(f.config), { toolRegistry: tools });
      await expect(skills.getActionContext("fixture_ping"))
        .resolves.toContain("Fixture capability guidance.");
      await expect(skills.getActionContext(name)).resolves.toBe("");
      await expect(skills.getActionContext("collision_sibling")).resolves.toBe("");
      expect(await f.snapshot()).toEqual(filesBefore);
      expect(f.config.plugins).toEqual(selectionBefore);
    },
  );

  test.each(operationCollisions)(
    "ignores a custom capability colliding with %s from %s before loading its entrypoint",
    async (operationId) => {
      const f = await fixture("custom_skill_lookup", true, collisionId, operationId);
      const filesBefore = await f.snapshot();
      expect(load(f.config).map(({ id }) => id)).toEqual(["fixture-active"]);
      const tools = registry(f.config);
      expect(tools.getDefinition("custom_skill_lookup")).toBeUndefined();
      expect(tools.getDefinition("collision_sibling")).toBeUndefined();
      const available = resolveRegisteredToolCapabilityCatalog(tools, true);
      expect(available.operationIds).toEqual([
        "list_skills", "read_skill", "read_skills",
        ...(loadingMode === "configured" ? ["create_skill", "update_skill"] : []), "inspect_fixture",
      ]);
      expect(available.selected.filter(({ operation }) => operation.operationId === "list_skills")
        .map(({ registration }) => registration.toolName)).toEqual(["abot_skills"]);
      await expect(tools.execute({ tool: "fixture_ping", params: {} }))
        .resolves.toMatchObject({ ok: true, output: "fixture:1" });
      const skills = createDefaultSkillProvider(skillConfig(f.config), { toolRegistry: tools });
      await expect(skills.getActionContext("custom_skill_lookup")).resolves.toBe("");
      await expect(skills.getActionContext("collision_sibling")).resolves.toBe("");
      expect(await f.snapshot()).toEqual(filesBefore);
    },
  );

  test("retains a distinct operation with a native-operation prefix", async () => {
    const f = await fixture("custom_skill_lookup", false, collisionId, "list_skills_custom");
    const tools = registry(f.config);
    const available = resolveRegisteredToolCapabilityCatalog(tools, true);
    expect(available.selected.find(({ operation }) => operation.operationId === "list_skills_custom")
      ?.registration.toolName).toBe("custom_skill_lookup");
    await expect(tools.execute({ tool: "custom_skill_lookup", params: {} }))
      .resolves.toMatchObject({ ok: true, output: "plugin-owned" });
  });

  test("skips a colliding package before resolving a missing entrypoint", async () => {
    const f = await fixture("automations");
    await rm(f.entrypoint);
    expect(load(f.config).map(({ id }) => id)).toEqual(["fixture-active"]);
    expect(registry(f.config).getDefinition("abot_skills")).toBeDefined();
  });

  test("keeps a noncolliding name with a core-name prefix executable", async () => {
    const f = await fixture("abot_skills_extension", false);
    expect(load(f.config).map(({ id }) => id))
      .toEqual(["fixture-active", collisionId]);
    const tools = registry(f.config);
    await expect(tools.execute({ tool: "abot_skills_extension", params: {} }))
      .resolves.toMatchObject({ ok: true, output: "plugin-owned" });
    await expect(tools.execute({ tool: "collision_sibling", params: {} }))
      .resolves.toMatchObject({ ok: true, output: "sibling" });
  });

  test("allows a plugin package named like a native tool when its capabilities do not collide", async () => {
    const f = await fixture("safe_custom", false, "schedules");
    expect(load(f.config).map(({ id }) => id).sort())
      .toEqual(["fixture-active", "schedules"]);
    const tools = registry(f.config);
    expect(tools.getDefinition("safe_custom")?.pluginName).toBe("schedules");
    expect(tools.getDefinition("abot_skills")?.pluginName).toBeUndefined();
    await expect(tools.execute({ tool: "safe_custom", params: {} }))
      .resolves.toMatchObject({ ok: true, output: "plugin-owned" });
  });

  test("does not hide an unrelated plugin load error", async () => {
    const f = await fixture("ordinary_fixture");
    expect(() => load(f.config)).toThrow("colliding plugin entrypoint executed");
  });
});

test.each(coreNames)(
  "ignores the whole plugin when its %s collision is not selected",
  async (name) => {
    const f = await fixture(name, false);
    f.config.plugins = {
      allow: ["fixture-active", `${collisionId}.collision_sibling`],
      deny: [`${collisionId}.${name}`],
    };
    expect(loadConfiguredRuntimePlugins(f.config).map(({ id }) => id))
      .toEqual(["fixture-active"]);
    const tools = createDefaultToolRegistry(f.config);
    expect(tools.getDefinition("collision_sibling")).toBeUndefined();
    const skills = createDefaultSkillProvider(f.config, { toolRegistry: tools });
    await expect(skills.getActionContext("collision_sibling")).resolves.toBe("");
  },
);

test.each(["schedules", "automations", "automation_builder"])(
  "retains native scheduling and Studio tools beside an ignored %s plugin",
  async (name) => {
    const f = await fixture(name);
    const ready = vi.fn(async () => undefined);
    const getService = vi.fn(() => ({} as AutomationService));
    const tools = createDefaultToolRegistry(f.config, {
      service: {} as SchedulerService,
      ready,
    }, { getService, ready });
    expect(tools.listDefinitions().map(({ name: toolName }) => toolName))
      .toEqual(["abot_skills", "fixture_ping", "schedules", "automations", "automation_builder"]);
    for (const coreName of coreNames) {
      expect(tools.getDefinition(coreName)?.pluginName).toBeUndefined();
      expect(tools.listNormalInvocations!().find(({ toolName }) => toolName === coreName))
        .toBeDefined();
    }
    expect(tools.getDefinition("collision_sibling")).toBeUndefined();
    const skills = createDefaultSkillProvider(f.config, { toolRegistry: tools });
    await expect(skills.getActionContext(name)).resolves.toBe("");
    expect(ready).not.toHaveBeenCalled();
    expect(getService).not.toHaveBeenCalled();
  },
);

test("ignores an operation collision even when only a different capability is selected", async () => {
  const f = await fixture("custom_skill_lookup", false, collisionId, "list_skills");
  f.config.plugins = {
    allow: ["fixture-active", `${collisionId}.collision_sibling`],
    deny: [`${collisionId}.custom_skill_lookup`],
  };
  expect(loadConfiguredRuntimePlugins(f.config).map(({ id }) => id))
    .toEqual(["fixture-active"]);
  expect(createDefaultToolRegistry(f.config).getDefinition("collision_sibling")).toBeUndefined();
});

test.each(operationCollisions.slice(2))(
  "preserves the active native owner of %s in %s without an ambiguous catalog",
  async (operationId, toolName) => {
    const f = await fixture("custom_skill_lookup", true, collisionId, operationId);
    const ready = vi.fn(async () => undefined);
    const getService = vi.fn(() => ({} as AutomationService));
    const tools = createDefaultToolRegistry(f.config, {
      service: {} as SchedulerService, ready,
    }, { getService, ready });
    const available = resolveRegisteredToolCapabilityCatalog(tools, true);
    expect(available.selected.filter(({ operation }) => operation.operationId === operationId)
      .map(({ registration }) => registration.toolName)).toEqual([toolName]);
    expect(tools.getDefinition("custom_skill_lookup")).toBeUndefined();
    expect(tools.getDefinition("collision_sibling")).toBeUndefined();
    const skills = createDefaultSkillProvider(f.config, { toolRegistry: tools });
    await expect(skills.getActionContext(toolName)).resolves.toBe("");
    expect(ready).not.toHaveBeenCalled();
    expect(getService).not.toHaveBeenCalled();
  },
);
