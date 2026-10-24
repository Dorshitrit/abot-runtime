import { afterEach, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module.
import { createWorkspaceTransitions } from "../../web-ui/app/components/workspace-transitions.js";
// @ts-expect-error Browser-only module.
import { createSkillsController } from "../../web-ui/app/controllers/skills-controller.js";
// @ts-expect-error Browser-only module.
import { createConfigWorkspaceMutations } from "../../web-ui/app/components/config-workspace/workspace-mutations.js";
// @ts-expect-error Browser-only module.
import { createSchedulesWorkspace } from "../../web-ui/app/components/schedules/workspace.js";
// @ts-expect-error Browser-only module.
import { createEnvironmentTransition } from "../../web-ui/app/controllers/environment-transition.js";
// @ts-expect-error Browser-only module.
import { createWorkspaceRouteController } from "../../web-ui/app/controllers/workspace-route-controller.js";
// @ts-expect-error Browser-only module.
import { createWorkspaceShell } from "../../web-ui/app/components/workspace-shell.js";
import { createWorkspaceShellHarness } from "./support/workspace-shell-harness.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function preparedChange() {
  return Object.assign(vi.fn(() => true), { canCommit: vi.fn(() => true) });
}
function transitions(guards: Array<() => unknown>) {
  return createWorkspaceTransitions({ getWorkspace: () => "config", getNavigationRevision: () => 0,
    isAvailable: () => true, getGuards: () => guards });
}
afterEach(() => vi.unstubAllGlobals());

test("later guard refusal leaves previously accepted drafts untouched", async () => {
  const discard = preparedChange(), answer = deferred<boolean>();
  const laterGuard = vi.fn(() => answer.promise);
  const navigation = transitions([() => discard, laterGuard]);
  const pending = navigation.prepare("chat");
  await vi.waitFor(() => expect(laterGuard).toHaveBeenCalled());
  expect(discard).not.toHaveBeenCalled();
  answer.resolve(false);
  expect(await pending).toBeNull();
  expect(discard).not.toHaveBeenCalled();
});

test("new navigation request supersedes a pending dialog before either workspace commits", async () => {
  const first = deferred<ReturnType<typeof preparedChange>>();
  const discard = preparedChange();
  const guard = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(true);
  const navigation = transitions([guard]);
  const older = navigation.prepare("chat");
  const latest = await navigation.prepare("models");
  first.resolve(discard);
  expect(await older).toBeNull();
  expect(latest.commitBeforeChange()).toBe(true);
  expect(discard).not.toHaveBeenCalled();
});

test("a changed draft vetoes the full prepared transition before any discard", async () => {
  const first = preparedChange(), second = preparedChange();
  const navigation = transitions([() => first, () => second]);
  const ready = await navigation.prepare("chat");
  second.canCommit.mockReturnValue(false);
  expect(ready.commitBeforeChange()).toBe(false);
  expect(first).not.toHaveBeenCalled();
  expect(second).not.toHaveBeenCalled();
});

async function skillFixture() {
  const answer = deferred<boolean>(), saved = deferred<unknown>();
  let environment = "dev";
  const record = { skillId: "one", source: "personal", content: "Original", revision: 1 };
  const client = { supportsSkills: () => true, listPersonalSkills: async () => ({ items: [record] }),
    readPersonalSkill: async () => ({ skill: record }), updatePersonalSkill: vi.fn(() => saved.promise) };
  const controller = createSkillsController({ client, getEnvironmentId: () => environment, render: vi.fn(),
    confirmDiscard: () => answer.promise });
  await controller.refresh(); await controller.select("one"); controller.setDraft("Edited");
  return { controller, answer, saved, setEnvironment(value: string) { environment = value; controller.environmentChanged(); } };
}
test("Skill confirmation never discards a newer draft", async () => {
  const f = await skillFixture();
  const pending = f.controller.prepareLeave();
  f.controller.setDraft("Newer edit"); f.answer.resolve(true);
  expect(await pending).toBe(false);
  expect(f.controller.snapshot().draft).toBe("Newer edit");
});
test("Skill confirmation cannot survive an environment round trip", async () => {
  const f = await skillFixture();
  const pending = f.controller.prepareLeave();
  f.setEnvironment("prod"); f.setEnvironment("dev"); f.answer.resolve(true);
  expect(await pending).toBe(false);
  expect(f.controller.snapshot().skill).toBeNull();
});
test("a Skill save started during confirmation prevents discarding its draft", async () => {
  const f = await skillFixture();
  const pending = f.controller.prepareLeave(), saving = f.controller.save();
  f.answer.resolve(true);
  const prepared = await pending;
  expect(prepared.canCommit()).toBe(false);
  expect(prepared()).toBe(false);
  expect(f.controller.snapshot().draft).toBe("Edited");
  f.saved.resolve({ skill: { skillId: "one", source: "personal", content: "Edited", revision: 2 } });
  await saving;
});

