import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only controller has no declaration surface.
import { createPassiveLearningController } from "../../web-ui/app/controllers/passive-learning-controller.js";
// @ts-expect-error Browser-only notification has no declaration surface.
import { createProposalNotifications } from "../../web-ui/app/components/passive-learning/proposal-notifications.js";
// @ts-expect-error Browser-only component has no declaration surface.
import { createPassiveLearningHome } from "../../web-ui/app/components/passive-learning/home.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  return { promise, resolve, reject };
}
function status() {
  return {
    preferences: { enabled: false, proactiveEnabled: true },
    proactive: {
      state: "waiting",
      proposals: [
        { id: "delivered", sessionId: "saved-session", status: "delivered" },
        { id: "pending", sessionId: "not-delivered", status: "pending" },
      ],
    },
    recentMemories: [],
  };
}
function controllerHarness() {
  let environment = "dev";
  const openSession = vi.fn(async () => {});
  const client = {
    loadPassiveLearning: vi.fn(async () => ({ status: status() })),
    listPassiveLearningCandidates: vi.fn(async (_environment: string) => ({
      items: [{ id: "candidate" }],
    })),
    listPassiveLearningBatches: vi.fn(async () => ({ items: [] })),
    listModels: vi.fn(async () => ({ profiles: [] })),
    dismissPassiveLearningProposal: vi.fn(
      async (_id: string, _environment: string) => ({ ok: true }),
    ),
  };
  const controller = createPassiveLearningController({
    client,
    openSession,
    getEnvironmentId: () => environment,
    render: vi.fn(),
    isVisible: () => true,
  });
  return {
    client,
    controller,
    openSession,
    setEnvironment: (value: string) => {
      environment = value;
      controller.environmentChanged();
    },
  };
}
function notificationHarness() {
  const doc = {} as ConstructorParameters<typeof FakeElement>[1];
  doc.createElement = (tag) => {
    const node = new FakeElement(tag, doc);
    return Object.assign(node, {
      removeEventListener(type: string, listener: (event: unknown) => void) {
        node.listeners.set(
          type,
          (node.listeners.get(type) ?? []).filter((item) => item !== listener),
        );
      },
    });
  };
  doc.documentElement = doc.createElement("html");
  doc.body = doc.createElement("body");
  let environment = "dev";
  const openSession = vi.fn(
    async (_session: string, _environment: string) => true,
  );
  const notices = createProposalNotifications({
    getDocument: () => doc,
    getEnvironmentId: () => environment,
    openSession,
  });
  const event = (id = "proposal", targetEnvironment = "dev") => ({
    type: "learning.changed",
    environmentId: targetEnvironment,
    event: {
      type: "proposal_delivered",
      proposalId: id,
      sessionId: `session-${id}`,
    },
  });
  return {
    doc,
    notices,
    event,
    openSession,
    setEnvironment: (value: string) => {
      environment = value;
      notices.environmentChanged();
    },
  };
}

describe("Co-worker candidates and proposal controls", () => {
  test("loads candidates only for the visible workspace and ignores late results from previous environments", async () => {
    const h = controllerHarness();
    h.controller.setWorkspace("home");
    await vi.waitFor(() =>
      expect(h.controller.snapshot().status).not.toBeNull(),
    );
    expect(h.client.listPassiveLearningCandidates).not.toHaveBeenCalled();
    const old = deferred<{ items: { id: string }[] }>();
    h.client.listPassiveLearningCandidates.mockImplementationOnce(
      () => old.promise,
    );
    h.controller.setWorkspace("learning");
    expect(h.controller.snapshot().loadingCandidates).toBe(true);
    h.setEnvironment("prod");
    await vi.waitFor(() =>
      expect(h.controller.snapshot().candidates).toEqual([{ id: "candidate" }]),
    );
    old.resolve({ items: [{ id: "private-dev-candidate" }] });
    await Promise.resolve();
    expect(h.controller.snapshot()).toMatchObject({
      environmentId: "prod",
      candidates: [{ id: "candidate" }],
      loadingCandidates: false,
    });
    expect(h.client.listPassiveLearningCandidates).toHaveBeenLastCalledWith(
      "prod",
    );
  });

  test("reports candidate read failure without losing saved candidates", async () => {
    const h = controllerHarness();
    h.controller.setWorkspace("learning");
    await vi.waitFor(() =>
      expect(h.controller.snapshot().candidates).toHaveLength(1),
    );
    h.client.listPassiveLearningCandidates.mockRejectedValueOnce(
      new Error("Candidate read failed"),
    );
    await h.controller.refresh();
    expect(h.controller.snapshot()).toMatchObject({
      candidates: [{ id: "candidate" }],
      loadingCandidates: false,
      candidateError: "Candidate read failed",
    });
  });

  test("opens only persisted delivered proposals and dismisses through the exact environment", async () => {
    const h = controllerHarness();
    h.controller.setWorkspace("home");
    await vi.waitFor(() =>
      expect(h.controller.snapshot().status).not.toBeNull(),
    );
    await h.controller.openProposal("pending");
    await h.controller.openProposal("unknown");
    expect(h.openSession).not.toHaveBeenCalled();
    await h.controller.openProposal("delivered");
    expect(h.openSession).toHaveBeenCalledExactlyOnceWith(
      "saved-session",
      "dev",
    );
    await h.controller.dismissProposal("delivered");
    expect(
      h.client.dismissPassiveLearningProposal,
    ).toHaveBeenCalledExactlyOnceWith("delivered", "dev");
    expect(h.controller.snapshot().dismissingProposalId).toBe("");
  });

  test("a late dismissal failure cannot overwrite the selected environment even after switching back", async () => {
    const h = controllerHarness();
    h.controller.setWorkspace("home");
    await vi.waitFor(() =>
      expect(h.controller.snapshot().status).not.toBeNull(),
    );
    const old = deferred<{ ok: boolean }>();
    h.client.dismissPassiveLearningProposal.mockImplementationOnce(
      () => old.promise,
    );
    const pending = h.controller.dismissProposal("delivered");
    h.setEnvironment("prod");
    h.setEnvironment("dev");
    old.reject(new Error("old-environment failure"));
    await pending;
    expect(h.controller.snapshot()).toMatchObject({
      proposalError: "",
      dismissingProposalId: "",
    });
  });
});

