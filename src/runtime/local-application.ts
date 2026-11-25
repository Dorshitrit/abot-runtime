import { socketConnectionClient } from "./socket-connection/contracts.js";
import type { RuntimeBridgeConnection } from "../bridge/runtime-connection.js";
import { createLocalMaintenanceClient } from "./local-host/client-maintenance.js";
import { createLocalAgentEvents, createLocalAgentsClient } from "./local-host/client-agents.js";
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
import { createLocalInformationBasketClient } from "./local-host/client-information-basket.js";
import { createLocalLearningClient } from "./local-host/client-learning.js";
import { createLocalNativePermissionClient } from "./local-host/client-native-permissions.js";
import type { SparkHomeAppearanceOptions } from "./spark-home/application-contracts.js";
import { createLocalSparkHomeEvents } from "./local-host/client-spark-home-events.js";
import { createSparkChatAccess } from "./spark-chat/service.js";

export type LocalRuntimeApplicationOptions = SparkHomeAppearanceOptions & Readonly<{
  scheduledRequestOptions?: (run: SchedulerRun) => RuntimeRequestOptions;
  bridge?: RuntimeBridgeConnection;
}>;

/** Managed library entry: attach to the environment owner or create it once. */
export function createLocalRuntimeApplication(
  config: RuntimeConfig = loadRuntimeConfig(),
  options: LocalRuntimeApplicationOptions = {},
) {
  let connection: LocalRuntimeConnection | undefined;
  let startup: Promise<void> | undefined;
  let approvalConnection: Promise<void> | undefined;
  let stopped = false;
  const call = async (method: string, args: readonly unknown[]) => {
    await start();
    return connection!.call(method, args);
  };
  const client = new LocalRuntimeClientRequests(
    call,
    options.scheduledRequestOptions,
    async (method, args) => {
      await start();
      approvalConnection ??= attachApprovalConnection().finally(() => {
        approvalConnection = undefined;
      });
      await approvalConnection;
      return connection!.call(method, args);
    },
  );
  const memory = createLocalMemoryClient(
    call,
    config.longTermMemory?.enabled === true,
  );
  const learning = createLocalLearningClient(call);
  const basket = createLocalInformationBasketClient(call);
  const agentEvents = createLocalAgentEvents();
  const agents = createLocalAgentsClient(call);
  const homeEvents = createLocalSparkHomeEvents();
  const nativePermissions = createLocalNativePermissionClient((method, args) => {
    if (stopped || !connection) return Promise.reject(new Error("local_runtime_not_started"));
    return connection.call(method, args);
  });
  const services = Object.freeze({
    config,
    ...createLocalServiceClients(call),
    maintenance: createLocalMaintenanceClient(call),
    longTermMemory: memory.service,
    passiveLearning: learning.service,
    informationBasket: basket.service,
  });

  async function attachApprovalConnection(): Promise<void> {
    const reconnected = await connection!.reconnect();
    if (!reconnected) return;
    if (options.scheduledRequestOptions)
      await connection!.call("controls.register", []);
    if (options.sparkHomeAppearance)
      await connection!.call("sparkHomeHost.register", []);
  }

  async function connect(): Promise<void> {
    const current = await createLocalRuntimeConnection({
      directory: join(config.paths.runtimeDir, "local-host"),
      identity: resolveLocalRuntimeIdentity(config),
      createOwner: () => createLocalRuntimeOwner(config),
    });
    connection = current;
    try {
      current.onClose(() => {
        client.close(true);
        learning.close();
        // Basket observers survive explicit same-owner reconnect until application shutdown.
      });
      current.setClientHandler(async (method, args) => {
        if (method === "sparkHome.appearance") return options.sparkHomeAppearance?.();
        if (method === "memory.event") {
          memory.handleEvent(args);
          return null;
        }
        return client.handleCallback(method, args);
      });
      current.subscribe((event) => {
        client.receive(event);
        learning.receive(event);
        basket.receive(event);
        homeEvents.receive(event);
        agentEvents.receive(event);
      });
      if (options.scheduledRequestOptions) {
        await current.call("controls.register", []);
      }
      if (options.sparkHomeAppearance) await current.call("sparkHomeHost.register", []);
      if (options.bridge && !stopped) {
        await current.call("bridge.start", [options.bridge]).catch(() => {
          console.error("The outbound Socket connection could not be started. Local runtime is available.");
        });
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
    agents,
    socketConnection: socketConnectionClient(call),
    requests: Object.freeze({
      ...client.requests,
      sparkChat: createSparkChatAccess(services),
      approvalControls: Object.freeze({
        ...client.approvals,
        subscribeEvents: client.subscribe.bind(client),
      }),
    }) as RuntimeRequestHandler,
    approvals: client.approvals,
    nativePermissions,
    start,
    async connectBridge(bridge: RuntimeBridgeConnection): Promise<void> {
      await start();
      if (stopped) throw new Error("local_runtime_stopped");
      await connection!.call("bridge.start", [bridge]);
    },
    async stop(): Promise<void> {
      stopped = true;
      try {
        await startup;
      } finally {
        client.close();
        learning.close();
        basket.close();
        homeEvents.close();
        agentEvents.close();
        await connection?.close();
      }
    },
    getOwnership: () => connection?.ownership,
    isOwnerIdle: () => !stopped && connection?.isOwnerIdle() === true,
    stopIfIdle(): Promise<boolean> {
      if (stopped) return Promise.resolve(false);
      if (!connection?.isOwnerIdle()) return Promise.resolve(false);
      // Do not await startup between checking admission and closing intake.
      const closing = connection.closeIfIdle();
      stopped = true;
      client.close();
      learning.close();
      basket.close();
      homeEvents.close();
      agentEvents.close();
      return closing;
    },
    subscribeScheduledEvents: client.subscribe.bind(client),
    subscribeLearningEvents: learning.subscribe,
    subscribeInformationBasketEvents: basket.subscribe,
    subscribeAgentEvents: agentEvents.subscribe,
    subscribeSparkHomeEvents: homeEvents.subscribe,
  });
}

export type LocalRuntimeApplication = ReturnType<
  typeof createLocalRuntimeApplication
>;
