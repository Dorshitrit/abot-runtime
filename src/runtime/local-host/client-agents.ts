import type { AgentWorkspaceClient } from "../agents/workspace-client-contracts.js";
import type { LocalRuntimeCallHandler } from "./contracts.js";

/** Explicit local-client contract. No lifecycle methods or arbitrary object paths cross IPC. */
export const AGENT_WORKSPACE_METHODS = {
  store: ["read"],
  application: ["snapshot", "detail", "refresh", "send", "pause", "steer", "cancel", "resolve", "associatedSessionIds"],
  management: ["previewAuthoring", "register", "update", "archive", "restore"],
  approvals: ["list", "decide"],
  schedules: ["list", "create", "update", "cancel"],
  deletion: ["remove"],
  projection: ["notifications", "attention", "through", "pending", "acknowledge"],
} as const satisfies { [K in Exclude<keyof AgentWorkspaceClient, "local" | "remote" | "isBusy">]: readonly (keyof AgentWorkspaceClient[K])[] };

export function createLocalAgentsClient(call: LocalRuntimeCallHandler): AgentWorkspaceClient {
  const services = Object.fromEntries(Object.entries(AGENT_WORKSPACE_METHODS).map(([group, methods]) => [
    group, Object.fromEntries(methods.map(method => [method, (...args: unknown[]) => call(`agents.${group}.${method}`, args)])),
  ])) as Omit<AgentWorkspaceClient, "local" | "remote" | "isBusy">;
  return { ...services,
    local: command => call("agents.local", [command]) as ReturnType<AgentWorkspaceClient["local"]>,
    remote: command => call("agents.remote", [command]) as ReturnType<AgentWorkspaceClient["remote"]>,
    isBusy: () => call("agents.isBusy", []) as Promise<boolean>,
  };
}

export function createLocalAgentEvents() {
  const listeners = new Set<(revision: number) => void>();
  return {
    subscribe(listener: (revision: number) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    receive(event: unknown) {
      if (!event || typeof event !== "object" || !("type" in event) || event.type !== "agents.changed" ||
        !("revision" in event) || typeof event.revision !== "number" || !Number.isSafeInteger(event.revision) || event.revision < 0) return;
      for (const listener of listeners) {
        try { listener(event.revision); } catch { /* A view cannot affect the owner. */ }
      }
    },
    close() { listeners.clear(); },
  };
}
