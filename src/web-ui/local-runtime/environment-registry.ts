import {
  createLocalRuntimeApplication,
  type LocalRuntimeApplicationOptions,
} from "../../runtime/local-application.js";
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
  private stopped = false;
  private stopping: Promise<void> | undefined;

  constructor(
    private readonly options: LocalRuntimeBackendOptions,
    private readonly schedulerBindings: {
      requestOptions?: LocalRuntimeApplicationOptions["scheduledRequestOptions"];
      publish?: (event: Record<string, unknown>) => void;
    } = {},
  ) {}

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
    this.requireEnvironmentIntakeOpen();
    const normalized = environmentId || this.options.defaultEnvironmentId;
    const existing = this.environments.get(normalized);
    if (existing) return existing;
    const config = this.loadConfig(normalized);
    const environment = createLocalRuntimeApplication(config, {
      scheduledRequestOptions: this.schedulerBindings.requestOptions,
    });
    if (this.schedulerBindings.publish) {
      environment.subscribeScheduledEvents(this.schedulerBindings.publish);
    }
    this.environments.set(normalized, environment);
    return environment;
  }

  async start(environmentIds: readonly string[]): Promise<void> {
    this.requireEnvironmentIntakeOpen();
    await Promise.all(environmentIds.map((id) => this.startEnvironment(id)));
  }

  private async startEnvironment(id: string): Promise<void> {
    try {
      if (this.setupRequirement(id)) return;
      await this.get(id).start();
    } catch (error) {
      console.error(`Scheduler unavailable for environment ${id}:`, error);
    }
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.stopping = Promise.all(
      [...this.environments.values()].map(async (environment) =>
        environment.stop(),
      ),
    ).then(() => undefined);
    return this.stopping;
  }

  private requireEnvironmentIntakeOpen(): void {
    if (this.stopped) throw new Error("web_runtime_stopped");
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
