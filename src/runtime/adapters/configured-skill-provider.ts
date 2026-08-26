import {
  createSkillsContextProvider,
  type RuntimeSkillCatalog,
} from "../context/skills-context.js";
import {
  loadBundledRuntimePlugins,
  loadConfiguredRuntimePlugins,
} from "../plugins/loader.js";
import type { CompiledRuntimePlugin } from "../plugins/compiled-catalog.js";
import type { RuntimeConfig, SkillProvider, ToolRegistry } from "../ports.js";

export type ConfiguredSkillProviderOptions = {
  config: RuntimeConfig;
  listToolDefinitions?: Pick<
    ToolRegistry,
    "listDefinitions"
  >["listDefinitions"];
};

export type RuntimePluginSkillProviderOptions = {
  plugins: readonly CompiledRuntimePlugin[];
  listToolDefinitions?: Pick<
    ToolRegistry,
    "listDefinitions"
  >["listDefinitions"];
};

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function buildPluginSkillCatalog(
  plugins: readonly CompiledRuntimePlugin[],
  activeToolNames?: ReadonlySet<string>,
): RuntimeSkillCatalog {
  const skills: Record<string, string> = {};
  const actionSkills: Record<string, readonly string[]> = {};

  for (const plugin of plugins) {
    for (const [action, skillNames] of Object.entries(
      plugin.capabilitySkills,
    )) {
      if (activeToolNames && !activeToolNames.has(action)) {
        continue;
      }
      for (const skillName of skillNames) {
        const content = plugin.skills[skillName];
        if (content === undefined) {
          throw new Error(
            `Runtime plugin ${plugin.id} references unknown skill ${skillName}`,
          );
        }
        const existing = skills[skillName];
        if (existing !== undefined && existing !== content) {
          throw new Error(`Duplicate runtime plugin skill: ${skillName}`);
        }
        skills[skillName] = content;
      }
      actionSkills[action] = unique([
        ...(actionSkills[action] ?? []),
        ...skillNames,
      ]);
    }
  }

  return Object.freeze({
    skills: Object.freeze(skills),
    actionSkills: Object.freeze(actionSkills),
  });
}

function createProviderFromPlugins(
  options: RuntimePluginSkillProviderOptions,
): SkillProvider {
  const activeToolNames = options.listToolDefinitions
    ? new Set(
        options.listToolDefinitions().map((definition) => definition.name),
      )
    : undefined;
  return createSkillsContextProvider(
    buildPluginSkillCatalog(options.plugins, activeToolNames),
  );
}

/** Creates the skill projection from one already-compiled plugin catalog. */
export function createRuntimePluginSkillProvider(
  options: RuntimePluginSkillProviderOptions,
): SkillProvider {
  return createProviderFromPlugins(options);
}

/** Loads the config-selected plugin catalog and projects only its skills. */
export function createConfiguredSkillProvider(
  options: ConfiguredSkillProviderOptions,
): SkillProvider {
  return createProviderFromPlugins({
    plugins: loadConfiguredRuntimePlugins(options.config),
    listToolDefinitions: options.listToolDefinitions,
  });
}

/** Uses the same bundled plugin manifests as the unconfigured tool registry. */
export function createBundledPluginSkillProvider(
  options: Pick<RuntimePluginSkillProviderOptions, "listToolDefinitions"> = {},
): SkillProvider {
  return createProviderFromPlugins({
    plugins: loadBundledRuntimePlugins(),
    listToolDefinitions: options.listToolDefinitions,
  });
}
