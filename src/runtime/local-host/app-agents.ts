import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeEnvironmentServices } from "../composition.js";
import type { AgentWorkspaceOperations } from "../agents/workspace-client-contracts.js";
import { createAgentWorkspaceHost } from "../agents/workspace-host.js";
import { AGENT_REMOTE_READS } from "../agents/remote-workspace-input.js";
import { executeRemoteAgentCommand } from "../agents/remote-workspace.js";
import { AGENT_WORKSPACE_METHODS } from "./client-agents.js";
import { LocalRuntimeClientRequests } from "./client-requests.js";
import type { LocalRuntimeOwner, LocalRuntimePeer } from "./contracts.js";

type Host = ReturnType<typeof createAgentWorkspaceHost>;
const readCalls = new Set(["management.previewAuthoring", "store.read", "application.snapshot", "application.detail", "application.associatedSessionIds",
  "approvals.list", "projection.notifications", "projection.attention", "projection.through", "projection.pending", "schedules.list"]);

/** One environment owner admits commands and executes background Agent work for all attached clients. */
export function createLocalOwnerAgents(services: RuntimeEnvironmentServices, requestCall: LocalRuntimeOwner["call"],
  publish: (event: unknown) => void, runTick: (operation: () => Promise<void>) => Promise<void>) {
  const closeListeners = new Set<() => void>();
  const requests = new LocalRuntimeClientRequests((method, args) => requestCall(method, args, peer));
  const peer: LocalRuntimePeer = {
    id: "local-agents-workspace",
    callClient: (method, args) => requests.handleCallback(method, args),
    onClose(listener) { closeListeners.add(listener); return () => { closeListeners.delete(listener); }; },
  };
  let latestRevision = 0;
  const notify = (revision: number) => {
    latestRevision = Math.max(latestRevision, revision);
    publish({ type: "agents.changed", revision: latestRevision });
  };
  let loaded: Host | undefined;
  let starting: Promise<Host> | undefined;
  let stopping: Promise<void> | undefined;
  let queued = 0;
  let tail = Promise.resolve();
  function get(): Promise<Host> {
    if (stopping) return Promise.reject(new Error("agents_environment_reloading"));
    if (loaded) return Promise.resolve(loaded);
    starting ??= (async () => {
      const host = createAgentWorkspaceHost(services, {
        ...requests.requests,
        approvalControls: { ...requests.approvals, subscribeEvents: requests.subscribe.bind(requests) },
      }, notify, runTick);
      try {
        await host.start();
        loaded = host;
        return host;
      } catch (error) {
        await host.stop();
        throw error;
      }
    })().finally(() => { starting = undefined; });
    return starting;
  }
  function serialize<T>(effect: () => Promise<T>): Promise<T> {
    queued += 1;
    const next = tail.then(effect).finally(() => { queued -= 1; });
    tail = next.then(() => {}, () => {});
    return next;
  }
  function execute(host: Host, command: Record<string, unknown>, local: boolean) {
    const raw: AgentWorkspaceOperations = { ...host, isBusy: async () => host.isBusy() };
    return executeRemoteAgentCommand(raw, services.sessions, command, local);
  }
  async function run(operation: (host: Host) => Promise<unknown>, mutated: boolean) {
    const host = await get();
    const result = await operation(host);
    // Schedule changes live in a separate journal. A stable state revision is still an invalidation.
    if (mutated) await host.store.read().then(state => notify(state.revision)).catch(() => {});
    return result;
  }
  const isBusy = () => Boolean(starting || queued || loaded?.isBusy());
  return {
    isBusy,
    receive(event: unknown) {
      // The workspace peer drives ordinary Agent requests, never scheduled user sessions.
      if (event && typeof event === "object" && "type" in event && event.type === "request.event") requests.receive(event);
    },
    async recoverExisting() {
      try { await lstat(join(services.config.paths.runtimeDir, "agents", "state.json")); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      // Recovery can inspect or cancel a durable work receipt. Ordinary clients can attach
      // while it runs. The first workspace call shares the same startup promise.
      void get().catch(() => console.error("Agent workspace recovery needs attention."));
    },
    async call(method: string, args: readonly unknown[]) {
      if (stopping) throw new Error("agents_environment_reloading");
      if (method === "agents.isBusy" && !args.length) return isBusy();
      if (method === "agents.remote" || method === "agents.local") {
        const value = args[0];
        if (args.length !== 1 || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("agents_input_command");
        const command = value as Record<string, unknown>;
        const read = AGENT_REMOTE_READS.has(String(command.type));
        const effect = () => run(host => execute(host, command, method === "agents.local"), !read);
        return read ? effect() : serialize(effect);
      }
      const [, group, name, ...rest] = method.split(".");
      if (!group || !name || rest.length || !Object.hasOwn(AGENT_WORKSPACE_METHODS, group)) throw new Error("local_runtime_method_unknown");
      const key = group as keyof typeof AGENT_WORKSPACE_METHODS;
      if (!(AGENT_WORKSPACE_METHODS[key] as readonly string[]).includes(name)) throw new Error("local_runtime_method_unknown");
      const operation = (host: Host) => {
        const target = host[key];
        const fn = (target as unknown as Record<string, (...items: unknown[]) => Promise<unknown>>)[name]!;
        return fn.apply(target, [...args]);
      };
      const path = `${group}.${name}`;
      if (readCalls.has(path)) return run(operation, false);
      return serialize(() => run(operation, !path.startsWith("projection.") && path !== "application.refresh"));
    },
    stop(): Promise<void> {
      stopping ??= (async () => {
        await starting?.catch(() => {});
        try { await Promise.all([loaded?.stop(), tail]); }
        finally {
          requests.close();
          for (const listener of closeListeners) listener();
          closeListeners.clear();
        }
      })();
      return stopping;
    },
  };
}
