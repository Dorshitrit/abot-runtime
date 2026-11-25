import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { dirname, isAbsolute } from "node:path";
import { LIMITS, ManagedLlamaError, requireValue, type Spawn, type Health, type LaunchSettings } from "./contracts.js";
import type { LlamaInstaller } from "./install.js";
import { validateLaunch } from "./launch.js";
import { llamaProcessEnvironment } from "./process-environment.js";

function failure(code: string): ManagedLlamaError {
  return new ManagedLlamaError(code, "Managed llama.cpp operation failed: " + code + ".");
}

/** Reject promptly even if an injected asynchronous dependency ignores abort.
 * Dependencies must still release their own resources on cancellation. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    const clean = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    work.then(value => { clean(); resolve(value); }, error => { clean(); reject(error); });
    if (signal.aborted) { clean(); abort(); }
  });
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** A probe only: there is necessarily a bind race before spawn. Authentication
 * and child liveness, not this port probe, establish readiness. */
export function checkLlamaPort(port: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    };
    const abort = () => {
      server.close();
      finish(failure("start_cancelled"));
    };
    server.on("error", () => finish(failure("port_unavailable")));
    server.on("listening", () => {
      server.close(error => finish(error ? failure("port_unavailable") : undefined));
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    server.listen({ host: "127.0.0.1", port, exclusive: true, signal });
  });
}

/** The negative credential probe prevents accepting an unauthenticated server.
 * No redirects, public-health fallback, response logging or model invocation.
 * The lifecycle bounds the complete call, including response-body consumption. */
export const authenticatedLlamaHealth: Health = async (port, token, alias, signal) => {
  const url = "http://127.0.0.1:" + port + "/v1/models";
  const wrong = await fetch(url, {
    headers: { Authorization: "Bearer " + randomBytes(32).toString("hex") },
    redirect: "error", signal,
  });
  const denied = wrong.status === 401 || wrong.status === 403;
  await wrong.body?.cancel();
  if (!denied) return false;
  const response = await fetch(url, {
    headers: { Authorization: "Bearer " + token }, redirect: "error", signal,
  });
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel();
    return false;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 65536) return false;
      chunks.push(chunk.value);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || !("data" in parsed) || !Array.isArray(parsed.data)) return false;
    return parsed.data.some((model: unknown) => model !== null && typeof model === "object" && "id" in model && model.id === alias);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
};

export interface LifecycleDependencies {
  installer: Pick<LlamaInstaller, "inspect">;
  spawn?: Spawn;
  health?: Health;
  validateLaunch?: (input: unknown) => Promise<LaunchSettings>;
  checkPort?: (port: number, signal: AbortSignal) => Promise<void>;
  /** Trusted private resolver; never expose its result in public status. */
  resolveCredential?: (settings: LaunchSettings, signal: AbortSignal) => Promise<string>;
  /** Trusted host-owned launch plan; never accepts browser-supplied arguments. */
  launchArguments?: (settings: LaunchSettings) => string[];
  launchEnvironment?: (token: string) => NodeJS.ProcessEnv;
  signalOwnedProcess?: (child: ChildProcess, signal: NodeJS.Signals) => void;
}
export interface ReadyLlamaConnection {
  baseUrl: string;
  model: string;
  contextWindowTokens: number;
  /** Secret: pass only to an explicit configuration-save operation, never logs. */
  apiKey: string;
}
export type LifecyclePhase = "idle" | "starting" | "ready" | "stopping" | "stopped" | "error";
type Owned = {
  child: ChildProcess;
  exited: boolean;
  failed: boolean;
  done: Promise<void>;
};

/** One application owner per instance; caller must await close on shutdown.
 * No PID scanning, process adoption, install, global handlers or automatic start.
 * Constructor and status perform no IO. Installation is a separate explicit API.
 * Injected dependencies are trusted seams, not a security boundary. */
export class ManagedLlamaLifecycle {
  private phase: LifecyclePhase = "idle";
  private closed = false;
  private errorCode: string | undefined;
  private owned: Owned | undefined;
  private connection: ReadyLlamaConnection | undefined;
  private controller: AbortController | undefined;
  private starting: Promise<ReadyLlamaConnection> | undefined;
  private stopping: Promise<void> | undefined;
  private terminating: Promise<boolean> | undefined;
  private readonly spawn: Spawn;
  private readonly health: Health;
  private readonly validate: (input: unknown) => Promise<LaunchSettings>;
  private readonly checkPort: (port: number, signal: AbortSignal) => Promise<void>;

