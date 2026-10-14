import type { ServerResponse } from "node:http";
import { afterEach, expect, test, vi } from "vitest";
import { resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createWebSavedApprovalSteeringFixture } from "./support/web-saved-approval-steering-fixture.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release();
  resetDebugLoggerConfig();
});

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
  "Web STEER reaches a resumed saved ASK request without reviving its retired projection (%s)",
  async (policy) => {
    const f = await createWebSavedApprovalSteeringFixture(policy, cleanup);
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