describe("live Co-worker proposal notification", () => {
  test("does not announce restored state, foreign environments, invalid events or navigate automatically", async () => {
    const h = notificationHarness();
    h.notices.handleRealtime({
      type: "learning.changed",
      environmentId: "dev",
      status: status(),
    });
    h.notices.handleRealtime(h.event("foreign", "prod"));
    h.notices.handleRealtime({
      ...h.event(),
      event: { ...h.event().event, sessionId: "" },
    });
    expect(h.doc.body.children).toHaveLength(0);
    h.notices.handleRealtime({
      ...h.event(),
      content: "<img src=x onerror=alert(1)>",
    });
    const root = h.doc.body.querySelector(".co-worker-proposal-toast")!;
    expect(root.hidden).toBe(false);
    expect(root.attributes.get("aria-live")).toBe("polite");
    expect(h.doc.body.querySelector("img")).toBeNull();
    expect(h.openSession).not.toHaveBeenCalled();
    root.querySelector("[data-proposal-notice-open]")!.dispatch("click");
    await vi.waitFor(() =>
      expect(h.openSession).toHaveBeenCalledExactlyOnceWith(
        "session-proposal",
        "dev",
      ),
    );
    expect(root.hidden).toBe(true);
    h.notices.handleRealtime(h.event());
    expect(root.hidden).toBe(true);
    expect(h.doc.body.children).toHaveLength(1);
  });

  test("changing environments hides the old notification and opening can be declined by navigation guards", async () => {
    const h = notificationHarness();
    h.notices.handleRealtime(h.event());
    const root = h.doc.body.querySelector(".co-worker-proposal-toast")!;
    h.setEnvironment("prod");
    expect(root.hidden).toBe(true);
    root.querySelector("[data-proposal-notice-open]")!.dispatch("click");
    expect(h.openSession).not.toHaveBeenCalled();
    h.notices.handleRealtime(h.event("new", "prod"));
    h.openSession.mockResolvedValueOnce(false);
    root.querySelector("[data-proposal-notice-open]")!.dispatch("click");
    await vi.waitFor(() => expect(h.openSession).toHaveBeenCalledOnce());
    expect(root.hidden).toBe(false);
    root.querySelector("[data-proposal-notice-close]")!.dispatch("click");
    expect(root.hidden).toBe(true);
  });

  test("deduplication and DOM stay bounded while active identities remain environment scoped", () => {
    const h = notificationHarness();
    for (let i = 0; i < 110; i += 1)
      h.notices.handleRealtime(h.event(`proposal-${i}`));
    const root = h.doc.body.querySelector(".co-worker-proposal-toast")!;
    root.querySelector("[data-proposal-notice-close]")!.dispatch("click");
    h.notices.handleRealtime(h.event("proposal-109"));
    expect(root.hidden).toBe(true);
    h.setEnvironment("prod");
    h.notices.handleRealtime(h.event("proposal-109", "prod"));
    expect(root.hidden).toBe(false);
    expect(h.doc.body.children).toHaveLength(1);
    h.notices.dispose();
    expect(h.doc.body.children).toHaveLength(0);
  });
});

test("Home shows an independently active proactive agent while collection is stopped", () => {
  const h = notificationHarness();
  const root = h.doc.createElement("section");
  const openLearning = vi.fn();
  const configure = vi.fn();
  const openProposal = vi.fn();
  const dismissProposal = vi.fn();
  const snapshot = {
    status: {
      ...status(),
      state: "off",
      processing: false,
      pendingObservations: 0,
      preferences: {
        enabled: false,
        processingPaused: true,
        proactiveEnabled: true,
        modelProfileId: "local",
      },
    },
  };
  const home = createPassiveLearningHome({
    actions: { configure, openProposal, dismissProposal, snapshot: () => snapshot },
    openLearning,
  });
  home.mount(root);
  home.render(snapshot);
  expect(root.querySelector("[data-agent-proactive]")?.textContent).toContain(
    "Enabled",
  );
  expect(root.querySelector("[data-agent-collection]")?.textContent).toContain(
    "stopped",
  );
  root.querySelector("[data-learning-open]")!.dispatch("click");
  expect(openLearning).toHaveBeenCalledOnce();
  expect(configure).not.toHaveBeenCalled();
  expect(root.querySelectorAll("[data-learning-proposal-open]")).toHaveLength(1);
  root.querySelector("[data-learning-proposal-open]")!.dispatch("click");
  expect(openProposal).toHaveBeenCalledWith("delivered");
  root.querySelector("[data-learning-proposal-dismiss]")!.dispatch("click");
  expect(dismissProposal).toHaveBeenCalledWith("delivered");
  expect(configure).not.toHaveBeenCalled();
});
