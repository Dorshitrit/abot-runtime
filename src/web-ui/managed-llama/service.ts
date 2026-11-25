import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ManagedLlamaError, type Dependencies, type Release, type LaunchSettings } from "./contracts.js";
import { LlamaInstaller } from "./install.js";
import { ManagedLlamaLifecycle, type LifecycleDependencies, type LifecyclePhase, type ReadyLlamaConnection } from "./lifecycle.js";
import { selectRelease, SUPPORTED_PLATFORMS } from "./release.js";
import { ManagedLlamaPersistence } from "./persistence.js";

type Persistence = Pick<ManagedLlamaPersistence, "readPreferences" | "prepareStart">;
function copyPreferences(value: LaunchSettings): LaunchSettings {
  return { modelPath: value.modelPath, alias: value.alias, port: value.port,
    contextTokens: value.contextTokens, gpuLayers: value.gpuLayers };
}

type Installer = Pick<LlamaInstaller, "inspect" | "install">;
type Lifecycle = Pick<ManagedLlamaLifecycle, "status" | "start" | "stop" | "close" | "readyConnection">;
type Operation = "install" | "start" | "inspect";
export interface ManagedLlamaServiceDependencies extends Dependencies {
  /** Trusted test seams; factories must do no IO and return one owned instance. */
  createInstaller?: (directory: string, release: Release) => Installer;
  createLifecycle?: (dependencies: LifecycleDependencies) => Lifecycle;
  createPersistence?: (directory: string) => Persistence;
  validateLaunch?: LifecycleDependencies["validateLaunch"];
  checkPort?: LifecycleDependencies["checkPort"];
}
export interface ManagedLlamaStatus {
  supported: boolean;
  closed: boolean;
  phase: LifecyclePhase | "installing" | "inspecting" | "unsupported";
  installation: "unknown" | "missing" | "installed";
  ownsProcess: boolean;
  preferences: LaunchSettings | null;
  errorCode?: string;
}
function failure(code: string): ManagedLlamaError {
  return new ManagedLlamaError(code, "Managed llama.cpp: " + code + ".");
}
const publicCodes = new Set([
  "closed", "busy", "unsupported_platform", "cancelled", "storage_unavailable",
  "persistence_unavailable", "storage_conflict", "install_failed", "inspection_failed", "start_failed",
  "invalid_launch", "not_installed", "installation_unavailable", "port_unavailable",
  "spawn_failed", "readiness_failed", "readiness_timeout", "child_exited",
  "child_error", "start_cancelled", "termination_unconfirmed", "stop_failed",
]);
function safeCode(error: unknown, fallback: string): string {
  return error instanceof ManagedLlamaError && publicCodes.has(error.code) ? error.code : fallback;
}

/** One application-owned service per root. Call and await close on shutdown.
 * The caller reserves .abot-managed-llama exclusively for this module and must
 * control its ancestors for the service lifetime (same-user races are not solved).
 * Existing storage is accepted only through a valid installer receipt; unrelated
 * or unpublished directories are rejected, never chmodded, removed or adopted.
 * Constructor/status/capabilities do no IO. Only install creates storage/downloads;
 * only start launches. No automatic recovery, model download or process adoption.
 * Explicit starts persist private credentials and allowlisted launch preferences.
 * Explicit inspection restores preferences only with a valid installation.
 * Identity is per canonical managed storage root; configuration handoff binds
 * that stable key to the selected provider. Restoration never starts a process.
 * Pinned metadata does not establish real archive/binary/flag compatibility.
 */
export class ManagedLlamaService {
  private readonly root: string;
  private readonly release: Release | undefined;
  private readonly dependencies: ManagedLlamaServiceDependencies;
  private installer: Installer | undefined;
  private lifecycle: Lifecycle | undefined;
  private storage: string | undefined;
  private persistence: Persistence | undefined;
  private preferences: LaunchSettings | null = null;
  private storageClaimed = false;
  private closed = false;
  private installation: ManagedLlamaStatus["installation"] = "unknown";
  private errorCode: string | undefined;
  private active: { kind: Operation; control: AbortController; work: Promise<ManagedLlamaStatus> } | undefined;
  private stopping: Promise<void> | undefined;