function configFixture() {
  const answer = deferred<boolean>();
  const file = { kind: "runtime", id: "runtime", config: { value: "edit" } };
  const state = { configDashboard: {}, externalRuntimeMutationInFlight: false, savingKeys: new Set(),
    baselinesByKey: new Map([["runtime", { value: "original" }]]), rawDraftsByKey: new Map(),
    appliedJsonRepairKeys: new Set(), savedKeys: new Set(), selectedRawConfigKey: "runtime" };
  const render = vi.fn();
  const mutations = createConfigWorkspaceMutations({ state, dom: {}, confirmDiscard: () => answer.promise,
    configFileEntries: () => [file], configFileKey: () => "runtime", dirtyFiles: () => [file],
    renderConfigDashboard: render, setWorkspaceStatus: vi.fn() });
  return { answer, file, state, render, mutations };
}
test.each(["draft", "dashboard", "save"])("configuration discard rejects changed %s while dialog is pending", async (change) => {
  const f = configFixture();
  const pending = f.mutations.prepareDiscardChanges();
  if (change === "draft") f.file.config.value = "newer";
  if (change === "dashboard") f.state.configDashboard = {};
  if (change === "save") f.state.savingKeys.add("runtime");
  f.answer.resolve(true);
  expect(await pending).toBeNull();
  expect(f.render).not.toHaveBeenCalled();
  expect(f.file.config.value).toBe(change === "draft" ? "newer" : "edit");
});
test("configuration discard remains deferred until its prepared callback commits", async () => {
  const f = configFixture(), pending = f.mutations.prepareDiscardChanges();
  f.answer.resolve(true); const commit = await pending;
  expect(f.file.config.value).toBe("edit");
  expect(commit()).toBe(true);
  expect(f.file.config.value).toBe("original");
});

function scheduleFixture() {
  const document = {} as ConstructorParameters<typeof FakeElement>[1];
  document.createElement = (tag) => new FakeElement(tag, document);
  const root = document.createElement("section"), answer = deferred<boolean>();
  let environment = "dev", content = "original";
  const editor = {};
  const actions = { snapshot: () => ({ editor, mutation: "" }), cancelEdit: vi.fn(), load: vi.fn(), beginEdit: vi.fn() };
  vi.stubGlobal("FormData", class { *[Symbol.iterator]() { yield ["prompt", content]; } });
  const view = createSchedulesWorkspace({ root, actions, documentRoot: document, getEnvironmentId: () => environment,
    confirmDiscard: () => answer.promise });
  const details = root.querySelector(".schedule-details")!;
  details.innerHTML = '<form class="schedule-editor" data-dirty="true"></form>';
  return { actions, view, answer, changeDraft: () => { content = "newer"; }, changeEnvironment: () => { environment = "prod"; } };
}
test.each(["draft", "environment"])("schedule discard rejects a changed %s while dialog is pending", async (change) => {
  const f = scheduleFixture(), pending = f.view.prepareEnvironmentChange();
  if (change === "draft") f.changeDraft(); else f.changeEnvironment();
  f.answer.resolve(true);
  expect(await pending).toBeNull();
  expect(f.actions.cancelEdit).not.toHaveBeenCalled();
});
test("schedule draft is cancelled only when all prepared navigation commits", async () => {
  const f = scheduleFixture(), pending = f.view.prepareEnvironmentChange();
  f.answer.resolve(true); const commit = await pending;
  expect(f.actions.cancelEdit).not.toHaveBeenCalled();
  expect(commit()).toBe(true);
  expect(f.actions.cancelEdit).toHaveBeenCalledOnce();
});

