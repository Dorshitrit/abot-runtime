import { afterEach, expect, test, vi } from "vitest";
import { createSessionRunSelection } from "../../web-ui/app/controllers/session-run-selection.js";
import { createComposerDrafts, type ComposerScope } from "../../web-ui/app/controllers/composer-drafts.js";
import type { ComposerSubmissionAttempt } from "../../web-ui/app/controllers/composer-submission-lifecycle.js";
import { createComposerSubmissionLifecycle } from "../../web-ui/app/controllers/composer-submission-lifecycle.js";
import { createComposerProductionHarness } from "./support/composer-production-harness.js";
// @ts-expect-error Browser session mutation controller.
import { createSessionController } from "../../web-ui/app/controllers/session-controller.js";
// @ts-expect-error Browser runtime-reset reconciler.
import { reconcileRuntimeSessionReset } from "../../web-ui/app/controllers/runtime-session-reset-view.js";

afterEach(() => vi.unstubAllGlobals());

function choiceFixture() {
  let scope: ComposerScope = { environmentId: "dev", sessionId: "start" };
  let home = false;
  const drafts = createComposerDrafts();
  const hasUnsentDraft = vi.fn(drafts.hasUnsentDraft);
  const owner = createSessionRunSelection({ getScope: () => scope, getComposerScope: () => scope, hasUnsentDraft, isHome: () => home });
  return { owner, drafts, hasUnsentDraft,
    choose(target: ComposerScope, profileId = "chosen") { scope = target; owner.remember({ profileId }); },
    show(target: ComposerScope) { scope = target; }, setHome(value: boolean) { home = value; },
  };
}

test("a thousand empty conversation visits retain only actual parked drafts and uploads", () => {
  const f = choiceFixture();
  const parked = { environmentId: "dev", sessionId: "parked" };
  const uploading = { environmentId: "dev", sessionId: "uploading" };
  f.drafts.open(parked).text = "Keep this draft";
  const upload = f.drafts.open(uploading).startUpload();
  f.choose(parked, "parked-model"); f.choose(uploading, "upload-model");
  for (let index = 0; index < 1000; index += 1) {
    const empty = { environmentId: "dev", sessionId: `empty-${index}` };
    f.choose(empty); f.owner.pruneEmptyDraftSelections();
    expect(f.owner.override()).toBeNull();
  }
  expect(f.hasUnsentDraft.mock.calls.length).toBeLessThanOrEqual(3000);
  f.show(parked); expect(f.owner.selectedProfileId()).toBe("parked-model");
  f.setHome(true); f.owner.pruneEmptyDraftSelections();
  expect(f.owner.override()).toBeNull();
  f.setHome(false); expect(f.owner.selectedProfileId()).toBe("parked-model");
  f.show(uploading); expect(f.owner.selectedProfileId()).toBe("upload-model");
  f.drafts.open(uploading).finishUpload(upload); f.owner.pruneEmptyDraftSelections(uploading);
  expect(f.owner.override()).toBeNull();
  f.show(parked); expect(f.owner.selectedProfileId()).toBe("parked-model");
});

function mutationFixture() {
  const f = choiceFixture();
  const target = { environmentId: "dev", sessionId: "target" };
  const other = { environmentId: "prod", sessionId: "target" };
  f.drafts.open(target).text = "Preserved target text";
  f.drafts.open(other).text = "Other environment text";
  f.choose(target, "target-model"); f.choose(other, "other-model"); f.show(target);
  let resolve!: () => void, reject!: (error: Error) => void;
  const ack = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const client = { clearSessionMessages: vi.fn(() => ack), deleteSession: vi.fn(() => ack) };
  let environment = "dev";
  const controller = createSessionController({
    state: { currentSessionId: "", sessions: [{ id: "target" }], sessionQuery: "", pinnedSessionIds: [], sessionModels: {}, busySessionIds: new Set() },
    preferences: { savePinnedSessions: vi.fn(), sessionIdForEnvironment: () => "", saveSessionIdForEnvironment: vi.fn() },
    client, selectedEnvironmentId: () => environment,
    dom: { sessionsList: { innerHTML: "", scrollTop: 0 }, sessionsCount: { textContent: "" } },
    sessionActionsMenu: { reset: vi.fn() }, renderGroups: () => true, shell: { showToast: vi.fn() },
    confirmAction: () => true, onOpen: vi.fn(), onClearCurrent: vi.fn(), onClearSessionMode: vi.fn(),
    onSaveModelPreferences: vi.fn(), onReload: vi.fn(), onControlEvent: vi.fn(),
    onSessionAttachmentsCleared: (scope: ComposerScope) => {
      f.owner.retireSessionSelection(scope); f.drafts.clearAttachments(scope);
    },
  });
  return { ...f, target, other, controller, client, resolve, reject, switchEnvironment() { environment = "prod"; f.show(other); } };
}

