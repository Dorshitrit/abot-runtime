import { join } from "node:path";
import { expect, vi } from "vitest";
import type { ToolModuleDeclaration } from "../../../capabilities/tool-types.js";
import { successResult } from "../../../plugin-sdk/index.js";
import { createConfiguredToolRegistry } from "../../capabilities/configured-tool-registry.js";
import { createLocalRuntimeOwner } from "../../local-host/app-owner.js";
import { createLocalRuntimeConnection } from "../../local-host/transport.js";
import { resolveLocalRuntimeIdentity } from "../../local-host/client-identity.js";
import { createLocalRuntimeApplication } from "../../local-application.js";
import { LocalRequestExecution } from "../../../web-ui/local-runtime/request-execution.js";
import { ManagedWebToolApprovals } from "../../../web-ui/local-runtime/managed-tool-approvals.js";
import { RealtimeClientHub } from "../../../web-ui/local-runtime/realtime-hub.js";
import { createExecApprovalScript } from "./exec-sensitive-approval-script.js";
import { prepareWindowsEndpointFixture } from "./windows-endpoint-fixture.js";
import {
  createSchedulerRuntimeFixture,
  createSchedulerTestGate,
} from "./scheduler-runtime-fixture.js";

export async function createWebSavedApprovalSteeringFixture(
  policy: "execution-agent-v1" | "supervisor-worker-v1",
  cleanup: Array<() => Promise<void>>,
) {
  const base = await createSchedulerRuntimeFixture(policy);
  await base.application.stop();
  cleanup.push(() => base.dispose());
  const effect = createSchedulerTestGate();
  const model = createExecApprovalScript(
    policy,
    [{ capabilityId: "record_approval_effect", controls: {} }],
    "approval_fixture",
  );
  const execute = vi.fn(async () => {
    await effect.waiting;
    return successResult({ output: "The approved effect completed." });
  });
  const module: ToolModuleDeclaration = {
    definition: {
      name: "approval_fixture_effect",
      routingCapability: "semantic_mutation",
      catalogGroups: ["approval_fixture"],
    },
    normalInvocation: {
      version: 1,
      operations: [
        {
          operationId: "record_approval_effect",
          summary: "Record an effect.",
          effect: "mutating",
          approval: "request_policy",
          input: {
            type: "object",
            additionalProperties: false,
            properties: {},
            required: [],
          },
        },
      ],
    },
    implementation: execute,
  };
  const owner = await createLocalRuntimeOwner(base.config, {
    models: model,
    tools: createConfiguredToolRegistry(base.config, [module]),
  });
  cleanup.push(async () => {
    await owner.stop();
    await owner.whenIdle?.();
  });
  const endpointDirectory = join(base.config.paths.runtimeDir, "local-host");
  const connection = await createLocalRuntimeConnection({
    directory: endpointDirectory,
    identity: resolveLocalRuntimeIdentity(base.config),
    createOwner: async () => owner,
  });
  cleanup.push(() => connection.close());
  await prepareWindowsEndpointFixture(endpointDirectory);
  const client = createLocalRuntimeApplication(base.config);
  cleanup.push(() => client.stop());
  const events: Record<string, unknown>[] = [];
  const requests = new LocalRequestExecution(
    new RealtimeClientHub((event) => events.push(event)),
  );
  const unsubscribe = client.subscribeScheduledEvents((event) =>
    requests.publishScheduled(event),
  );
  cleanup.push(async () => unsubscribe());
  cleanup.push(async () => effect.open());
  const resolve = vi.fn((id: string) => {
    expect(id).toBe(base.config.runtimeId);
    return client;
  });
  const approvals = new ManagedWebToolApprovals(resolve, requests);
  await client.start();
  return {
    base,
    effect,
    execute,
    owner,
    client,
    requests,
    events,
    resolve,
    approvals,
    model,
  };
}