test("a stale environment dialog cancellation cannot roll back a later committed selection", async () => {
  const answer = deferred<boolean>();
  const dom = { environmentSelect: { value: "dev", dispatchEvent: vi.fn() }, sessionTitle: { textContent: "" } };
  const state = {};
  const actions = { beforeEnvironmentChange: vi.fn().mockReturnValueOnce(answer.promise).mockReturnValueOnce(true),
    renderAgentPicker: vi.fn(), resetLiveRequestView: vi.fn(), applyConversationChrome: vi.fn(), renderMessages: vi.fn(),
    saveEnvironmentId: vi.fn(), loadModels: vi.fn(), loadAgentMode: vi.fn(), loadRuntimeConfig: vi.fn(), restoreLastSession: vi.fn() };
  const transition = createEnvironmentTransition({ state, dom, actions, prepareQueueRecovery: () => true, onNavigationChange: vi.fn() });
  const older = transition.changeEnvironment("prod");
  expect(await transition.changeEnvironment("qa")).toBe(true);
  answer.resolve(false);
  expect(await older).toBe(false);
  expect(dom.environmentSelect.value).toBe("qa");
  expect(actions.restoreLastSession).toHaveBeenCalledOnce();
});


test.each(["automations", "chat"])("cross-environment %s route commits the old draft before resetting environment views", async (workspace) => {
  const shell = createWorkspaceShell(createWorkspaceShellHarness());
  shell.load(); await shell.activateWorkspace("automations", { focus: false });
  const dom = { environmentSelect: { value: "dev", dispatchEvent: vi.fn() }, sessionTitle: { textContent: "" } };
  const answer = deferred<(() => boolean) & { canCommit: () => boolean }>();
  let dirty = true, automationRevision = 0;
  const discard = Object.assign(vi.fn(() => { dirty = false; return true; }), {
    canCommit: () => dirty && dom.environmentSelect.value === "dev",
  });
  const actions = { beforeEnvironmentChange: () => true, renderAgentPicker: vi.fn(),
    resetLiveRequestView: vi.fn(), applyConversationChrome: vi.fn(), renderMessages: vi.fn(), saveEnvironmentId: vi.fn(),
    loadModels: () => { expect(dirty).toBe(false); automationRevision += 1; },
    loadAgentMode: vi.fn(), loadRuntimeConfig: vi.fn(), restoreLastSession: vi.fn() };
  const transition = createEnvironmentTransition({ state: {}, dom, actions,
    prepareQueueRecovery: () => true, onNavigationChange: vi.fn() });
  const automations = { prepareRouteChange: () => answer.promise, isWorkspaceAvailable: () => true,
    navigationRevision: () => automationRevision, selectedAutomationId: () => "next", selectedRunId: () => "",
    chatRunId: () => "", openRoute: vi.fn(async () => true), openChatRun: vi.fn(async () => true) };
  const route = createWorkspaceRouteController({
    viewport: { location: new URL("/" + workspace + "?environment=prod&automation=next", "http://localhost"),
      history: { state: null, replaceState: vi.fn() } },
    shell, automations, configuration: { navigationRevision: () => 0, activateCategory: vi.fn() },
    schedules: { navigationRevision: () => 0, selectedJobId: () => "" },
    selection: { environmentOptions: () => [{ value: "dev" }, { value: "prod" }] },
    getEnvironmentId: () => dom.environmentSelect.value, getSessionId: () => "",
    changeEnvironment: transition.changeEnvironment, restoreLastSession: vi.fn(), loadSessions: vi.fn(), openSession: vi.fn(),
  });
  const pending = route.restoreInitial();
  expect(dom.environmentSelect.value).toBe("dev");
  expect(dirty).toBe(true);
  answer.resolve(discard);
  await pending;
  expect(discard).toHaveBeenCalledOnce();
  expect(dom.environmentSelect.value).toBe("prod");
  expect(shell.activeWorkspace()).toBe(workspace);
  if (workspace === "automations") expect(automations.openRoute).toHaveBeenCalledWith("next", "");
  else expect(automations.openChatRun).toHaveBeenCalledWith("");
});
