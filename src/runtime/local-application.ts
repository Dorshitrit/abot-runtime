import { join } from "node:path";
import { loadRuntimeConfig } from "./config.js";
import type { RuntimeConfig } from "./ports.js";
import type {
  RuntimeRequestHandler,
  RuntimeRequestOptions,
} from "./composition.js";
import type { SchedulerRun } from "./scheduler/contracts.js";
import { createLocalRuntimeConnection } from "./local-host/transport.js";
import type { LocalRuntimeConnection } from "./local-host/contracts.js";
import { resolveLocalRuntimeIdentity } from "./local-host/client-identity.js";
import { createLocalRuntimeOwner } from "./local-host/app-owner.js";
import { LocalRuntimeClientRequests } from "./local-host/client-requests.js";
import { createLocalMemoryClient } from "./local-host/client-memory.js";
import { createLocalServiceClients } from "./local-host/client-services.js";

export type LocalRuntimeApplicationOptions = Readonly<{
  scheduledRequestOptions?: (run: SchedulerRun) => RuntimeRequestOptions;
}>;

/** Managed library entry: attach to the environment owner or create it once. */
export function createLocalRuntimeApplication(
  config: RuntimeConfig = loadRuntimeConfig(),
  options: LocalRuntimeApplicationOptions = {},
) {
  let connection: LocalRuntimeConnection | undefined;
  let startup: Promise<void> | undefined;
  let stopped = false;
  const call = async (method: string, args: readonly unknown[]) => {
    await start();
    return connection!.call(method, args);
  };
  const client = new LocalRuntimeClientRequests(
    call,
    options.scheduledRequestOptions,
  );
  const memory = createLocalMemoryClient(
    call,
    config.longTermMemory?.enabled === true,
  );
  const services = Object.freeze({
    config,
    ...createLocalServiceClients(call),
    longTermMemory: memory.service,
  });

  async function connect(): Promise<void> {
    const current = await createLocalRuntimeConnection({
      directory: join(config.paths.runtimeDir, "local-host"),
      identity: resolveLocalRuntimeIdentity(config),
      createOwner: () => createLocalRuntimeOwner(config),
    });
    connection = current;
    try {
      current.onClose(() => client.close(true));
      current.setClientHandler(async (method, args) => {
        if (method === "memory.event") {
          memory.handleEvent(args);
          return null;
        }
        return client.handleCallback(method, args);
      });
      current.subscribe((event) => client.receive(event));
      if (options.scheduledRequestOptions) {
        await current.call("controls.register", []);
      }
    } catch (error) {
      await current.close();
      throw error;
    }
  }

  function start(): Promise<void> {
    if (stopped) return Promise.reject(new Error("local_runtime_stopped"));
    startup ??= connect().catch(clearFailedInitialStartup);
    return startup;
  }

  function clearFailedInitialStartup(error: unknown): never {
    // A later explicit call may reconnect only if no transport was established.
    // Established connection loss or uncertain RPC work must never be replayed.
    if (!connection) startup = undefined;
    throw error;
  }

  return Object.freeze({
    services,
    requests: client.requests as RuntimeRequestHandler,
    start,
    async stop(): Promise<void> {
      stopped = true;
      try {
        await startup;
      } finally {
        client.close();
        await connection?.close();
      }
    },
    getOwnership: () => connection?.ownership,
    subscribeScheduledEvents: client.subscribe.bind(client),
  });
}

export type LocalRuntimeApplication = ReturnType<
  typeof createLocalRuntimeApplication
>;