  constructor(private readonly dependencies: LifecycleDependencies) {
    this.spawn = dependencies.spawn ?? nodeSpawn;
    this.health = dependencies.health ?? authenticatedLlamaHealth;
    this.validate = dependencies.validateLaunch ?? validateLaunch;
    this.checkPort = dependencies.checkPort ?? checkLlamaPort;
  }

  status(): { phase: LifecyclePhase; closed: boolean; ownsProcess: boolean; errorCode?: string } {
    return { phase: this.phase, closed: this.closed, ownsProcess: Boolean(this.owned),
      ...(this.errorCode ? { errorCode: this.errorCode } : {}) };
  }

  /** Deliberately separate from nonsecret status. Saving does not happen here. */
  readyConnection(): ReadyLlamaConnection | null {
    return !this.closed && this.phase === "ready" && this.connection && this.owned && this.alive(this.owned)
      ? { ...this.connection } : null;
  }

  start(input: unknown): Promise<ReadyLlamaConnection> {
    if (this.closed || this.starting || this.stopping || this.owned)
      return this.rejected(failure(this.closed ? "closed" : "busy"));
    this.phase = "starting";
    this.errorCode = undefined;
    this.connection = undefined;
    const control = new AbortController();
    this.controller = control;
    // Defer work so the in-flight guard is set before any injected callback runs.
    const work = Promise.resolve().then(() => this.launch(input, control));
    this.starting = work;
    void work.then(() => this.finishStart(work, control), () => this.finishStart(work, control));
    return work;
  }

  private rejected<T>(error: Error): Promise<T> {
    const result = Promise.reject<T>(error);
    void result.catch(() => {});
    return result;
  }
  private finishStart(work: Promise<ReadyLlamaConnection>, control: AbortController): void {
    if (this.starting === work) this.starting = undefined;
    if (this.controller === control) this.controller = undefined;
  }
  private alive(owned: Owned): boolean {
    return !owned.exited && !owned.failed && owned.child.pid !== undefined &&
      owned.child.exitCode === null && owned.child.signalCode === null;
  }

  private track(child: ChildProcess, control: AbortController): Owned {
    let complete!: () => void;
    const done = new Promise<void>(resolve => { complete = resolve; });
    const owned: Owned = { child, exited: false, failed: false, done };
    this.owned = owned;
    const exited = () => {
      if (owned.exited) return;
      owned.exited = true;
      complete();
      if (this.owned === owned) {
        this.owned = undefined;
        this.connection = undefined;
        if (this.phase === "ready") { this.phase = "error"; this.errorCode = "child_exited"; }
      }
      control.abort(failure("child_exited"));
    };
    child.once("exit", exited);
    child.once("close", exited);
    // Keep an error listener for the entire lifetime, including failed kills.
    child.on("error", () => {
      owned.failed = true;
      this.connection = undefined;
      if (this.phase === "ready") { this.phase = "error"; this.errorCode = "child_error"; }
      control.abort(failure("child_error"));
      // A failed spawn has no OS process to retain. Kill errors with a PID do.
      if (child.pid === undefined) exited();
    });
    if (child.exitCode !== null || child.signalCode !== null) exited();
    return owned;
  }

