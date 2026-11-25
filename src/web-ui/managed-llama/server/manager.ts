import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { ManagedLlamaService } from "../service.js";
import { LlamaInstaller } from "../install.js";
import { ManagedLlamaLifecycle, type LifecycleDependencies, type ReadyLlamaConnection } from "../lifecycle.js";
import { ManagedLlamaError } from "../contracts.js";
import { ServerStateStore, type SavedServerState } from "./state-store.js";
import { parseServerSettings, serverFailure, type ServerSettings, type ServerModel } from "./settings.js";
import { validateServerModels } from "./model-validation.js";
import { createServerPresets, routerArguments, embeddingArguments } from "./presets.js";
import { observeRouter, routerReady, type ModelObservation } from "./observation.js";
import { spawnServerTree, signalServerTree, serverProcessEnvironment } from "./process-tree.js";

type Engine = Pick<ManagedLlamaService, "status" | "capabilities" | "install" | "refreshStatus" | "cancel">;
type ProcessOwner = Pick<ManagedLlamaLifecycle, "start" | "stop" | "close" | "status" | "readyConnection">;
type Store = Pick<ServerStateStore, "read" | "save">;
type Presets = Awaited<ReturnType<typeof createServerPresets>>;
export interface ServerManagerDependencies {
  createStore?: (directory: string) => Store;
  createLifecycle?: (dependencies: LifecycleDependencies) => ProcessOwner;
  validateModels?: typeof validateServerModels;
  createPresets?: typeof createServerPresets;
  observe?: typeof observeRouter;
  routerHealth?: typeof routerReady;
}
const safeErrors = new Set(["closed", "busy", "cancelled", "not_installed", "unsupported_platform", "port_unavailable",
  "readiness_timeout", "child_exited", "termination_unconfirmed", "server_settings_changed", "server_state_busy",
  "invalid_server_settings", "unsupported_server_model", "invalid_gguf_metadata", "cpu_only_server",
  "server_state_unavailable", "server_status_unavailable", "server_catalog_mismatch", "server_not_configured"]);
function safeError(error: unknown): string {
  if (error instanceof ManagedLlamaError && safeErrors.has(error.code)) return error.code;
  return "managed_server_failed";
}
function hasLegacyOperation(engine: Engine): boolean {
  const state = engine.status();
  return state.ownsProcess || ["starting", "stopping", "inspecting", "installing"].includes(state.phase);
}

/** One host owner. Settings are local, while provider bindings remain normal
 * llama.cpp connections. Autostart is consumed only at application startup;
 * status reads and wizard reopening cannot start processes or download models.
 */
export class ManagedLlamaServerManager {
  private saved: SavedServerState | null = null;
  private store?: Store;
  private directory?: string;
  private router?: ProcessOwner;
  private embedding?: ProcessOwner;
  private presets?: Presets;
  private closed = false;
  private initialized = false;
  private operation?: { kind: string; control: AbortController; work: Promise<void> };
  private stopping?: Promise<void>;
  private errorCode?: string;
  private observations: ModelObservation[] = [];
  private observationRevision = 0;
  private observing?: Promise<void>;
  private cleaning?: Promise<void>;

