import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import type { ToolModuleDeclaration } from "../../capabilities/tool-types.js";
import { successResult } from "../../plugin-sdk/index.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import type { RequestExecutionPolicyId } from "../config/model-execution-policy.js";
import { createLocalRuntimeApplication } from "../local-application.js";
import { createLocalRuntimeOwner } from "../local-host/app-owner.js";
import { resolveLocalRuntimeIdentity } from "../local-host/client-identity.js";
import { createLocalRuntimeConnection } from "../local-host/transport.js";
import { resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { ToolApprovalController, ToolApprovalRequest } from "../ports.js";
import { createExecApprovalScript } from "./support/exec-sensitive-approval-script.js";
import {
  createSchedulerRuntimeFixture,
  createSchedulerTestGate,
} from "./support/scheduler-runtime-fixture.js";

const fixtures: Array<{ dispose(): Promise<void> }> = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
  resetDebugLoggerConfig();
});

function createApprovalView() {
  const requests: ToolApprovalRequest[] = [];
  const controller: ToolApprovalController = {
    requestToolApproval(request, options) {
      requests.push(request);
      return new Promise((resolve) => {
        options?.abortSignal?.addEventListener(
          "abort",
          () => resolve({ approved: false, reason: "View detached." }),
          { once: true },
        );
      });
    },
  };
  return { requests, controller };
}

function eventSocket(events: Record<string, unknown>[]): WebSocket {
  return {
    send(data: string) {
      events.push(JSON.parse(data));
    },
  } as WebSocket;
}

async function createApprovalFixture(policy: RequestExecutionPolicyId) {
  const scripted = await createSchedulerRuntimeFixture(policy);
  await scripted.application.stop();
  const model = createExecApprovalScript(
    policy,
    [{ capabilityId: "record_approval_effect", controls: {} }],
    "approval_fixture",
  );
  const execute = vi.fn(async () =>
    successResult({ output: "The single approved fixture effect completed." }),
  );
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
          summary: "Record one fixture effect.",
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
  const registry = createConfiguredToolRegistry(scripted.config, [module]);
  let runtimeOwner!: Awaited<ReturnType<typeof createLocalRuntimeOwner>>;
  const owner = await createLocalRuntimeConnection({
    directory: join(scripted.config.paths.runtimeDir, "local-host"),
    identity: resolveLocalRuntimeIdentity(scripted.config),
    createOwner: async () => {
      runtimeOwner = await createLocalRuntimeOwner(scripted.config, {
        models: model,
        tools: registry,
      });
      return runtimeOwner;
    },
  });
  const clients: ReturnType<typeof createLocalRuntimeApplication>[] = [];
  const fixture = {
    model,
    execute,
    async client() {
      const client = createLocalRuntimeApplication(scripted.config);
      clients.push(client);
      await client.start();
      expect(client.getOwnership()).toBe("client");
      return client;
    },
    async dispose() {
      try {
        await Promise.all(clients.map((client) => client.stop()));
      } finally {
        await owner.close();
        // Transport shutdown retires active work asynchronously; keep its files
        // until cancellation, request persistence, and accepted RPCs have drained.
        await runtimeOwner.whenIdle!();
        await scripted.dispose();
      }
    },
  };
  fixtures.push(fixture);
  return fixture;
}

const cases = (["execution-agent-v1", "supervisor-worker-v1"] as const).flatMap(
  (policy) =>
    (["approve", "decline", "cancel"] as const).map((decision) => ({
      policy,
      decision,
    })),
);

