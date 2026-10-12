import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { ToolModuleDeclaration } from "../../capabilities/tool-types.js";
import { successResult } from "../../plugin-sdk/index.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { createLocalRuntimeOwner } from "../local-host/app-owner.js";
import { createLocalRuntimeConnection } from "../local-host/transport.js";
import { resolveLocalRuntimeIdentity } from "../local-host/client-identity.js";
import { createLocalRuntimeApplication } from "../local-application.js";
import { LocalRequestExecution } from "../../web-ui/local-runtime/request-execution.js";
import { ManagedWebToolApprovals } from "../../web-ui/local-runtime/managed-tool-approvals.js";
import { RealtimeClientHub } from "../../web-ui/local-runtime/realtime-hub.js";
import { resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createExecApprovalScript } from "./support/exec-sensitive-approval-script.js";
import { prepareWindowsEndpointFixture } from "./support/windows-endpoint-fixture.js";
import {
  createSchedulerRuntimeFixture,
  createSchedulerTestGate,
} from "./support/scheduler-runtime-fixture.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release();
  resetDebugLoggerConfig();
});

async function fixture(policy: "execution-agent-v1" | "supervisor-worker-v1") {
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

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
  "Web STEER reaches a resumed saved ASK request without reviving its retired projection (%s)",
  async (policy) => {
    const f = await fixture(policy);
    const responses: Record<string, unknown>[] = [];
    const response = {
      writeHead: vi.fn(),
      end: (raw: string) => responses.push(JSON.parse(raw)),
    } as unknown as ServerResponse;
    await f.requests.start(
      response,
      {
        sessionId: "session",
        text: "Perform the fixture action.",
        toolPermissionMode: "ask",
        agentMode: "reasoning",
        modelPreference: { profileId: "scheduled-model", scope: "all" },
      },
      f.base.config.runtimeId,
      f.client,
    );
    const requestId = String(responses[0]!.requestId);
    await vi.waitFor(
      () =>
        expect(f.events).toContainEqual(
          expect.objectContaining({
            name: "request.lifecycle.changed",
            lifecycle: expect.objectContaining({ status: "awaiting_approval" }),
          }),
        ),
      { timeout: 5000 },
    );
    await vi.waitFor(() => expect(f.requests.healthDetails()).toEqual([]));
    expect(f.owner.isIdle?.()).toBe(true);
    expect(f.execute).not.toHaveBeenCalled();
    const message = {
      requestId,
      environment: f.base.config.runtimeId,
      steerId: "resumed-steer",
      text: "Keep the response brief after this action.",
    };
    expect(await f.requests.handleSteer(message, f.resolve)).toMatchObject({
      accepted: false,
      reason: "request_not_active",
    });
    const [pending] = await f.approvals.list(f.base.config.runtimeId);
    expect(pending).toMatchObject({ requestId, sessionId: "session" });
    expect(
      await f.approvals.decide({
        ...pending!,
        commandId: "approve-once",
        approved: true,
      }),
    ).toBe(true);
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
    expect(f.requests.healthDetails()).toEqual([]);
    const receipt = {
      type: "steer_ack",
      requestId,
      steerId: message.steerId,
      accepted: true,
      acceptedSequence: 1,
    };
    expect(await f.requests.handleSteer(message, f.resolve)).toEqual(receipt);
    expect(await f.requests.handleSteer(message, f.resolve)).toEqual(receipt);
    expect(
      await f.requests.handleSteer(
        { ...message, text: "Conflicting update" },
        f.resolve,
      ),
    ).toMatchObject({
      accepted: false,
      reason: "steer_id_conflict",
    });
    expect(f.requests.healthDetails()).toEqual([]);
    f.effect.open();
    await f.owner.whenIdle?.();
    await vi.waitFor(
      () =>
        expect(f.events).toContainEqual(
          expect.objectContaining({
            type: "completed",
            requestId,
          }),
        ),
      { timeout: 5000 },
    );
    expect(f.execute).toHaveBeenCalledOnce();
    const saved = await f.client.services.sessions.getSessionById("session");
    expect(
      saved!.messages.filter((entry) => entry.content === message.text),
    ).toHaveLength(1);
    expect(
      saved!.messages.find((entry) => entry.content === message.text),
    ).toMatchObject({
      role: "user",
      requestId,
    });
    expect(
      saved!.requests?.find((entry) => entry.requestId === requestId)?.status,
    ).toBe("completed");
    expect(
      await f.requests.handleSteer(
        { ...message, steerId: "after-completion" },
        f.resolve,
      ),
    ).toMatchObject({
      accepted: false,
      reason: "request_not_active",
    });
    expect(f.requests.healthDetails()).toEqual([]);
    expect(f.model.invokeRaw).not.toHaveBeenCalled();
  },
  20000,
);
