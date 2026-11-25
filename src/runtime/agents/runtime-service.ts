import { join } from "node:path";
import type { RuntimeConfig } from "../ports.js";
import { FileAgentStateStore } from "./file-store.js";
import { createAgentManagementService } from "./management-service.js";
import { createAgentControllerService } from "./controller-service.js";

/** Lazy environment-owned management: no files, timers or model calls at composition time. */
export function createRuntimeAgentServices(config: RuntimeConfig) {
  const store = new FileAgentStateStore(join(config.paths.runtimeDir, "agents", "state.json"));
  return Object.freeze({
    agents: createAgentManagementService(store, config),
    agentController: createAgentControllerService(store, config),
  });
}