test.each(["clearMessages", "deleteSession"] as const)("%s retires only the acknowledged scope after navigation", async (action) => {
  const f = mutationFixture();
  const pending = f.controller[action]("target");
  await vi.waitFor(() => expect(action === "clearMessages" ? f.client.clearSessionMessages : f.client.deleteSession).toHaveBeenCalledOnce());
  expect(f.owner.selectedProfileId()).toBe("target-model");
  f.switchEnvironment(); f.resolve(); await pending;
  expect(f.owner.selectedProfileId()).toBe("other-model");
  f.show(f.target); expect(f.owner.override()).toBeNull();
  expect(f.drafts.open(f.target).text).toBe("Preserved target text");
});

test.each(["clearMessages", "deleteSession"] as const)("%s refusal preserves the pending choice", async (action) => {
  const f = mutationFixture();
  const pending = f.controller[action]("target");
  await vi.waitFor(() => expect(action === "clearMessages" ? f.client.clearSessionMessages : f.client.deleteSession).toHaveBeenCalledOnce());
  f.reject(new Error("Refused")); await pending;
  expect(f.owner.selectedProfileId()).toBe("target-model");
});

test("runtime reset retires confirmed targets while preserving failed and other-environment choices", async () => {
  const f = choiceFixture();
  const scope = (environmentId: string, sessionId: string) => ({ environmentId, sessionId });
  for (const target of [scope("dev", "deleted"), scope("dev", "cleared"), scope("dev", "failed"), scope("prod", "deleted")]) {
    f.drafts.open(target).text = "Unsent text"; f.choose(target, `${target.environmentId}-${target.sessionId}`);
  }
  await reconcileRuntimeSessionReset({
    result: { deletedSessionIds: ["deleted"], clearedSessionIds: ["cleared"], failedSessionIds: ["failed"] },
    environmentId: "dev", getEnvironmentId: () => "prod", state: { currentSessionId: "deleted" },
    preferences: { sessionIdForEnvironment: () => "", saveSessionIdForEnvironment: vi.fn() },
    clearSessionDraft: (target: ComposerScope) => { f.owner.retireSessionSelection(target); f.drafts.resetSessionData(target); },
  });
  for (const sessionId of ["deleted", "cleared"]) { f.show(scope("dev", sessionId)); expect(f.owner.override()).toBeNull(); }
  f.show(scope("dev", "failed")); expect(f.owner.selectedProfileId()).toBe("dev-failed");
  f.show(scope("prod", "deleted")); expect(f.owner.selectedProfileId()).toBe("prod-deleted");
});

test.each(["send", "send_next"] as const)("accepted %s retires the captured scope's empty selection through the production hook", async (action) => {
  let owner: ReturnType<typeof createSessionRunSelection>;
  const accepted = vi.fn((attempt: ComposerSubmissionAttempt) => owner.pruneEmptyDraftSelections(attempt.payload.scope));
  const h = createComposerProductionHarness({ onSubmissionAccepted: accepted } as any);
  if (action === "send") h.state.activeRequestId = "";
  owner = createSessionRunSelection({ getScope: () => h.workspace.chatDraft().scope,
    getComposerScope: () => h.workspace.chatDraft().scope, hasUnsentDraft: h.workspace.drafts.hasUnsentDraft,
    getSubmissionScopes: () => h.composer.lifecycle.ownedScopes() });
  owner.remember({ profileId: "chosen" });
  h.type("Submit this draft");
  await h.composer.submit.dispatch(action);
  expect(accepted).toHaveBeenCalledOnce();
  expect(owner.override()).toBeNull();
});

test("acceptance leaves a newer nonempty draft's choice intact", async () => {
  let owner: ReturnType<typeof createSessionRunSelection>;
  const h = createComposerProductionHarness({ onSubmissionAccepted: (attempt: ComposerSubmissionAttempt) => owner.pruneEmptyDraftSelections(attempt.payload.scope) } as any);
  h.state.activeRequestId = "";
  owner = createSessionRunSelection({ getScope: () => h.workspace.chatDraft().scope,
    getComposerScope: () => h.workspace.chatDraft().scope, hasUnsentDraft: h.workspace.drafts.hasUnsentDraft,
    getSubmissionScopes: () => h.composer.lifecycle.ownedScopes() });
  let accept!: (requestId: string) => void;
  h.client.postChatMessage.mockImplementationOnce(() => new Promise((resolve) => { accept = resolve; }));
  owner.remember({ profileId: "first" }); h.type("First message");
  const sending = h.composer.submit.dispatch("send");
  await vi.waitFor(() => expect(h.client.postChatMessage).toHaveBeenCalledOnce());
  h.type("New unsent draft"); owner.remember({ profileId: "second" });
  accept("accepted-request"); await sending;
  expect(owner.selectedProfileId()).toBe("second");
  expect(h.workspace.chatDraft().text).toBe("New unsent draft");
});

