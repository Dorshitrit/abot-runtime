import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only feature has no declaration surface.
import { createPassiveLearningFeature } from "../../web-ui/app/passive-learning-feature.js";
// @ts-expect-error Browser-only feature has no declaration surface.
import { createDashboardFeature } from "../../web-ui/app/dashboard-feature.js";
// @ts-expect-error Browser-only controller has no declaration surface.
import { createSessionController } from "../../web-ui/app/controllers/session-controller.js";
// @ts-expect-error Browser-only projection has no declaration surface.
import { visibleProposalSnapshot } from "../../web-ui/app/components/passive-learning/proposal-read-state.js";
import { createClientPreferences } from "../../web-ui/app/services/client-preferences.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";
import { SidebarElement, sidebarStorage } from "./support/session-sidebar-dom.js";

const dashboard = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("../../web-ui/app/components/dashboard/workspace.js", () => ({
  createDashboardWorkspace: () => ({ render: dashboard.render, composerHost: {} }),
}));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

const proposal = { id: "proposal-one", sessionId: "co-worker-one", status: "delivered",
  title: "A useful suggestion", message: "A proposed next step.", createdAt: "2026-09-27T10:07:39Z" };
function status() {
  return { preferences: { enabled: true, processingPaused: false, modelProfileId: "local", proactiveEnabled: true,
    excludedApplications: [], analysisIntervalMinutes: 15, maxConcurrentBatches: 1 },
    state: "collecting", pendingObservations: 0, processing: false, activeBatches: 0, recentMemories: [],
    proactive: { state: "waiting", proposals: [structuredClone(proposal)] } };
}
function root() {
  const document = {} as ConstructorParameters<typeof FakeElement>[1];
  document.createElement = (tag) => new FakeElement(tag, document);
  document.documentElement = document.createElement("html"); document.body = document.createElement("body");
  return document.createElement("section");
}
type Session = { id: string; [key: string]: unknown };
async function fixture(options: { session?: Session; archived?: boolean; workspace?: string } = {}) {
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener: vi.fn(),
    createElement: (tag: string) => new SidebarElement(tag) });
  const homeRoot = root(); const learningRoot = root();
  const openSession = vi.fn(async () => {});
  const currentStatus = status();
  const preferences = createClientPreferences(sidebarStorage());
  if (options.archived) preferences.saveSessionSidebar("dev", { archivedSessionIds: [proposal.sessionId], orderedSessionIds: [] });
  const state = { sessions: [options.session ?? { id: proposal.sessionId, unreadCount: 1, hasUnread: true }] as Session[],
    pinnedSessionIds: [], busySessionIds: new Set(), currentSessionId: "", sessionQuery: "" };
  const client = { loadPassiveLearning: vi.fn(async () => ({ ok: true, status: currentStatus })),
    listPassiveLearningBatches: vi.fn(async () => ({ items: [] })),
    listModels: vi.fn(async () => ({ profiles: [] })),
    getSystemHostConnection: vi.fn(async () => ({ readiness: { ready: true } })),
    supportsSchedules: () => false, supportsToolApprovals: () => false };
  const feature = createPassiveLearningFeature({ client, getEnvironmentId: () => "dev", learningRoot,
    openLearning: vi.fn(), openComputerAccess: vi.fn(), showActivityMemories: vi.fn(), openSession });
  feature.mountHome(homeRoot);
  const homeDashboard = createDashboardFeature({ state, preferences, client, passiveLearning: feature,
    dom: { homeDashboardRoot: {} }, shell: {}, schedules: {}, selectedEnvironmentId: () => "dev",
    loadSessions: vi.fn(), openSession, isComposerAvailable: () => true });
  const sessions = createSessionController({ state, preferences, selectedEnvironmentId: () => "dev",
    dom: { sessionsList: new SidebarElement("div"), sessionsCount: new SidebarElement("span") },
    sessionActionsMenu: { reset: vi.fn() }, shell: {}, confirmAction: vi.fn(), copyText: vi.fn(),
    onSidebarChange: () => { sessions.render(); homeDashboard.publish(); } });
  homeDashboard.sessionsChanged({ status: "ready", environmentId: "dev" });
  feature.setWorkspace(options.workspace ?? "home");
  await vi.waitFor(() => expect(feature.snapshot().status).not.toBeNull());
  const expectVisibleProposal = (id = proposal.id) => {
    for (const view of [homeRoot, learningRoot]) {
      expect(view.querySelector("[data-learning-proposal-open]")?.dataset.learningProposalOpen).toBe(id);
      expect(view.querySelector("[data-coworker-agent]")?.dataset.agentMode).toBe("suggestion");
    }
  };
  const expectNoProposal = () => {
    for (const view of [homeRoot, learningRoot]) {
      expect(view.querySelector("[data-learning-proposal-open]")).toBeNull();
      expect(view.querySelector("[data-coworker-agent]")?.dataset.agentMode).not.toBe("suggestion");
    }
  };
  const confirmRead = () => sessions.applyReadState(proposal.sessionId, { sessionId: proposal.sessionId,
    lastReadMessageId: `initiative:${proposal.id}`, lastReadAt: 1000, unreadCount: 0, hasUnread: false });
  return { feature, state, homeDashboard, sessions, currentStatus, homeRoot, learningRoot, openSession,
    expectVisibleProposal, expectNoProposal, confirmRead, client };
}

