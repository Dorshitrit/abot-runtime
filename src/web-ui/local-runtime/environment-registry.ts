import type { RuntimeConfig } from "../../runtime/ports.js";
import type { WebUiEnvironmentConfig } from "../environment-config.js";
import type { RuntimeSetupActivation } from "./runtime-setup-input.js";
import { requiresConfiguredCredential } from "./runtime-setup-provider.js";
import { applyRuntimeConfiguration } from "./configuration-activation.js";
import {
  withConfigurationActivationSource,
  type ConfigurationActivationPreparation,
} from "./configuration-activation-source.js";
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
import { readSavedModelCatalog } from "./saved-model-catalog.js";

export class RuntimeEnvironmentRegistry {
  private readonly environments = new Map<string, RuntimeEnvironment>();
  private stopped = false;
  private readonly desiredEnvironmentIds = new Set<string>();
  private applying: Promise<RuntimeSetupActivation> | undefined;
  private setupActivationPending = false;
  private stopping: Promise<void> | undefined;
  private configuredEnvironments: WebUiEnvironmentConfig | undefined;

  constructor(
    private readonly options: LocalRuntimeBackendOptions,
    private readonly schedulerBindings: {
      requestOptions?: LocalRuntimeApplicationOptions["scheduledRequestOptions"];
      publish?: (event: Record<string, unknown>) => void;
    } = {},
  ) {
    this.configuredEnvironments = options.resolveEnvironmentConfig?.(
      options.configPath,
    );
  }

  environmentConfig(): WebUiEnvironmentConfig | undefined {
    return this.configuredEnvironments;
  }

  applyConfiguration(): Promise<RuntimeSetupActivation> {
    if (this.stopped) return Promise.reject(new Error("web_runtime_stopped"));
    if (this.applying) return this.applying;
    const configPath = inspectRuntimeConfigFileWithMeta(
      this.options.rootDir ?? process.cwd(),
      this.options.configPath ?? process.env.LLM_RUNTIME_CONFIG_FILE,
    ).path;
    const apply = withConfigurationActivationSource(configPath, (prepare) =>
      this.applySavedConfiguration(configPath, prepare),
    );
    this.applying = apply.finally(() => {
      this.applying = undefined;
    });
    return this.applying;
  }

  private applySavedConfiguration(
    configPath: string,
    preparation: ConfigurationActivationPreparation,
  ): Promise<RuntimeSetupActivation> {
    const nextEnvironments =
      this.options.resolveEnvironmentConfig?.(configPath);
    return applyRuntimeConfiguration({
      environments: this.environments,
      defaultEnvironmentId:
        nextEnvironments?.defaultEnvironmentId ??
        this.options.defaultEnvironmentId,
      environmentIds: nextEnvironments?.environments.map(({ id }) => id) ?? [
        ...this.desiredEnvironmentIds,
      ],
      createEnvironment: (id) =>
        this.createEnvironment(id, this.loadConfig(id, configPath)),
      recreateEnvironment: (id, previous) =>
        this.createEnvironment(id, previous.services.config),
      createGatewayRestorePoint: this.options.createRuntimeSetupRestorePoint,
      onRestorationFailure: () => {
        this.setupActivationPending = true;
      },
      ...preparation,
      checkGateway: () => this.checkGatewayActivation(configPath),
      activateGateway: () =>
        this.options.onRuntimeSetup?.(configPath) ??
        Promise.resolve({ status: "ready" }),
      canContinue: () => !this.stopped,
    }).then((result) => {
      if (result.status !== "ready") return result;
      this.setupActivationPending = false;
      if (nextEnvironments) {
        this.configuredEnvironments = nextEnvironments;
        this.options.defaultEnvironmentId =
          nextEnvironments.defaultEnvironmentId;
        this.desiredEnvironmentIds.clear();
        for (const { id } of nextEnvironments.environments)
          this.desiredEnvironmentIds.add(id);
      }
      return result;
    });
  }

