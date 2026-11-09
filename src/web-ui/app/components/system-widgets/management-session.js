import { createSkillsController } from "../../controllers/skills-controller.js";
import { createInformationBasketController } from "../../controllers/information-basket-controller.js";
import { createSkillsWorkspace } from "../skills/workspace.js";
import { createInformationBasketWorkspace } from "../information-basket/workspace.js";
import { closeNestedManagementDialogs, scopeManagementIds } from "./management-dom.js";

function guardedManagementActions(actions, isCurrent) {
  return Object.fromEntries(Object.entries(actions).map(([key, value]) => {
    if (key === "picker") return [key, guardedManagementActions(value, isCurrent)];
    if (typeof value !== "function") return [key, value];
    return [key, (...args) => isCurrent() ? value(...args) : false];
  }));
}

/** Owns only embedding lifecycle; the existing controllers remain the CRUD owners. */
export function createSystemManagementSession({ kind, root, prefix, client, getEnvironmentId,
  documentRoot, confirm, onSnapshot, onChanged }) {
  const environmentId = getEnvironmentId();
  let alive = true;
  let started = false;
  let previousMutation = "";
  let view;
  let finishInitialRead;
  const initialRead = new Promise((resolve) => { finishInitialRead = resolve; });
  const isCurrent = () => alive && environmentId === getEnvironmentId();
  const confirmCurrent = (message, options) => isCurrent() ? confirm(message, options) : Promise.resolve(false);
  function publish(snapshot) {
    if (!isCurrent()) return;
    view?.render(snapshot);
    onSnapshot(snapshot);
    if (started && !snapshot.loading) finishInitialRead();
    const settledMutation = previousMutation && !snapshot.mutation;
    previousMutation = snapshot.mutation;
    if (settledMutation) onChanged(kind);
  }
  const controller = kind === "skills"
    ? createSkillsController({ client, getEnvironmentId, render: publish,
      confirmDiscard: (message) => confirmCurrent(message, { title: "Unsaved Skill", confirmLabel: "Discard changes", tone: "danger" }) })
    : createInformationBasketController({ client, getEnvironmentId, render: publish,
      isVisible: () => isCurrent() && documentRoot.visibilityState !== "hidden",
      confirmRemove: (count) => confirmCurrent(`Remove ${count === 1 ? "this source" : `${count} sources`} from the basket? Original files will not be deleted.`,
        { title: "Remove from basket", confirmLabel: "Remove", tone: "danger" }) });
  const actions = guardedManagementActions(controller, isCurrent);
  view = kind === "skills"
    ? createSkillsWorkspace({ root, actions,
      confirmArchive: (message) => confirmCurrent(message, { title: "Archive Skill", confirmLabel: "Archive", tone: "danger" }) })
    : createInformationBasketWorkspace({ root, actions, documentRoot });
  scopeManagementIds(root, prefix);
  view.render(controller.snapshot());

  const isBusy = () => Boolean(controller.snapshot().mutation);
  const isDirty = () => kind === "skills" ? controller.isDirty() : controller.snapshot().settingsDirty;
  async function select(id) {
    if (!id || !isCurrent()) return false;
    if (kind === "resources") { controller.showDetails(id); return true; }
    const item = controller.snapshot().items.find((item) => item.skillId === id);
    if (!item) return false;
    if (!await controller.setArchived(item.archived)) return false;
    if (!isCurrent()) return false;
    return controller.select(id);
  }
  async function prepareResourceLeave() {
    const snapshot = controller.snapshot();
    if (!snapshot.settingsDirty) return true;
    if (!await confirmCurrent("Discard unsaved Resource indexing settings?",
      { title: "Unsaved Resource settings", confirmLabel: "Discard changes", tone: "danger" })) return false;
    return () => { controller.resetSettings(); return true; };
  }
  function captureDraftIdentity() {
    const snapshot = controller.snapshot();
    if (kind === "resources") return [snapshot.settingsDraft, snapshot.settingsDirty];
    return [snapshot.skill, snapshot.creating, snapshot.name, snapshot.description, snapshot.draft, snapshot.reading];
  }
  async function prepareLeave() {
    if (!isCurrent() || isBusy()) return false;
    const originalDraft = captureDraftIdentity();
    const preparation = await (kind === "skills" ? controller.prepareLeave() : prepareResourceLeave());
    if (preparation === false) return false;
    function canCommit() {
      if (!isCurrent() || isBusy()) return false;
      if (preparation?.canCommit?.() === false) return false;
      return captureDraftIdentity().every((value, index) => value === originalDraft[index]);
    }
    if (!canCommit()) return false;
    const commit = () => {
      if (!canCommit()) return false;
      return typeof preparation === "function" ? preparation() : true;
    };
    commit.canCommit = canCommit;
    return commit;
  }
  return {
    isCurrent, isBusy, isDirty, prepareLeave, select,
    async start(id) {
      started = true;
      controller.setActive(true);
      await initialRead;
      if (!isCurrent()) return false;
      if (id) await select(id);
      return isCurrent();
    },
    handleRealtime(message) { if (isCurrent()) controller.handleRealtime?.(message); },
    reconnect() { if (isCurrent()) return controller.refresh(); },
    visibilityChanged() { if (isCurrent() && documentRoot.visibilityState !== "hidden") return controller.refresh(); },
    dispose() {
      if (!alive) return;
      controller.setActive(false);
      closeNestedManagementDialogs(root);
      alive = false;
      controller.environmentChanged();
      finishInitialRead();
    },
  };
}
