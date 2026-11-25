import type { AppliedGatewayConfigurations } from "../runtime-setup-gateway.js";
import { requirePluginOwnersIdle } from "./plugin-mutation-admission.js";
import { ConfigFileConflictError } from "../../runtime/adapters/config-file-transaction.js";
import { PluginManagementError } from "../plugin-management-service.js";
import {
  isPluginToolSelected,
  normalizePluginSelection,
} from "../../runtime/plugins/selection.js";
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
import { inspectRuntimeSetupRequirement, inspectSetupSource } from "./runtime-availability.js";
import { readSavedModelCatalog } from "./saved-model-catalog.js";
import type { LearningChangedEvent } from "../../runtime/passive-learning/contracts.js";
import type { SparkHomeChanged } from "../../runtime/local-host/client-spark-home-events.js";

export class RuntimeEnvironmentRegistry {
  private readonly environments = new Map<string, RuntimeEnvironment>();
  private readonly gatewayConfigurations = new WeakMap<
    RuntimeEnvironment,
    string | null
  >();
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
      homeAppearance?: LocalRuntimeApplicationOptions["sparkHomeAppearance"];
      publish?: (event: Record<string, unknown>, environmentId: string) => void;
      publishInformationBasket?: (environmentId: string) => void;
      publishSparkHome?: (environmentId: string, change: SparkHomeChanged) => void;
      publishLearning?: (
        environmentId: string,
        event?: LearningChangedEvent,
      ) => void;
    } = {},
  ) {
    this.configuredEnvironments = options.resolveEnvironmentConfig?.(
      options.configPath,
    );
  }

  environmentConfig(): WebUiEnvironmentConfig | undefined {
    return this.configuredEnvironments;
  }

  existingNativePermissions(environmentId: string) {
    if (this.stopped || this.applying) return undefined;
    return this.environments.get(environmentId)?.nativePermissions;
  }

  requirePluginInactive(
    pluginId: string,
    capabilityIds: readonly string[],
  ): void {
    this.requireEnvironmentIntakeOpen();
    if (this.setupActivationPending || this.environments.size === 0)
      throw new PluginManagementError(
        "plugin_runtime_unavailable",
        "Apply Runtime configuration before removing plugins.",
        409,
      );
    for (const environment of this.environments.values()) {
      const selection = normalizePluginSelection(
        environment.services.config.plugins,
      );
      if (
        environment.getOwnership() !== "owner" ||
        capabilityIds.some((toolName) =>
          isPluginToolSelected({ pluginId, toolName, selection }),
        )
      )
        throw new PluginManagementError(
          "plugin_still_active",
          "The plugin is still available in a Runtime environment. Apply its disable before removing it.",
          409,
        );
    }
  }

  requirePluginMutationIdle(hasAcknowledgedRequests = false): void {
    requirePluginOwnersIdle({
      environments: this.environments.values(),
      unavailable: this.stopped || this.setupActivationPending,
      busy: hasAcknowledgedRequests || !!this.applying,
    });
  }

  applyConfiguration(
    expectedRevision?: string,
  ): Promise<RuntimeSetupActivation> {
    if (this.stopped) return Promise.reject(new Error("web_runtime_stopped"));
    if (this.applying) {
      // A coalesced Apply may have loaded a different revision from this removal.
      if (expectedRevision !== undefined)
        return Promise.reject(new ConfigFileConflictError());
      return this.applying;
    }
    const configPath = inspectRuntimeConfigFileWithMeta(
      this.options.rootDir ?? process.cwd(),
      this.options.configPath ?? process.env.LLM_RUNTIME_CONFIG_FILE,
    ).path;
    const apply = withConfigurationActivationSource(
      configPath,
      (prepare) => this.applySavedConfiguration(configPath, prepare),
      expectedRevision,
      this.options.rootDir ?? process.cwd(),
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
    const nextDefault = nextEnvironments?.defaultEnvironmentId ?? this.options.defaultEnvironmentId;
    let appliedGatewayConfigurations: AppliedGatewayConfigurations | undefined;
    return applyRuntimeConfiguration({
      environments: this.environments,
      defaultEnvironmentId: nextDefault,
      environmentIds: nextEnvironments?.environments.map(({ id }) => id) ?? [
        ...this.desiredEnvironmentIds,
      ],
      createEnvironment: (id) =>
        this.createEnvironment(
          id,
          this.loadConfig(id, configPath),
          this.captureGatewayConfiguration(configPath),
          nextDefault,
        ),
      recreateEnvironment: (id, previous) =>
        this.createEnvironment(
          id,
          previous.services.config,
          this.gatewayConfigurations.get(previous) ?? null,
        ),
      createGatewayRestorePoint: this.options.createRuntimeSetupRestorePoint,
      onRestorationFailure: () => {
        this.setupActivationPending = true;
      },
      ...preparation,
      checkGateway: () => {
        appliedGatewayConfigurations = [...this.environments.values()].map(
          (environment) => this.gatewayConfigurations.get(environment) ?? null,
        );
        return this.checkGatewayActivation(
          configPath,
          appliedGatewayConfigurations,
        );
      },
      activateGateway: () =>
        this.options.onRuntimeSetup?.(
          configPath,
          appliedGatewayConfigurations,
        ) ?? Promise.resolve({ status: "ready" }),
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
    applied: AppliedGatewayConfigurations,
  ): Promise<RuntimeSetupActivation> {
    if (this.options.checkRuntimeSetupActivation)
      return this.options.checkRuntimeSetupActivation(configPath, applied);
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
    const { source, requirement } = inspectSetupSource(() => inspectRuntimeConfigFileWithMeta(
      this.options.rootDir ?? process.cwd(),
      this.options.configPath ?? process.env.LLM_RUNTIME_CONFIG_FILE,
    ));
    if (requirement) return this.emptyModelCatalog(requirement);
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

  private captureGatewayConfiguration(configPath?: string): string | null {
    try {
      return (
        this.options.captureRuntimeSetupConfiguration?.(configPath) ?? null
      );
    } catch {
      // An unavailable gateway snapshot cannot block an otherwise valid Runtime.
      // Apply still refuses external reuse when any owner's snapshot is unknown.
      return null;
    }
  }

  private createEnvironment(
    environmentId: string,
    config: RuntimeConfig = this.loadConfig(environmentId),
    gatewayConfiguration = this.captureGatewayConfiguration(
      this.options.configPath,
    ),
    targetRuntimeId = this.options.defaultEnvironmentId,
  ): RuntimeEnvironment {
    let bridge: LocalRuntimeApplicationOptions["bridge"];
    try {
      bridge = this.options.runtimeBridge?.(config, targetRuntimeId);
    } catch {
      console.warn("Socket connection configuration needs attention.");
    }
    const environment = createLocalRuntimeApplication(config, {
      ...(bridge && { bridge }),
      scheduledRequestOptions: this.schedulerBindings.requestOptions,
      sparkHomeAppearance: this.schedulerBindings.homeAppearance,
    });
    // Capture before startup; restored owners keep their prior immutable snapshot.
    this.gatewayConfigurations.set(environment, gatewayConfiguration);
    if (this.schedulerBindings.publish) {
      environment.subscribeScheduledEvents((event) => this.schedulerBindings.publish?.(event, environmentId));
    }
    environment.subscribeInformationBasketEvents?.(() =>
      this.schedulerBindings.publishInformationBasket?.(environmentId),
    );
    environment.subscribeSparkHomeEvents?.(change =>
      this.schedulerBindings.publishSparkHome?.(environmentId, change),
    );
    environment.subscribeLearningEvents?.((event) =>
      this.schedulerBindings.publishLearning?.(environmentId, event),
    );
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
