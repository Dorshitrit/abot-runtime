import type {
  RuntimeEnvironmentServices,
  RuntimeRequestHandler,
} from "./composition.js";
import type { RuntimeHostHandle } from "./ports.js";
import { acquireHostScheduler } from "./runtime-host-scheduler-ownership.js";

/** Keep legacy synchronous start while exposing and enforcing async readiness. */
export function startRuntimeHostLifecycle(
  services: RuntimeEnvironmentServices | undefined,
  requests: RuntimeRequestHandler | undefined,
  connect: (requests: RuntimeRequestHandler | undefined) => RuntimeHostHandle,
): RuntimeHostHandle {
  let transport: RuntimeHostHandle | undefined;
  let stopping: Promise<void> | undefined;
  let stopped = false;
  const scheduler = acquireHostScheduler(services);
  const ready = scheduler.ready.then(() => {
    if (stopped) throw new Error("runtime_host_stopped");
  });

  function stop(): Promise<void> {
    if (stopping) return stopping;
    stopped = true;
    const shutdowns = [transport?.stop, scheduler.release];
    stopping = Promise.all(
      shutdowns.map(async (shutdown) => shutdown?.()),
    ).then(() => undefined);
    return stopping;
  }

  function assertHostRunning(): void {
    if (stopped) throw new Error("runtime_host_stopped");
  }

  const steer = requests?.steer?.bind(requests);
  const readyRequests = requests
    ? Object.freeze({
        ...requests,
        ...(steer
          ? {
              async steer(
                ...args: Parameters<NonNullable<RuntimeRequestHandler["steer"]>>
              ) {
                await ready;
                assertHostRunning();
                return steer(...args);
              },
            }
          : {}),
        async handle(...args: Parameters<RuntimeRequestHandler["handle"]>) {
          await ready;
          assertHostRunning();
          return requests.handle(...args);
        },
      })
    : undefined;

  // Hosts that use the historical { stop } handle still get automatic startup
  // and cleanup. Reading ready is optional and surfaces the original failure.
  void ready.catch(async (error) => {
    await stop().catch((cleanupError) => {
      console.error("Runtime host cleanup failed:", cleanupError);
    });
    if (error instanceof Error && error.message === "runtime_host_stopped")
      return;
    console.error("Runtime host startup failed:", error);
  });
  try {
    transport = connect(readyRequests);
  } catch (error) {
    void stop().catch((cleanupError) => {
      console.error("Runtime host cleanup failed:", cleanupError);
    });
    throw error;
  }
  return Object.freeze({ ready, stop });
}