  private async launch(input: unknown, control: AbortController): Promise<ReadyLlamaConnection> {
    const signal = control.signal;
    const timer = setTimeout(() => control.abort(failure("readiness_timeout")), LIMITS.readyMs);
    let code = "invalid_launch";
    try {
      signal.throwIfAborted();
      const settings = await abortable(Promise.resolve().then(() => this.validate(input)), signal);
      signal.throwIfAborted();
      code = "installation_unavailable";
      const installed = await abortable(Promise.resolve().then(() => this.dependencies.installer.inspect()), signal);
      signal.throwIfAborted();
      requireValue(installed && isAbsolute(installed.executable), "not_installed", "Install llama.cpp explicitly before starting it.");
      code = "port_unavailable";
      await abortable(Promise.resolve().then(() => this.checkPort(settings.port, signal)), signal);
      signal.throwIfAborted();
      code = "persistence_unavailable";
      let token: string;
      try {
        token = this.dependencies.resolveCredential
          ? await abortable(Promise.resolve().then(() => {
              signal.throwIfAborted();
              return this.dependencies.resolveCredential!(settings, signal);
            }), signal)
          : randomBytes(32).toString("hex");
        signal.throwIfAborted();
        requireValue(typeof token === "string" && /^[a-f0-9]{64}$/u.test(token),
          "persistence_unavailable", "Managed llama.cpp persistence unavailable.");
      } catch {
        signal.throwIfAborted();
        throw failure("persistence_unavailable");
      }
      code = "spawn_failed";
      const child = this.spawn(installed.executable, this.dependencies.launchArguments?.(settings) ?? [
        "--host", "127.0.0.1", "--port", String(settings.port),
        "--model", settings.modelPath, "--alias", settings.alias,
        "--ctx-size", String(settings.contextTokens), "--n-gpu-layers", String(settings.gpuLayers),
      ], {
        shell: false, detached: false, stdio: "ignore", windowsHide: true,
        cwd: dirname(installed.executable),
        // Explicit child-only credential; never put it in process arguments.
        // No inherited environment, loader hooks or LLAMA_ARG_* overrides.
        env: this.dependencies.launchEnvironment?.(token) ?? llamaProcessEnvironment(token),
      });
      const owned = this.track(child, control);
      code = "readiness_failed";
      for (;;) {
        signal.throwIfAborted();
        if (!this.alive(owned)) throw failure("child_exited");
        let ready = false;
        try {
          ready = await abortable(Promise.resolve().then(() => this.health(settings.port, token, settings.alias, signal)), signal);
        } catch {
          signal.throwIfAborted();
        }
        signal.throwIfAborted();
        if (!this.alive(owned)) throw failure("child_exited");
        if (ready) {
          this.connection = { baseUrl: "http://127.0.0.1:" + settings.port,
            model: settings.alias, contextWindowTokens: settings.contextTokens, apiKey: token };
          this.phase = "ready";
          return { ...this.connection };
        }
        await pause(150, signal);
      }
    } catch (error) {
      const internalCodes = new Set(["start_cancelled", "readiness_timeout", "child_exited", "child_error", "not_installed"]);
      const reason = signal.aborted ? signal.reason : error;
      if (reason instanceof ManagedLlamaError && internalCodes.has(reason.code)) code = reason.code;
      this.connection = undefined;
      const terminated = await this.terminate();
      if (!terminated) code = "termination_unconfirmed";
      this.errorCode = code;
      if (!this.stopping) this.phase = "error";
      throw failure(code); // Never surface dependency messages, paths or child output.
    } finally {
      clearTimeout(timer);
    }
  }

  private async waitForExit(owned: Owned, ms: number): Promise<boolean> {
    if (owned.exited) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([owned.done, new Promise<void>(resolve => { timer = setTimeout(resolve, ms); })]);
      return owned.exited;
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  private terminate(): Promise<boolean> {
    if (this.terminating) return this.terminating;
    const owned = this.owned;
    if (!owned || owned.exited) return Promise.resolve(true);
    const work = Promise.resolve().then(async () => {
      if (owned.exited) return true;
      try { this.signalOwned(owned.child, "SIGTERM"); } catch { /* Retain ownership. */ }
      if (await this.waitForExit(owned, LIMITS.stopMs)) return true;
      if (!owned.exited) {
        try { this.signalOwned(owned.child, "SIGKILL"); } catch { /* Retain ownership. */ }
      }
      return this.waitForExit(owned, LIMITS.killMs);
    });
    this.terminating = work;
    void work.then(() => { if (this.terminating === work) this.terminating = undefined; },
      () => { if (this.terminating === work) this.terminating = undefined; });
    return work;
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.phase = "stopping";
    this.connection = undefined;
    this.controller?.abort(failure("start_cancelled"));
    const starting = this.starting;
    const work = Promise.resolve().then(async () => {
      if (starting) await starting.catch(() => {});
      if (!(await this.terminate())) {
        this.phase = "error";
        this.errorCode = "termination_unconfirmed";
        throw failure("termination_unconfirmed");
      }
      this.phase = "stopped";
      this.errorCode = undefined;
    });
    this.stopping = work;
    void work.then(() => { if (this.stopping === work) this.stopping = undefined; },
      () => { if (this.stopping === work) this.stopping = undefined; });
    return work;
  }

  private signalOwned(child: ChildProcess, signal: NodeJS.Signals): void {
    if (this.dependencies.signalOwnedProcess) { this.dependencies.signalOwnedProcess(child, signal); return; }
    child.kill(signal);
  }

  /** Permanent start fence even if termination fails; stop/close may retry cleanup. */
  close(): Promise<void> {
    this.closed = true;
    return this.stop();
  }
}