  constructor(root: string, dependencies: ManagedLlamaServiceDependencies = {}) {
    this.root = resolve(root);
    this.dependencies = { ...dependencies };
    try { this.release = selectRelease(dependencies.platform); }
    catch { this.release = undefined; }
  }

  capabilities() {
    return {
      supported: Boolean(this.release),
      supportedPlatforms: [...SUPPORTED_PLATFORMS],
      cpuOnly: (this.dependencies.platform?.os ?? process.platform) !== "darwin",
      release: this.release ? { ...this.release } : null,
      binaryCompatibility: "unverified" as const,
      modelDownload: false,
      persistence: "private-launch-state" as const,
    };
  }

  /** Cached installation knowledge, live owned-process state; never queues IO. */
  status(): ManagedLlamaStatus {
    const process = this.lifecycle?.status();
    const phase = !this.release ? "unsupported" : this.stopping ? "stopping"
      : this.active?.kind === "install" ? "installing"
      : this.active?.kind === "inspect" ? "inspecting"
      : this.active?.kind === "start" ? "starting"
      : this.errorCode ? "error" : process?.phase ?? "idle";
    const code = this.errorCode ?? (process?.errorCode ? safeCode(failure(process.errorCode), "start_failed") : undefined);
    return { supported: Boolean(this.release), closed: this.closed, phase,
      installation: this.installation, ownsProcess: process?.ownsProcess === true,
      preferences: this.preferences ? copyPreferences(this.preferences) : null,
      ...(code ? { errorCode: code } : {}) };
  }

  /** Secret-bearing API for explicit configuration-save integration only.
   * Never serialize this into ordinary status, action responses or diagnostics. */
  readyConnectionForConfiguration(): ReadyLlamaConnection | null {
    if (this.closed || this.active || this.stopping) return null;
    const connection = this.lifecycle?.readyConnection();
    return connection ? { baseUrl: connection.baseUrl, model: connection.model,
      contextWindowTokens: connection.contextWindowTokens, apiKey: connection.apiKey } : null;
  }

  install(): Promise<ManagedLlamaStatus> { return this.run("install"); }
  start(input: unknown): Promise<ManagedLlamaStatus> { return this.run("start", input); }
  /** Explicit read-only disk inspection, allowed only while no work/process is active. */
  refreshStatus(): Promise<ManagedLlamaStatus> { return this.run("inspect"); }

