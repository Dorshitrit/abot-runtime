import type { ServerResponse } from "node:http";
import { afterEach, expect, test, vi } from "vitest";
import { resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { LocalRuntimeControlRoutes } from "../../web-ui/local-runtime/control-routes.js";
import { createWebSavedApprovalSteeringFixture } from "./support/web-saved-approval-steering-fixture.js";
// @ts-expect-error Browser-only controller.
import { createSessionActivityController } from "../../web-ui/app/controllers/session-activity-controller.js";
// @ts-expect-error Browser transport composition module.
import { createAppRealtimeTransport } from "../../web-ui/app/app-realtime-transport.js";

type BrowserTransport = {
  onMessage: (message: unknown) => void;
  onOpen: () => void;
  onClose: () => void;
};
const capture = vi.hoisted(() => ({ transports: [] as BrowserTransport[] }));
vi.mock("../../web-ui/app/services/realtime-transport.js", () => ({
  createRealtimeTransport: (options: BrowserTransport) => {
    capture.transports.push(options);
    return { send: vi.fn(), connect: vi.fn() };
  },
}));

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release();
  capture.transports.length = 0;
  resetDebugLoggerConfig();
});

function captureResponse() {
  const bodies: Record<string, unknown>[] = [];
  const response = { writeHead: vi.fn(), end: (raw: string) => bodies.push(JSON.parse(raw)) } as unknown as ServerResponse;
  return { response, bodies };
}

function readHealth(routes: LocalRuntimeControlRoutes) {
  const { response, bodies } = captureResponse();
  routes.health(response);
  return bodies[0]!;
}

function browser(routes: LocalRuntimeControlRoutes, environmentId: string) {
  const state = { connected: true, currentSessionId: "other-session", activeRequestId: "" };
  const realtime = createAppRealtimeTransport({ state, getConfig: () => ({}), onMessage: vi.fn(),
    setConnectionLabel: vi.fn(), rejectPendingSteers: vi.fn(), recordControlEvent: vi.fn(), onConnected: vi.fn() });
  const activity = createSessionActivityController({
    client: { getSystemHealth: async () => readHealth(routes) }, getEnvironmentId: () => environmentId,
    onChange: vi.fn(), realtime, isConnected: () => state.connected,
  });
  return { activity, state, transport: capture.transports.at(-1)! };
}

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
  "real saved-approval activity survives health refresh, new browser and reconnect without live control projection (%s)",
  async (policy) => {
    const f = await createWebSavedApprovalSteeringFixture(policy, cleanup);
    const routes = new LocalRuntimeControlRoutes(f.requests);
    const current = browser(routes, f.base.config.runtimeId);
    let delivered = 0;
    const deliverPublished = () => {
      for (const event of f.events.slice(delivered)) {
        for (const transport of capture.transports) transport.onMessage(event);
      }
      delivered = f.events.length;
    };
    const started = captureResponse();
    await f.requests.start(started.response, {
      sessionId: "session", text: "Perform the fixture action.", toolPermissionMode: "ask",
      agentMode: "reasoning", modelPreference: { profileId: "scheduled-model", scope: "all" },
    }, f.base.config.runtimeId, f.client);
    const requestId = String(started.bodies[0]!.requestId);
    await vi.waitFor(() => expect(f.events).toContainEqual(expect.objectContaining({
      name: "request.lifecycle.changed", lifecycle: expect.objectContaining({ status: "awaiting_approval" }),
    })), { timeout: 5000 });
    await vi.waitFor(() => expect(readHealth(routes).activeStreamingRequestDetails).toEqual([]));
    deliverPublished();
    await current.activity.refresh();
    expect(current.activity.isWorking("session")).toBe(false);
    expect(f.execute).not.toHaveBeenCalled();

    const [pending] = await f.approvals.list(f.base.config.runtimeId);
    expect(await f.approvals.decide({ ...pending!, commandId: "approve-once", approved: true })).toBe(true);
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(readHealth(routes)).toMatchObject({ activeStreamingRequests: 1,
      activeStreamingRequestDetails: [{ requestId, sessionId: "session", environment: f.base.config.runtimeId }],
    }));
    expect(f.requests.activeReplay(requestId, 0)).toBeUndefined();
    deliverPublished();
    await current.activity.refresh();
    expect(current.activity.isWorking("session")).toBe(true);
    expect(current.state.currentSessionId).toBe("other-session");
    expect(current.state.activeRequestId).toBe("");

    // These browsers receive no historical lifecycle: the actual health route must discover the continuation.
    const newlyOpened = browser(routes, f.base.config.runtimeId);
    await newlyOpened.activity.refresh();
    expect(newlyOpened.activity.isWorking("session")).toBe(true);
    const otherEnvironment = browser(routes, "different-environment");
    await otherEnvironment.activity.refresh();
    expect(otherEnvironment.activity.isWorking("session")).toBe(false);

    current.transport.onClose();
    expect(current.activity.isWorking("session")).toBe(false);
    current.transport.onOpen();
    await vi.waitFor(() => expect(current.activity.isWorking("session")).toBe(true));

    f.effect.open();
    await f.owner.whenIdle?.();
    await vi.waitFor(() => expect(f.events).toContainEqual(expect.objectContaining({ type: "completed", requestId })), { timeout: 5000 });
    deliverPublished();
    await Promise.all([current.activity.refresh(), newlyOpened.activity.refresh()]);
    expect(readHealth(routes)).toMatchObject({ activeStreamingRequests: 0, activeStreamingRequestDetails: [] });
    expect(current.activity.isWorking("session")).toBe(false);
    expect(newlyOpened.activity.isWorking("session")).toBe(false);
    expect(f.requests.activeReplay(requestId, 0)).toBeUndefined();
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.model.invokeRaw).not.toHaveBeenCalled();
  },
  20000,
);
