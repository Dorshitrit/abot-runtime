import { join } from "node:path";
import type { RuntimeDependencyOverrides } from "../../composition.js";
import type { LocalRuntimeOwner } from "../../local-host/contracts.js";
import { createLocalRuntimeOwner } from "../../local-host/app-owner.js";
import { resolveLocalRuntimeIdentity } from "../../local-host/client-identity.js";
import {
  createLocalRuntimeConnection,
  type LocalRuntimeConnection,
} from "../../local-host/transport.js";
import {
  createSchedulerRuntimeFixture,
  createSchedulerTestGate,
} from "./scheduler-runtime-fixture.js";

export async function createOwnerShutdownFixture(
  extra: RuntimeDependencyOverrides = {},
) {
  const entered = createSchedulerTestGate();
  const completion = createSchedulerTestGate();
  const scripted = await createSchedulerRuntimeFixture(
    "supervisor-worker-v1",
    async (input) => {
      if (input.modelStep !== "supervisor.decision") return;
      entered.open();
      await completion.waiting;
    },
  );
  await scripted.application.stop();
  const connections: LocalRuntimeConnection[] = [];
  const owners: LocalRuntimeOwner[] = [];
  const options = {
    directory: join(scripted.config.paths.runtimeDir, "local-host"),
    identity: resolveLocalRuntimeIdentity(scripted.config),
    createOwner: async () => {
      const owner = await createLocalRuntimeOwner(scripted.config, {
        models: { invoke: scripted.invoke, invokeRaw: scripted.invokeRaw },
        ...extra,
      });
      owners.push(owner);
      return owner;
    },
  };
  async function connect(startupTimeoutMs = 2000) {
    const connection = await createLocalRuntimeConnection({
      ...options,
      startupTimeoutMs,
    });
    connection.setClientHandler(async () => undefined);
    connections.push(connection);
    return connection;
  }
  const owner = await connect();
  return {
    ...scripted,
    owner,
    entered,
    completion,
    connect,
    options,
    async dispose() {
      completion.open();
      for (const connection of connections.reverse()) await connection.close();
      await Promise.all(owners.map((owner) => owner.whenIdle?.()));
      await scripted.dispose();
    },
  };
}

export function ordinaryOwnerRequest(requestId: string) {
  return {
    type: "run_request",
    requestId,
    sessionId: "session",
    text: requestId,
    agentMode: "reasoning",
    modelPreference: { profileId: "scheduled-model", scope: "all" },
    toolPermissionMode: "full_access",
  };
}