describe("Home and Co-worker invitations follow the confirmed conversation read cursor", () => {
  test.each(["home", "learning"])("publishes a confirmed read while on %s without changing proposal history", async (workspace) => {
    const f = await fixture({ workspace }); const history = structuredClone(f.feature.snapshot().status.proactive.proposals);
    f.expectVisibleProposal();
    expect(f.confirmRead()).toBe(true);
    f.expectNoProposal();
    expect(f.feature.snapshot().status.proactive.proposals).toEqual(history);
    expect(f.currentStatus.proactive.proposals).toEqual(history);
  });

  test("keeps an invitation after an unconfirmed open and after an open failure", async () => {
    const f = await fixture();
    await f.feature.openProposal(proposal.id);
    expect(f.openSession).toHaveBeenCalledWith(proposal.sessionId);
    f.expectVisibleProposal();
    f.openSession.mockRejectedValueOnce(new Error("Conversation unavailable"));
    await f.feature.openProposal(proposal.id);
    f.expectVisibleProposal();
    expect(f.feature.snapshot().proposalError).toBe("Conversation unavailable");
  });

  test.each(["flat", "nested"])("restores a durable %s read cursor after a refreshed status", async (shape) => {
    const read = { lastReadMessageId: `initiative:${proposal.id}`, lastReadAt: 1000, unreadCount: 0, hasUnread: false };
    const f = await fixture({ session: { id: proposal.sessionId, ...(shape === "flat" ? read : { readState: read }) } });
    f.expectNoProposal();
    await f.feature.refresh();
    expect(f.client.loadPassiveLearning).toHaveBeenCalledTimes(2);
    f.expectNoProposal();
    expect(f.feature.snapshot().status.proactive.proposals).toHaveLength(1);
  });

  test("a later unread follow-up cannot resurrect the already read opening proposal", async () => {
    const f = await fixture(); f.confirmRead();
    f.sessions.applyReadState(proposal.sessionId, { sessionId: proposal.sessionId,
      lastReadMessageId: `initiative:${proposal.id}`, lastReadAt: 1000,
      latestAssistantMessageId: "later-assistant", unreadCount: 1, hasUnread: true });
    expect(f.state.sessions[0]!.hasUnread).toBe(true);
    f.expectNoProposal();
  });

  test("keeps read archived proposals hidden although Recent Conversations excludes their sessions", async () => {
    const f = await fixture({ archived: true });
    expect(dashboard.render).toHaveBeenLastCalledWith(expect.objectContaining({ sessions: [] }));
    f.expectVisibleProposal();
    f.confirmRead();
    f.expectNoProposal();
    expect(dashboard.render).toHaveBeenLastCalledWith(expect.objectContaining({ sessions: [] }));
    expect(f.state.sessions).toHaveLength(1);
  });

  test("unavailable read status does not hide a proposal even when it retains an old cursor", async () => {
    const f = await fixture({ session: { id: proposal.sessionId, readStateStatus: "unavailable",
      lastReadMessageId: `initiative:${proposal.id}`, unreadCount: 0 } });
    f.expectVisibleProposal();
  });

  test("ignores another environment's read cursor and leaves newly delivered invitations visible", async () => {
    const f = await fixture();
    const snapshot = f.feature.snapshot();
    const foreign = { environmentId: "prod", sessions: [{ id: proposal.sessionId, lastReadMessageId: `initiative:${proposal.id}` }] };
    expect(visibleProposalSnapshot(snapshot, foreign)).toBe(snapshot);
    f.feature.updateSessions(foreign);
    f.expectVisibleProposal();
    f.confirmRead();
    f.currentStatus.proactive.proposals.push({ ...proposal, id: "proposal-two", sessionId: "co-worker-two" });
    await f.feature.refresh();
    f.expectVisibleProposal("proposal-two");
    expect(f.feature.snapshot().status.proactive.proposals).toHaveLength(2);
  });
});