  private checkGatewayActivation(
    configPath: string,
  ): Promise<RuntimeSetupActivation> {
    if (this.options.checkRuntimeSetupActivation)
      return this.options.checkRuntimeSetupActivation(configPath);
    if (this.options.onRuntimeSetup)
      return Promise.resolve({ status: "ready" });
    return Promise.resolve({
      status: "restart_required",
      message:
        "Connection saved. Restart the owning model gateway and Runtime to apply this configuration.",
    });
  }

  configure(configPath: string): void {
    this.requireEnvironmentIntakeOpen();
    this.options.configPath = configPath;
    if (!this.hasStartedEnvironment()) this.setupActivationPending = true;
  }

  modelCatalog(environmentId: string): RuntimeModelCatalogState {
    if (this.setupActivationPending) {
      return this.emptyModelCatalog({
        status: "setup_required",
        code: "runtime_configuration_required",
        message:
          "Your connection is saved. Apply the setup or restart its owning services before starting a conversation.",
      });
    }
    const active = this.environments.get(
      environmentId || this.options.defaultEnvironmentId,
    );
    if (active?.getOwnership() !== undefined) {
      return {
        ...loadRuntimeModelCatalog(active.services.config),
        availability: { status: "ready" },
      };
    }
    const source = inspectRuntimeConfigFileWithMeta(
      this.options.rootDir ?? process.cwd(),
      this.options.configPath ?? process.env.LLM_RUNTIME_CONFIG_FILE,
    );
    const setupRequirement = inspectRuntimeSetupRequirement(source);
    if (setupRequirement) {
      return this.emptyModelCatalog(setupRequirement);
    }
    if (
      requiresConfiguredCredential(
        source,
        this.options.rootDir ?? process.cwd(),
      )
    ) {
      return this.emptyModelCatalog({
        status: "setup_required",
        code: "runtime_configuration_required",
        message:
          "The configured OpenAI model needs an API key. Complete the connection in this Web UI.",
      });
    }
    const catalog = readSavedModelCatalog(
      source,
      environmentId || this.options.defaultEnvironmentId,
    );
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
    this.desiredEnvironmentIds.add(normalized);
    const existing = this.environments.get(normalized);
    if (existing) return existing;
    const environment = this.createEnvironment(normalized);
    this.environments.set(normalized, environment);
    return environment;
  }

  private createEnvironment(
    environmentId: string,
    config: RuntimeConfig = this.loadConfig(environmentId),
  ): RuntimeEnvironment {
    const environment = createLocalRuntimeApplication(config, {
      scheduledRequestOptions: this.schedulerBindings.requestOptions,
    });
    if (this.schedulerBindings.publish) {
      environment.subscribeScheduledEvents(this.schedulerBindings.publish);
    }
    return environment;
  }

  async start(environmentIds: readonly string[]): Promise<void> {
    this.requireEnvironmentIntakeOpen();
    for (const id of environmentIds) this.desiredEnvironmentIds.add(id);
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
    this.stopping = this.stopAfterConfigurationApplication();
    return this.stopping;
  }

  private async stopAfterConfigurationApplication(): Promise<void> {
    // Apply checks the stopped fence after every async handoff; teardown owns final closure.
    await this.applying?.catch(() => undefined);
    const stops = await Promise.allSettled(
      [...this.environments.values()].map((environment) => environment.stop()),
    );
    const failed = stops.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  private hasStartedEnvironment(): boolean {
    return [...this.environments.values()].some(
      (environment) => environment.getOwnership() !== undefined,
    );
  }

  private requireEnvironmentIntakeOpen(): void {
    if (this.stopped) throw new Error("web_runtime_stopped");
    if (this.applying)
      throw new Error("Configuration is being applied. Try again shortly.");
  }

  profileEnv(environmentId: string): Record<string, string | undefined> {
    return {
      ...process.env,
      LLM_RUNTIME_PROFILE: environmentId || this.options.defaultEnvironmentId,
    };
  }

  private loadConfig(
    environmentId: string,
    configPath = this.options.configPath,
  ) {
    return loadRuntimeConfig({
      rootDir: this.options.rootDir,
      configPath,
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
