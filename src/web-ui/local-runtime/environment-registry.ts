import { createRuntimeApplication } from "../../runtime/composition.js";
import { loadRuntimeConfig } from "../../runtime/config.js";
import { inspectRuntimeConfigFileWithMeta } from "../../runtime/config/loader.js";
import { loadRuntimeModelCatalog } from "../../runtime/model/model-catalog.js";
import type {
  LocalRuntimeBackendOptions,
  RuntimeEnvironment,
  RuntimeModelCatalogState,
  RuntimeSetupRequirement,
} from "./contracts.js";
import { inspectRuntimeSetupRequirement } from "./runtime-availability.js";

export class RuntimeEnvironmentRegistry {
  private readonly environments = new Map<string, RuntimeEnvironment>();

  constructor(private readonly options: LocalRuntimeBackendOptions) {}

  modelCatalog(environmentId: string): RuntimeModelCatalogState {
    const source = inspectRuntimeConfigFileWithMeta(
      this.options.rootDir ?? process.cwd(),
      this.options.configPath ?? process.env.LLM_RUNTIME_CONFIG_FILE,
    );
    const setupRequirement = inspectRuntimeSetupRequirement(source);
    if (setupRequirement) {
      return this.emptyModelCatalog(setupRequirement);
    }
    const catalog = loadRuntimeModelCatalog(this.loadConfig(environmentId));
    return {
      ...catalog,
      availability: { status: "ready" },
    };
  }

  setupRequirement(environmentId: string): RuntimeSetupRequirement | null {
    const availability = this.modelCatalog(environmentId).availability;
    return availability.status === "setup_required" ? availability : null;
  }

  get(environmentId: string): RuntimeEnvironment {
    const normalized = environmentId || this.options.defaultEnvironmentId;
    const existing = this.environments.get(normalized);
    if (existing) return existing;
    const config = this.loadConfig(normalized);
    const environment = createRuntimeApplication(config);
    this.environments.set(normalized, environment);
    return environment;
  }

  profileEnv(environmentId: string): Record<string, string | undefined> {
    return {
      ...process.env,
      LLM_RUNTIME_PROFILE: environmentId || this.options.defaultEnvironmentId,
    };
  }

  private loadConfig(environmentId: string) {
    return loadRuntimeConfig({
      rootDir: this.options.rootDir,
      configPath: this.options.configPath,
      profileId: environmentId || this.options.defaultEnvironmentId,
    });
  }

  private emptyModelCatalog(
    availability: RuntimeSetupRequirement,
  ): RuntimeModelCatalogState {
    return {
      defaultProfileId: "",
      profiles: [],
      availability,
    };
  }
}