test.each(["refused", "uncertain"])("navigation keeps captured settings while a submission becomes %s", async (outcome) => {
  let owner: ReturnType<typeof createSessionRunSelection>;
  const h = createComposerProductionHarness({ getSettings: () => ({
    agentMode: owner.selectedAgentMode("reasoning"), toolPermissionMode: "ask",
    modelPreference: { profileId: owner.selectedProfileId("default") },
  }) } as any);
  h.state.activeRequestId = "";
  owner = createSessionRunSelection({ getScope: () => h.workspace.chatDraft().scope,
    getComposerScope: () => h.workspace.chatDraft().scope, hasUnsentDraft: h.workspace.drafts.hasUnsentDraft,
    getSubmissionScopes: () => h.composer.lifecycle.ownedScopes() });
  const scope = h.workspace.chatDraft().scope;
  owner.applySnapshot({ sessionId: scope.sessionId, modelSelection: {
    requestId: "old", selectedAt: 1, primaryProfileId: "model-a", agentMode: "fast",
  } }, scope);
  owner.remember({ profileId: "model-b", agentMode: "deep" });
  let reject!: (error: Error) => void;
  h.client.postChatMessage.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  h.type("Preserve the captured draft");
  const sending = h.composer.submit.dispatch("send");
  await vi.waitFor(() => expect(h.client.postChatMessage).toHaveBeenCalledOnce());
  expect(h.client.postChatMessage.mock.calls[0]![0]).toMatchObject({ agentMode: "deep", modelPreference: { profileId: "model-b" } });
  owner.pruneEmptyDraftSelections(); h.feature.setWorkspace("home");
  const error = new Error(outcome);
  if (outcome === "refused") Object.assign(error, { status: 400 });
  reject(error); await sending;
  owner.pruneEmptyDraftSelections();
  h.feature.setWorkspace("chat");
  if (outcome === "refused") expect(h.workspace.chatDraft().text).toBe("Preserve the captured draft");
  if (outcome === "uncertain") expect(h.composer.lifecycle.paused(scope)).toHaveLength(1);
  expect(owner.selectedProfileId()).toBe("model-b");
  expect(owner.selectedAgentMode("reasoning")).toBe("deep");
});

test("cleanup enumerates owned submissions once and probes each remaining draft once", async () => {
  const drafts = createComposerDrafts();
  const lifecycle = createComposerSubmissionLifecycle({ drafts });
  let scope = { environmentId: "dev", sessionId: "" };
  let yielded = 0;
  const getSubmissionScopes = vi.fn(function* () {
    for (const owned of lifecycle.ownedScopes()) { yielded += 1; yield owned; }
  });
  const hasUnsentDraft = vi.fn(drafts.hasUnsentDraft);
  const owner = createSessionRunSelection({ getScope: () => scope, getComposerScope: () => scope,
    getSubmissionScopes, hasUnsentDraft });
  for (let index = 0; index < 500; index += 1) {
    scope = { environmentId: "dev", sessionId: `owned-${index}` };
    owner.remember({ profileId: "keep" });
    const draft = drafts.open(scope); draft.text = "Captured submission";
    const result = await lifecycle.submit({ draft, action: "send", execute: async () => { throw new Error("unknown acknowledgement"); } });
    expect(result.status).toBe("uncertain");
    scope = { environmentId: "dev", sessionId: `empty-${index}` };
    owner.remember({ profileId: "retire" });
  }
  owner.pruneEmptyDraftSelections();
  expect(getSubmissionScopes).toHaveBeenCalledOnce();
  expect(yielded).toBe(500);
  expect(hasUnsentDraft).toHaveBeenCalledTimes(500);
  for (let index = 0; index < 500; index += 1) {
    scope = { environmentId: "dev", sessionId: `owned-${index}` };
    expect(owner.selectedProfileId()).toBe("keep");
    scope = { environmentId: "dev", sessionId: `empty-${index}` };
    expect(owner.override()).toBeNull();
  }
});
