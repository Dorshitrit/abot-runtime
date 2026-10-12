import { afterEach, expect, test, vi } from "vitest";
// @ts-expect-error Browser module.
import { createDashboardFeature } from "../../web-ui/app/dashboard-feature.js";
// @ts-expect-error Browser module.
import { createSchedulesFeature } from "../../web-ui/app/schedules-feature.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";
import { projectSessionSnapshot } from "../../sessions/snapshot.js";
import type { SessionRecord } from "../../sessions/types.js";

type Actions = { openConversation(sessionId: string, requestId: string): Promise<void> };
const views = vi.hoisted(() => ({} as Record<string, Actions>));
vi.mock("../../web-ui/app/components/dashboard/workspace.js", () => ({
  createDashboardWorkspace: ({ actions }: { actions: Actions }) => { views.dashboard = actions; return { render: vi.fn() }; },
}));
vi.mock("../../web-ui/app/components/schedules/workspace.js", () => ({
  createSchedulesWorkspace: ({ actions }: { actions: Actions }) => { views.schedules = actions; return { render: vi.fn() }; },
}));
afterEach(() => vi.unstubAllGlobals());

test.each(["dashboard", "schedules"])("%s links load and scroll to a run outside the latest page", async (surface) => {
  vi.stubGlobal("document", { addEventListener: vi.fn() });
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => callback());
  const f = createPlanLifecycleHarness();
  const record: SessionRecord = {
    id: "session-1", title: "History", createdAt: new Date(0).toISOString(), updatedAt: new Date(9).toISOString(), messageCount: 9, lastAgentMode: "reasoning",
    messages: Array.from({ length: 9 }, (_, i) => ({ id: `msg-${i + 1}`, role: "assistant", content: `answer ${i + 1}`, requestId: `req-${i + 1}`, createdAt: new Date(i + 1).toISOString() })),
  };
  f.client.loadSession.mockImplementation(async (...args: unknown[]) => projectSessionSnapshot(record, { page: { limit: 2, ...(args[2] as object) } }));
  const scrollIntoView = vi.fn();
  const dom = {
    homeDashboardRoot: {}, schedulesRoot: {}, modelSelect: { value: "model" },
    environmentSelect: { addEventListener: vi.fn() }, schedulesWorkspaceButton: { dataset: {} },
    messagesList: { querySelectorAll: () => f.state.messages.map((message) => ({ dataset: { requestId: message.requestId }, scrollIntoView })) },
  };
  const client = { supportsSchedules: () => true, supportsToolApprovals: () => false };
  const shared = { dom, client, state: f.state, shell: { prepareWorkspaceActivation: () => () => true, showToast: vi.fn() }, selectedEnvironmentId: () => "dev", openSession: f.conversationSession.openSession };
  createSchedulesFeature({ ...shared, getCurrentSessionId: () => f.state.currentSessionId, getAgentModes: () => [] });
  createDashboardFeature({ ...shared, state: f.state, loadSessions: vi.fn(), isComposerAvailable: () => true });
  await views[surface]!.openConversation("session-1", "req-2");
  expect(f.client.loadSession).toHaveBeenCalledExactlyOnceWith("session-1", "dev", { targetRequestId: "req-2", waitingRequestId: undefined });
  expect(f.state.messages.map((message) => message.requestId)).toEqual(["req-2", "req-3"]);
  expect(scrollIntoView).toHaveBeenCalledOnce();
  expect(f.conversationSession.history.hasNewer()).toBe(true);
});