  private rejected(code: string): Promise<ManagedLlamaStatus> {
    const result = Promise.reject<ManagedLlamaStatus>(failure(code));
    void result.catch(() => {});
    return result;
  }
  private run(kind: Operation, input?: unknown): Promise<ManagedLlamaStatus> {
    if (this.closed) return this.rejected("closed");
    if (!this.release) return this.rejected("unsupported_platform");
    if (this.active || this.stopping || this.lifecycle?.status().ownsProcess) return this.rejected("busy");
    const control = new AbortController();
    this.errorCode = undefined;
    const work = Promise.resolve().then(async () => {
      try {
        control.signal.throwIfAborted();
        await this.prepare(control.signal);
        control.signal.throwIfAborted();
        const installed = await this.installer!.inspect();
        control.signal.throwIfAborted();
        this.installation = installed ? "installed" : "missing";
        if (!installed) this.preferences = null;
        // A private directory alone is not evidence that it belongs to us.
        if (!installed && !this.storageClaimed) {
          let present = false;
          try { await lstat(this.storage!); present = true; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw failure("storage_unavailable"); }
          if (present) throw failure("storage_conflict");
        }
        control.signal.throwIfAborted();
        if (kind === "install") {
          // Reservation follows absence check. Installer creates/validates private
          // storage and owns publication/cleanup. Caller excludes ancestor races.
          this.storageClaimed = true;
          await this.installer!.install(control.signal);
          this.installation = "installed";
        } else if (kind === "start") {
          if (!installed) throw failure("not_installed");
          if (!this.lifecycle) {
            const deps: LifecycleDependencies = { installer: this.installer!,
              resolveCredential: async (settings, signal) => {
                signal.throwIfAborted();
                // Validation and installer/port checks precede this callback.
                const snapshot = copyPreferences(settings);
                try {
                  const result = await this.getPersistence().prepareStart(snapshot);
                  signal.throwIfAborted();
                  if (typeof result.apiKey !== "string" || !/^[a-f0-9]{64}$/u.test(result.apiKey))
                    throw failure("persistence_unavailable");
                  this.preferences = copyPreferences(snapshot);
                  return result.apiKey;
                } catch {
                  signal.throwIfAborted();
                  throw failure("persistence_unavailable");
                }
              },
              ...(this.dependencies.spawn ? { spawn: this.dependencies.spawn } : {}),
              ...(this.dependencies.health ? { health: this.dependencies.health } : {}),
              ...(this.dependencies.validateLaunch ? { validateLaunch: this.dependencies.validateLaunch } : {}),
              ...(this.dependencies.checkPort ? { checkPort: this.dependencies.checkPort } : {}) };
            this.lifecycle = this.dependencies.createLifecycle?.(deps) ?? new ManagedLlamaLifecycle(deps);
          }
          control.signal.throwIfAborted();
          // Intentionally discard the secret-bearing launch result.
          await this.lifecycle.start(input);
        } else if (installed) {
          // Explicit inspect only; no writes and no persistence IO on GET status.
          this.preferences = null;
          try {
            const restored = await this.getPersistence().readPreferences();
            control.signal.throwIfAborted();
            this.preferences = restored ? copyPreferences(restored) : null;
          } catch {
            control.signal.throwIfAborted();
            throw failure("persistence_unavailable");
          }
        }
        control.signal.throwIfAborted();
      } catch (error) {
        this.errorCode = control.signal.aborted ? "cancelled" : safeCode(error,
          kind === "install" ? "install_failed" : kind === "inspect" ? "inspection_failed" : "start_failed");
        throw failure(this.errorCode);
      } finally {
        if (this.active?.control === control) this.active = undefined;
      }
      return this.status();
    });
    this.active = { kind, control, work };
    void work.catch(() => {});
    return work;
  }

  /** Only called after installer ownership validation, never on construction. */
  private getPersistence(): Persistence {
    if (!this.storage) throw failure("persistence_unavailable");
    return this.persistence ??= this.dependencies.createPersistence?.(this.storage)
      ?? new ManagedLlamaPersistence(this.storage);
  }

  private async prepare(signal: AbortSignal): Promise<void> {
    if (this.installer) return;
    try {
      const root = await realpath(this.root);
      if (!(await lstat(root)).isDirectory()) throw failure("storage_unavailable");
      signal.throwIfAborted();
      const storage = join(root, ".abot-managed-llama");
      const installer = this.dependencies.createInstaller?.(storage, this.release!)
        ?? new LlamaInstaller(storage, this.release!, this.dependencies.download);
      this.storage = storage;
      this.installer = installer;
    } catch { throw failure("storage_unavailable"); }
  }

  /** Cancel install/start immediately; await their cleanup, then confirm stop.
   * Failed termination retains the lifecycle owner and can be retried. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const active = this.active;
    active?.control.abort(failure("cancelled"));
    const work = Promise.resolve().then(async () => {
      let stopError: unknown;
      try {
        // Stop a pending lifecycle start before waiting on the service operation.
        try { await this.lifecycle?.stop(); } catch (error) { stopError = error; }
        await active?.work.catch(() => {});
        // No new launch can pass the aborted controller; close also fences the
        // delegated lifecycle permanently. Retry cleanup if the first stop failed.
        if (this.closed) await this.lifecycle?.close();
        else await this.lifecycle?.stop();
        if (this.lifecycle?.status().ownsProcess) throw failure("termination_unconfirmed");
        this.errorCode = undefined;
      } catch (error) {
        this.errorCode = safeCode(error ?? stopError, "stop_failed");
        throw failure(this.errorCode);
      } finally { this.stopping = undefined; }
    });
    this.stopping = work;
    void work.catch(() => {});
    return work;
  }
  cancel(): Promise<void> { return this.stop(); }
  /** Synchronous permanent fence; no new install/start/inspection after this call. */
  close(): Promise<void> {
    this.closed = true;
    return this.stop();
  }
}