test.each(cases)(
  "$policy reattaches the same owner request for a late $decision without replay",
  async ({ policy, decision }) => {
    const fixture = await createApprovalFixture(policy);
    const origin = await fixture.client();
    const originView = createApprovalView();
    const originEvents: Record<string, unknown>[] = [];
    const requestId = "approval-resume-request";
    const sessionId = "session";
    const originalRun = origin.requests.handle(
      eventSocket(originEvents),
      {
        type: "run_request",
        requestId,
        sessionId,
        text: "Perform the single fixture action after approval.",
        toolPermissionMode: "ask",
        agentMode: "reasoning",
        modelPreference: { profileId: "scheduled-model", scope: "all" },
      },
      { toolApprovalController: originView.controller },
    );
    const originalSettlement = originalRun.catch((error: unknown) => error);
    await vi.waitFor(() => expect(originView.requests).toHaveLength(1));
    const approval = originView.requests[0]!;
    const modelCallsBeforeDecision = fixture.model.invoke.mock.calls.length;
    expect(fixture.execute).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(
        originEvents.filter((event) => event.name === "tool.approval.required"),
      ).toHaveLength(1),
    );

    await origin.stop();
    await originalSettlement;
    let replacement = await fixture.client();
    expect(await replacement.approvals.list(sessionId)).toEqual([
      { sessionId, request: approval },
    ]);
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.model.invoke).toHaveBeenCalledTimes(
      modelCallsBeforeDecision,
    );

    const replacementView = createApprovalView();
    const replacementEvents: Record<string, unknown>[] = [];
    const accepted = createSchedulerTestGate();
    let attached = replacement.approvals.attach(
      requestId,
      sessionId,
      eventSocket(replacementEvents),
      { toolApprovalController: replacementView.controller },
      accepted.open,
    );
    void attached.catch(() => undefined);
    await accepted.waiting;
    await vi.waitFor(() =>
      expect(replacementView.requests).toEqual([approval]),
    );
    expect(fixture.model.invoke).toHaveBeenCalledTimes(
      modelCallsBeforeDecision,
    );
    expect(fixture.execute).not.toHaveBeenCalled();

    const detachedAttachment = attached.catch((error: unknown) => error);
    await replacement.stop();
    await detachedAttachment;
    replacement = await fixture.client();
    expect(await replacement.approvals.list(sessionId)).toEqual([
      { sessionId, request: approval },
    ]);
    const reaccepted = createSchedulerTestGate();
    attached = replacement.approvals.attach(
      requestId,
      sessionId,
      eventSocket(replacementEvents),
      { toolApprovalController: replacementView.controller },
      reaccepted.open,
    );
    void attached.catch(() => undefined);
    await reaccepted.waiting;
    await vi.waitFor(() =>
      expect(replacementView.requests).toEqual([approval, approval]),
    );
    expect(fixture.model.invoke).toHaveBeenCalledTimes(
      modelCallsBeforeDecision,
    );
    expect(fixture.execute).not.toHaveBeenCalled();

    const identity = { sessionId, requestId, approvalId: approval.approvalId };
    if (decision === "cancel") {
      expect(await replacement.requests.cancel!(requestId, sessionId)).toEqual({
        accepted: true,
      });
    } else {
      expect(
        await replacement.approvals.decide({
          ...identity,
          approved: decision === "approve",
          reason: "Explicit late user decision.",
        }),
      ).toEqual({ accepted: true });
    }
    await attached;

    expect(fixture.execute).toHaveBeenCalledTimes(
      decision === "approve" ? 1 : 0,
    );
    expect(await replacement.approvals.list(sessionId)).toEqual([]);
    expect(
      await replacement.approvals.decide({ ...identity, approved: true }),
    ).toMatchObject({ accepted: false });
    expect(
      replacementEvents.filter((event) => event.name === "tool.started"),
    ).toHaveLength(decision === "approve" ? 1 : 0);
    expect(
      replacementEvents.filter(
        (event) => event.name === "tool.approval.required",
      ),
    ).toHaveLength(0);
    expect(
      originEvents.some(
        (event) => event.type === "completed" || event.type === "failed",
      ),
    ).toBe(false);
    const terminal = replacementEvents.filter(
      (event) => event.type === "completed" || event.type === "failed",
    );
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({
      requestId,
      type: decision === "cancel" ? "failed" : "completed",
    });
    if (decision === "cancel") {
      expect(terminal[0]).toMatchObject({ error: "request_cancelled" });
      expect(fixture.model.invoke).toHaveBeenCalledTimes(
        modelCallsBeforeDecision,
      );
    }
    const session =
      await replacement.services.sessions.getSessionById(sessionId);
    expect(
      session?.messages.filter(
        (message) => message.requestId === requestId && message.role === "user",
      ),
    ).toHaveLength(1);
    expect(
      session?.messages.filter(
        (message) =>
          message.requestId === requestId && message.role === "assistant",
      ),
    ).toHaveLength(1);
    expect(fixture.model.invokeRaw).not.toHaveBeenCalled();
  },
  10_000,
);
