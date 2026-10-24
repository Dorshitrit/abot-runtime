import { expect, test, vi } from "vitest";
import { createComposerDrafts } from "../app/controllers/composer-drafts.js";
import { createComposerSubmissionLifecycle } from "../app/controllers/composer-submission-lifecycle.js";
import { createComposerQueueController } from "../app/controllers/composer-queue-controller.js";
import { createSessionComposerQueue } from "../app/lib/session-composer-queue.js";

test.each(["cancel", "scope", "draft", "release", "approve"] as const)(
  "queued message takeover waits and rechecks %s", async (change) => {
    const scope = { environmentId: "dev", sessionId: "chat" };
    let current = true;
    let approve!: (value: boolean) => void;
    const confirmation = new Promise<boolean>((resolve) => { approve = resolve; });
    const confirmTakeover = vi.fn(() => confirmation);
    const drafts = createComposerDrafts();
    const draft = drafts.open(scope);
    const settings = { agentMode: "fast", toolPermissionMode: "ask", modelPreference: null };
    const release = { releaseToken: "original", item: { text: "Queued text", attachments: [], waitForRequestId: "request", ...settings } };
    let blocked = release;
    const claim = vi.fn((_scope, _token, options?: { takeover?: boolean }) => options?.takeover ? release : null);
    const queue = { ...createSessionComposerQueue({ storage: { getItem: () => null, setItem: () => {} } }), getBlockedRelease: () => blocked, claimBlockedRelease: claim };
    const reportRecovery = vi.fn();
    const controller = createComposerQueueController({
      queue, drafts, lifecycle: createComposerSubmissionLifecycle({ drafts }), getDraft: () => draft,
      requests: { send: vi.fn(async () => "request"), prepareView: vi.fn(), activate: vi.fn() },
      getSettings: () => settings, isCurrentScope: () => current,
      reportFailure: vi.fn(), reportRecovery, confirmTakeover,
    });
    const recovering = controller.recoverForManualSend(scope);
    await vi.waitFor(() => expect(confirmTakeover).toHaveBeenCalledOnce());
    expect(claim).toHaveBeenCalledTimes(1);
    expect(draft.isEmpty()).toBe(true);
    if (change === "scope") current = false;
    if (change === "draft") draft.text = "New unsent input";
    if (change === "release") blocked = { ...release, releaseToken: "replacement" };
    approve(change !== "cancel");
    expect(await recovering).toBe(change === "approve");
    expect(claim).toHaveBeenCalledTimes(change === "approve" ? 2 : 1);
    expect(draft.text).toBe(change === "approve" ? "Queued text" : change === "draft" ? "New unsent input" : "");
    expect(reportRecovery).toHaveBeenCalledTimes(change === "approve" ? 1 : 0);
  },
);
