import { afterEach, expect, test, vi } from "vitest";
import type { ToolModuleDeclaration } from "../../capabilities/tool-types.js";
import { successResult } from "../../plugin-sdk/index.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { createLocalRuntimeOwner } from "../local-host/app-owner.js";
import type { LocalPendingToolApproval } from "../local-host/request-approval-contracts.js";
import { createExecApprovalScript } from "./support/exec-sensitive-approval-script.js";
import {
  createSchedulerRuntimeFixture,
  createSchedulerTestGate,
} from "./support/scheduler-runtime-fixture.js";
import { makeOwnerControlPeer } from "./support/local-runtime-owner-peer.js";
import { resetDebugLoggerConfig } from "../observability/debug-logger.js";
import * as preflight from "../request/approval-wait/preflight.js";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { createLocalRuntimeConnection } from "../local-host/transport.js";
import { resolveLocalRuntimeIdentity } from "../local-host/client-identity.js";
import { createLocalRuntimeApplication } from "../local-application.js";
import type WebSocket from "ws";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release();
  resetDebugLoggerConfig();
});

async function fixture(policy: "execution-agent-v1" | "supervisor-worker-v1") {
  const base = await createSchedulerRuntimeFixture(policy);
  await base.application.stop();
  cleanup.push(() => base.dispose());
  const model = createExecApprovalScript(
    policy,
    [{ capabilityId: "record_approval_effect", controls: {} }],
    "approval_fixture",
  );
  const execute = vi.fn(async () =>
    successResult({ output: "The approved effect completed." }),
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
  const peer = makeOwnerControlPeer("saved-view");
  const start = async () => {
    const owner = await createLocalRuntimeOwner(base.config, {
      models: model,
      tools: createConfiguredToolRegistry(base.config, [module]),
    });
    cleanup.push(async () => {
      await owner.stop();
      await owner.whenIdle?.();
    });
    return owner;
  };
  const owner = await start();
  return {
    base,
    model,
    execute,
    peer: peer.peer,
    calls: peer.callClient,
    owner,
    start,
  };
}

test("managed client releases the request RPC and receives the resumed activation through owner events", async () => {
  const f = await fixture("execution-agent-v1");
  const connection = await createLocalRuntimeConnection({
    directory: join(f.base.config.paths.runtimeDir, "local-host"),
    identity: resolveLocalRuntimeIdentity(f.base.config),
    createOwner: async () => f.owner,
  });
  cleanup.push(() => connection.close());
  const client = createLocalRuntimeApplication(f.base.config);
  cleanup.push(() => client.stop());
  const events: Record<string, unknown>[] = [];
  client.subscribeScheduledEvents((event) => events.push(event));
  const outcome = await client.requests.handle(
    {
      send: (data: string) => {
        events.push(JSON.parse(data));
      },
    } as unknown as WebSocket,
    {
      type: "run_request",
      requestId: "managed-saved",
      sessionId: "session",
      text: "Perform the exact fixture effect.",
      toolPermissionMode: "ask",
      agentMode: "reasoning",
      modelPreference: { profileId: "scheduled-model", scope: "all" },
    },
    {
      durableApprovals: true,
      toolApprovalController: {
        async requestToolApproval() {
          throw new Error("saved_wait_must_not_hold_a_callback");
        },
      },
    },
  );
  expect(outcome).toMatchObject({ kind: "awaiting_approval" });
  expect(f.owner.isIdle?.()).toBe(true);
  const saved = (await f.owner.call(
    "sessions.getSessionById",
    ["session"],
    f.peer,
  )) as import("../../sessions/types.js").SessionRecord;
  const presentation = saved.messages.find(
    (message) => message.kind === "tool_approval_request",
  );
  expect(presentation?.content).toContain("Perform the exact fixture action.");
  expect(presentation?.content).not.toContain("Tool approval required.");
  const approvalIdentity = {
    executionId: expect.any(String),
    executorRole: "supervisor",
    roleCallId: expect.any(String),
  };
  expect(presentation?.approvalRequest?.approvals[0]?.presentation).toMatchObject(approvalIdentity);
  expect(events.find((event) => event.name === "tool.approval.required")).toMatchObject(approvalIdentity);
  expect(
    events.find(
      (event) => event.name === "request.lifecycle.changed" && event.message,
    ),
  ).toMatchObject({
    message: { text: presentation!.content, kind: "tool_approval_request" },
  });
  const [approval] = await client.approvals.list("session");
  expect(
    await client.approvals.decide({
      requestId: "managed-saved",
      sessionId: "session",
      approvalId: approval!.request.approvalId,
      ...approval!.wait!,
      commandId: "managed-decision",
      approved: true,
    }),
  ).toEqual({ accepted: true });
  await f.owner.whenIdle?.();
  await vi.waitFor(() =>
    expect(events.some((event) => event.type === "completed")).toBe(true),
  );
  expect(f.execute).toHaveBeenCalledOnce();
  expect(
    events.filter((event) => event.name === "tool.approval.granted"),
  ).toHaveLength(1);
}, 20000);

async function parkFixtureRequest(f: Awaited<ReturnType<typeof fixture>>) {
  await f.owner.call(
    "request.run",
    [
      {
        type: "run_request",
        requestId: "saved-request",
        sessionId: "session",
        text: "Perform the fixture action.",
        toolPermissionMode: "ask",
        agentMode: "reasoning",
        modelPreference: { profileId: "scheduled-model", scope: "all" },
      },
      { durableApprovals: true, approvalAvailable: true },
    ],
    f.peer,
  );
  const [pending] = (await f.owner.call(
    "request.approvals",
    ["session"],
    f.peer,
  )) as LocalPendingToolApproval[];
  return {
    sessionId: "session",
    requestId: "saved-request",
    approvalId: pending!.request.approvalId,
    ...pending!.wait!,
    commandId: "exact-decision",
    approved: true,
  };
}

test("concurrent decisions resume once and Stop from the consumed wait cancels only that activation", async () => {
  const f = await fixture("execution-agent-v1");
  const command = await parkFixtureRequest(f);
  const effect = createSchedulerTestGate();
  f.execute.mockImplementationOnce(async () => {
    await effect.waiting;
    return successResult({ output: "The approved effect completed." });
  });
  try {
    const receipts = await Promise.all([
      f.owner.call("request.approval.decide", [command], f.peer),
      f.owner.call("request.approval.decide", [command], f.peer),
    ]);
    expect(receipts).toEqual(
      expect.arrayContaining([
        { accepted: true },
        { accepted: true, duplicate: true },
      ]),
    );
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
    const cancel = {
      generation: command.generation,
      waitId: command.waitId,
      revision: command.revision,
      commandId: "cancel-resumed",
    };
    for (const mismatch of [
      { generation: "previous-generation" },
      { waitId: "previous-wait" },
      { revision: command.revision - 1 },
    ]) {
      expect(
        await f.owner.call(
          "request.cancel",
          [command.requestId, command.sessionId, { ...cancel, ...mismatch }],
          f.peer,
        ),
      ).toEqual({ accepted: false, reason: "request_not_active" });
    }
    expect(
      await f.owner.call(
        "request.cancel",
        [command.requestId, command.sessionId, cancel],
        f.peer,
      ),
    ).toEqual({ accepted: true });
  } finally {
    effect.open();
  }
  await f.owner.whenIdle?.();
  expect(f.execute).toHaveBeenCalledOnce();
  const session = (await f.owner.call(
    "sessions.getSessionById",
    ["session"],
    f.peer,
  )) as import("../../sessions/types.js").SessionRecord;
  expect(
    session.requests?.find((request) => request.requestId === command.requestId)
      ?.status,
  ).toBe("failed");
  expect(
    session.requests?.find((request) => request.requestId === command.requestId)
      ?.lifecycle?.terminalCause,
  ).toBe("request_cancelled");
});

test.each(["corrupt", "future"] as const)(
  "an unreadable %s continuation stays visible and can be cancelled without loading it",
  async (kind) => {
    const f = await fixture("execution-agent-v1");
    const command = await parkFixtureRequest(f);
    const sessionFile = join(f.base.config.paths.sessionsDir, "session.json");
    const stored = JSON.parse(await readFile(sessionFile, "utf8"));
    const reference = stored.requests.find(
      (request: any) => request.requestId === command.requestId,
    ).lifecycle.wait.continuation;
    if (kind === "corrupt") {
      await writeFile(
        join(
          f.base.config.paths.sessionsDir,
          ".request-continuations",
          "session",
          reference.blob.sha256 + ".blob",
        ),
        "corrupt",
      );
    } else {
      reference.version = 999;
      await writeFile(sessionFile, JSON.stringify(stored));
    }
    expect(
      await f.owner.call("request.approval.decide", [command], f.peer),
    ).toEqual({ accepted: false, reason: "approval_resume_unavailable" });
    expect(
      await f.owner.call("request.approvals", ["session"], f.peer),
    ).toHaveLength(1);
    expect(f.execute).not.toHaveBeenCalled();
    const cancellation = {
      generation: command.generation,
      waitId: command.waitId,
      revision: command.revision,
      commandId: "explicit-cancel",
    };
    expect(
      await f.owner.call(
        "request.cancel",
        [command.requestId, command.sessionId, cancellation],
        f.peer,
      ),
    ).toEqual({ accepted: true });
    expect(
      await f.owner.call(
        "request.cancel",
        [command.requestId, command.sessionId, cancellation],
        f.peer,
      ),
    ).toEqual({ accepted: true });
    expect(
      await f.owner.call("request.approvals", ["session"], f.peer),
    ).toEqual([]);
  },
);

for (const policy of ["execution-agent-v1", "supervisor-worker-v1"] as const) {
  test.each(["approve", "decline", "cancel"] as const)(
    policy + " retires before restart and handles %s once",
    async (choice) => {
      const f = await fixture(policy);
      const outcome = await f.owner.call(
        "request.run",
        [
          {
            type: "run_request",
            requestId: "saved-request",
            sessionId: "session",
            text: "Perform the fixture action.",
            toolPermissionMode: "ask",
            agentMode: "reasoning",
            modelPreference: { profileId: "scheduled-model", scope: "all" },
          },
          { durableApprovals: true, approvalAvailable: true },
        ],
        f.peer,
      );
      expect(outcome).toMatchObject({ kind: "awaiting_approval" });
      expect(f.execute).not.toHaveBeenCalled();
      expect(
        f.calls.mock.calls.filter(([method]) => method === "request.approval"),
      ).toHaveLength(0);
      expect(f.owner.isIdle?.()).toBe(true);
      const pending = (await f.owner.call(
        "request.approvals",
        ["session"],
        f.peer,
      )) as LocalPendingToolApproval[];
      expect(pending).toHaveLength(1);
      const before = f.model.invoke.mock.calls.length;
      await f.owner.stop();
      await f.owner.whenIdle?.();
      const next = await f.start();
      const events: Record<string, unknown>[] = [];
      next.subscribe((event) => events.push(event as Record<string, unknown>));
      expect(await next.call("request.approvals", ["session"], f.peer)).toEqual(
        pending,
      );
      expect(f.model.invoke).toHaveBeenCalledTimes(before);
      expect(f.execute).not.toHaveBeenCalled();
      await next.call("request.attach", ["saved-request", "session"], f.peer);
      expect(next.isIdle?.()).toBe(true);
      const approval = pending[0]!;
      if (choice === "cancel") {
        expect(
          await next.call(
            "request.cancel",
            [
              "saved-request",
              "session",
              { ...approval.wait!, commandId: "cancel-wait" },
            ],
            f.peer,
          ),
        ).toEqual({ accepted: true });
      } else {
        const command = {
          sessionId: "session",
          requestId: "saved-request",
          approvalId: approval.request.approvalId,
          ...approval.wait!,
          commandId: "user-decision",
          approved: choice === "approve",
        };
        const validation = vi.spyOn(preflight, "validateApprovalResume");
        const receipt = await next.call(
          "request.approval.decide",
          [command],
          f.peer,
        );
        await validation.mock.results.at(-1)?.value;
        validation.mockRestore();
        expect(receipt).toEqual({ accepted: true });
        expect(
          await next.call("request.approval.decide", [command], f.peer),
        ).toEqual({ accepted: true, duplicate: true });
        await next.whenIdle?.();
      }
      expect(f.execute).toHaveBeenCalledTimes(choice === "approve" ? 1 : 0);
      expect(await next.call("request.approvals", ["session"], f.peer)).toEqual(
        [],
      );
      const session = (await next.call(
        "sessions.getSessionById",
        ["session"],
        f.peer,
      )) as import("../../sessions/types.js").SessionRecord;
      const request = session.requests!.find(
        (item) => item.requestId === "saved-request",
      )!;
      expect(request.status).toBe(choice === "cancel" ? "failed" : "completed");
      const messages = session.messages.filter(
        (item) => item.requestId === "saved-request",
      );
      expect(messages.filter((item) => item.role === "user")).toHaveLength(1);
      expect(
        messages.filter((item) => item.kind === "tool_approval_request"),
      ).toHaveLength(1);
      expect(messages.filter((item) => item.kind === "terminal")).toHaveLength(
        1,
      );
      const required = request.events.filter(
        (event) => event.payload.name === "tool.approval.required",
      );
      expect(required).toHaveLength(1);
      expect(
        request.events.some(
          (event) => event.payload.name === "tool.approval.rejected",
        ),
      ).toBe(choice === "decline");
    },
    20_000,
  );
}