  constructor(private readonly root: string, private readonly engine: Engine, private readonly dependencies: ServerManagerDependencies = {}) {}
  isBusy(): boolean { return Boolean(this.operation || this.stopping || this.ownsProcesses()); }
  private ownsProcesses(): boolean { return Boolean(this.router?.status().ownsProcess || this.embedding?.status().ownsProcess); }
  private ready(): boolean {
    if (this.closed || this.operation || this.stopping || !this.router?.readyConnection()) return false;
    return !this.saved?.settings.embedding || Boolean(this.embedding?.readyConnection());
  }
  status() {
    const router = this.router?.status(), embedding = this.embedding?.status();
    const processError = router?.errorCode ?? embedding?.errorCode;
    const phase = this.stopping ? "stopping" : this.operation?.kind ??
      (this.errorCode || processError ? "error" : this.ready() ? "ready" : "stopped");
    return { phase, busy: Boolean(this.operation || this.stopping), closed: this.closed,
      supported: this.engine.capabilities().supported, cpuOnly: this.engine.capabilities().cpuOnly,
      release: this.engine.capabilities().release,
      installation: this.engine.status().installation, configured: Boolean(this.saved),
      settings: this.saved ? structuredClone(this.saved.settings) : null, revision: this.saved?.revision ?? null,
      ownsProcess: this.ownsProcesses(), legacyOwnsProcess: this.engine.status().ownsProcess,
      models: this.observations.map(value => ({ ...value })),
      errorCode: this.errorCode ?? (processError ? safeError(new ManagedLlamaError(processError, "")) : undefined) };
  }
  /** Called once by application startup, never by GET status. */
  initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    this.initialized = true;
    return this.run("restoring", async signal => {
      await this.restore(signal);
      if (this.saved?.settings.startup === "with-abot") await this.startSaved(signal);
    }).catch(() => { /* The card exposes the bounded error; ABot stays available. */ });
  }
  install(): Promise<void> {
    return this.run("installing", async signal => { await this.engine.install(); signal.throwIfAborted(); await this.restore(signal); });
  }
  inspect(): Promise<void> { return this.run("restoring", signal => this.restore(signal)); }
  configure(input: unknown, revision: string | null): Promise<void> {
    const settings = parseServerSettings(input);
    return this.run("saving", async signal => {
      await this.restore(signal);
      if (!this.store) throw serverFailure("not_installed");
      const validated = await (this.dependencies.validateModels ?? validateServerModels)(settings);
      signal.throwIfAborted();
      this.saved = await this.store.save(validated, revision);
    });
  }
  start(): Promise<void> {
    return this.run("starting", async signal => { await this.restore(signal); await this.startSaved(signal); });
  }
  private run(kind: string, action: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.closed) return Promise.reject(serverFailure("closed"));
    if (this.isBusy() || hasLegacyOperation(this.engine)) return Promise.reject(serverFailure("busy"));
    const control = new AbortController();
    this.errorCode = undefined;
    const work = Promise.resolve().then(() => action(control.signal)).catch(error => {
      this.errorCode = control.signal.aborted ? "cancelled" : safeError(error);
      throw serverFailure(this.errorCode);
    }).finally(() => { if (this.operation?.control === control) this.operation = undefined; });
    this.operation = { kind, control, work };
    void work.catch(() => {});
    return work;
  }
  private async restore(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await this.engine.refreshStatus();
    signal.throwIfAborted();
    if (this.engine.status().installation !== "installed") { this.saved = null; return; }
    this.directory = join(await realpath(this.root), ".abot-managed-llama");
    this.store ??= this.dependencies.createStore?.(this.directory) ?? new ServerStateStore(this.directory);
    const state = await this.store.read();
    signal.throwIfAborted();
    this.saved = state;
  }
  private async startSaved(signal: AbortSignal): Promise<void> {
    if (!this.saved || !this.directory) throw serverFailure("server_not_configured");
    const settings = await (this.dependencies.validateModels ?? validateServerModels)(this.saved.settings);
    signal.throwIfAborted();
    const release = this.engine.capabilities().release;
    if (!release) throw serverFailure("unsupported_platform");
    const installer = new LlamaInstaller(this.directory, release);
    this.presets = await (this.dependencies.createPresets ?? createServerPresets)(this.directory, settings);
    const key = this.saved.apiKey;
    const factory = this.dependencies.createLifecycle ?? (deps => new ManagedLlamaLifecycle(deps));
    const common: LifecycleDependencies = { installer, spawn: spawnServerTree, signalOwnedProcess: signalServerTree,
      resolveCredential: async () => key,
      launchEnvironment: token => serverProcessEnvironment(token, this.presets!.cache) };
    const representative = settings.models[0]!;
    try {
      signal.throwIfAborted();
      this.router = factory({ ...common, validateLaunch: async () => ({ ...representative, port: settings.port, gpuLayers: 0 }),
        launchArguments: () => routerArguments(settings, this.presets!.path),
        health: (port, token, _alias, healthSignal) => (this.dependencies.routerHealth ?? routerReady)(port, token, settings, healthSignal) });
      await this.router.start({});
      signal.throwIfAborted();
      if (settings.embedding) {
        const model = settings.embedding;
        this.embedding = factory({ ...common, validateLaunch: async () => ({ ...model, gpuLayers: 0 }),
          launchArguments: () => embeddingArguments(model, settings.sleepIdleSeconds) });
        await this.embedding.start({});
      }
      signal.throwIfAborted();
      this.observations = settings.models.map(model => ({ alias: model.alias, state: "unloaded" }));
    } catch (error) {
      await this.stopOwned();
      throw error;
    }
  }
  /** Read-only upstream /models does not wake sleeping models or reset idle time. */
  async observe(): Promise<void> {
    if (!this.ready() || !this.saved) return;
    if (this.observing) return this.observing;
    const state = this.saved, revision = this.observationRevision;
    const work = (this.dependencies.observe ?? observeRouter)(state.settings.port, state.apiKey, state.settings, AbortSignal.timeout(2500))
      .then(models => { if (revision === this.observationRevision && this.ready()) this.observations = models; })
      .catch(() => { if (revision === this.observationRevision) this.observations = state.settings.models.map(model => ({ alias: model.alias, state: "unknown" })); })
      .finally(() => { if (this.observing === work) this.observing = undefined; });
    this.observing = work;
    return work;
  }
  connection(alias?: string): (ReadyLlamaConnection & { revision: string }) | null {
    if (!this.ready() || !this.saved || !alias) return null;
    const model = this.saved.settings.models.find(model => model.alias === alias);
    if (!model) return null;
    return { baseUrl: "http://127.0.0.1:" + this.saved.settings.port, model: model.alias,
      contextWindowTokens: model.contextTokens, apiKey: this.saved.apiKey, revision: this.saved.revision };
  }
  embeddingConnection(): (ReadyLlamaConnection & { revision: string }) | null {
    if (!this.ready() || !this.saved?.settings.embedding) return null;
    const model = this.saved.settings.embedding;
    return { baseUrl: "http://127.0.0.1:" + model.port, model: model.alias,
      contextWindowTokens: model.contextTokens, apiKey: this.saved.apiKey, revision: this.saved.revision };
  }
  private stopOwned(): Promise<void> {
    if (this.cleaning) return this.cleaning;
    const work = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([this.router?.close(), this.embedding?.close()]);
      if (this.ownsProcesses() || results.some(value => value.status === "rejected")) throw serverFailure("termination_unconfirmed");
      this.router = undefined;
      this.embedding = undefined;
      this.observations = [];
      await this.presets?.remove();
      this.presets = undefined;
    }).finally(() => { if (this.cleaning === work) this.cleaning = undefined; });
    this.cleaning = work;
    return work;
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.observationRevision++;
    const operation = this.operation;
    operation?.control.abort(serverFailure("cancelled"));
    const work = Promise.resolve().then(async () => {
      // Fence in-flight launches before waiting for their operations to settle.
      await Promise.allSettled([this.router?.close(), this.embedding?.close(), operation ? this.engine.cancel() : undefined]);
      await operation?.work.catch(() => {});
      await this.stopOwned();
      this.errorCode = undefined;
    }).catch(error => { this.errorCode = safeError(error); throw serverFailure(this.errorCode); })
      .finally(() => { if (this.stopping === work) this.stopping = undefined; });
    this.stopping = work;
    return work;
  }
  close(): Promise<void> { this.closed = true; return this.stop(); }
}
