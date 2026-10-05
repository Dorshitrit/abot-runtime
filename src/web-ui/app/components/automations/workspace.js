import { escapeHtml } from "../../lib/text-format.js";
import { renderAutomationList } from "./list.js";
import { createAutomationArchiveCommands } from "./archive-actions.js";
import { createAutomationDraftRecoveryCommands } from "./draft-recovery-actions.js";
import { activateAutomationLibraryTab, automationLibraryTabForKey, renderAutomationLibraryTabs } from "./library-tabs.js";
import { readAutomationDefinitionPatch, renderAutomationEditor, renderAutomationToolResults, toolDisplayName } from "./editor.js";
import { createAutomationStepEditorDialog } from "./step-editor-dialog.js";
import { focusSelectedAutomationStep } from "./run-steps-view.js";
import { renderAutomationRun } from "./run.js";
import { findAutomationPosition } from "../../lib/automation-graph-position.js";
import { canWrapAutomationSequence } from "../../lib/automation-parallel-depth.js";
import { createAutomationTimelineCamera } from "./timeline-camera.js";
import { createAutomationLiveView } from "./live-view.js";
import { automationRerunConfirmation } from "./rerun-confirmation.js";
import { matchesAutomationGrant, requiresFullPlus, selectedAutomationOperations } from "./permission-selection.js";

const DRAG_TYPE = "application/x-abot-automation-step";

export function paletteNode(target, catalog) {
  if (target.kind === "tool") {
    const items = Array.isArray(catalog?.grantableOperations)
      ? catalog.grantableOperations : catalog?.operations || [];
    const item = items.find((entry) => entry.toolName === target.id);
    if (!item) return null;
    return { kind: "tool", title: toolDisplayName(item.toolName), onFailure: "stop",
      operation: { toolName: item.toolName, operationId: "", contractVersion: item.contractVersion }, controls: {} };
  }
  if (target.kind !== "agent") return null;
  const saved = catalog?.savedAgents?.find((entry) => (entry.agentId || entry.id) === target.id);
  if (!saved && target.id !== "new") return null;
  if (saved && !saved.agent) return null;
  const agent = saved?.agent || {};
  return {
    kind: "agent", title: agent.title || "New agent", onFailure: agent.onFailure || "stop",
    modelProfileId: agent.modelProfileId || "", agentMode: agent.agentMode || "fast",
    roleInstructions: agent.roleInstructions || "", prompt: agent.prompt || "",
    inputs: agent.inputs || {}, tools: agent.tools || [], result: agent.result || { kind: "text" },
    ...(Array.isArray(agent.acceptance) ? { acceptance: agent.acceptance } : {}),
    ...(saved ? { savedAgentOrigin: { agentId: saved.agentId || saved.id, revision: saved.revision } } : {}),
  };
}

function permissionDialogMarkup(selection, purpose, revision) {
  const action = purpose === "publish" ? "publish" : "activate";
  return `<form method="dialog" class="automation-permission-dialog"><h3>Confirm ${action}</h3>
    <p>${selection.operations.length ? `Only these ${selection.operations.length} selected operation${selection.operations.length === 1 ? "" : "s"} will be granted to this automation.` : "This automation has no selected tool operations."} ${purpose === "publish" ? `Draft revision ${escapeHtml(revision)} will be published.` : `Published revision ${escapeHtml(revision)} will be activated.`}</p>
    ${selection.mode === "full_plus" ? `<p class="automation-full-plus-notice">FULL+ access is required by a selected operation. Confirming grants FULL+ only to this automation and only for the operations below.</p>` : ""}
    <div class="automation-grant-options">${selection.details.map((item) => `<div class="automation-grant-operation"><strong>${escapeHtml(toolDisplayName(item.toolName))} · ${escapeHtml(toolDisplayName(item.operationId))}</strong><small>${requiresFullPlus(item) ? "FULL+" : "Full"} · ${escapeHtml(item.label || "")}</small></div>`).join("") || `<p>No tool operations need permission.</p>`}</div>
    <p class="automation-permission-feedback" role="status" aria-live="polite"></p>
    <div class="automation-actions"><button type="button" data-close-permission>Cancel</button><button type="submit" class="automation-primary">${selection.mode === "full_plus" ? "Grant FULL+ and " : "Confirm and "}${escapeHtml(action)}</button></div></form>`;
}

export function createAutomationsWorkspace({
  root, actions, documentRoot = document,
  confirmDiscard = (message) => window.confirm(message),
}) {
  let current = actions.snapshot();
  let definitionDirty = false;
  let insertion = null;
  let permissionDialog = null;
  let paletteQuery = "";
  let paletteSelectedTool = "";
  let detailsCollapsed = false;
  let activeLibraryTab = "studio";
  let showArchived = false;
  let renderedNodeId = current.selectedNodeId || "";
  const stepEditor = createAutomationStepEditorDialog({ root, actions, documentRoot,
    onAction: (name) => command[name]?.() });
  const camera = createAutomationTimelineCamera(root, {
    isEditing: () => Boolean(current.selectedNodeId) || stepEditor.isOpen(),
  });
  const liveView = createAutomationLiveView(root);

  function isDirty() { return definitionDirty || stepEditor.isDirty(); }

  function notify(message) {
    const status = root.querySelector(".automation-feedback");
    if (status) status.textContent = message;
  }

  function prepareLeave() {
    if (!stepEditor.prepareLeave()) return false;
    if (permissionDialog?.open) permissionDialog.close();
    if (!isDirty()) return true;
    if (!confirmDiscard("Discard unsaved automation changes?")) return false;
    definitionDirty = false;
    return true;
  }

  function requireSavedGraph() {
    if (!isDirty()) return true;
    notify("Save the current draft or step before changing the graph.");
    return false;
  }

  function markInsertion() {
    for (const button of root.querySelectorAll("[data-insert-parent]")) {
      const selected = insertion?.parentSequenceId === button.dataset.insertParent
        && insertion.index === Number(button.dataset.insertIndex);
      button.dataset.insertionSelected = String(selected);
      if (button.hasAttribute("aria-pressed")) button.setAttribute("aria-pressed", String(selected));
      const help = button.querySelector("[data-insert-help]");
      if (help) help.textContent = selected
        ? "Position selected · choose from Tools or Agents"
        : "Choose from Tools or Agents, or drag here";
    }
  }

  function updateDetailsVisibility() {
    const details = root.querySelector("#automation-editor-details");
    const toggle = root.querySelector('[data-action="toggle-details"]');
    if (!details || !toggle) return;
    details.hidden = detailsCollapsed;
    root.querySelector(".automation-definition-panel").dataset.detailsCollapsed = String(detailsCollapsed);
    toggle.setAttribute("aria-expanded", String(!detailsCollapsed));
    toggle.querySelector("[data-details-label]").textContent = detailsCollapsed
      ? "Expand details" : "Collapse details";
  }

  function render(snapshot) {
    stepEditor.sync(snapshot);
    const waitingForSelectedView = snapshot.loading && snapshot.selectedAutomationId &&
      (snapshot.selectedRunId ? !snapshot.run : !snapshot.draft);
    if (waitingForSelectedView && root.querySelector(".automation-workspace-content")) {
      current = snapshot;
      root.setAttribute("aria-busy", "true");
      const content = root.querySelector(".automation-workspace-content");
      content.setAttribute("aria-busy", "true");
      content.inert = true;
      return;
    }
    const previousNodeId = renderedNodeId;
    const viewIdentity = `${snapshot.selectedAutomationId}/${snapshot.selectedRunId || "editor"}`;
    const sameEditor = snapshot.selectedAutomationId === current.selectedAutomationId && !snapshot.selectedRunId;
    if (!liveView.isCurrent(viewIdentity)) { paletteQuery = ""; paletteSelectedTool = ""; insertion = null; detailsCollapsed = false; camera.resetState(); }
    else camera.capture();
    const retainedDefinition = definitionDirty && sameEditor
      ? root.querySelector("[data-automation-definition-form]") : null;
    current = snapshot;
    renderedNodeId = snapshot.selectedNodeId || "";
    if (snapshot.selectedAutomationId) activeLibraryTab = "studio";
    const markup = !snapshot.selectedAutomationId ? renderAutomationList(snapshot, { archived: showArchived })
      : snapshot.selectedRunId ? renderAutomationRun(snapshot)
        : renderAutomationEditor(snapshot, { query: paletteQuery, selectedToolName: paletteSelectedTool });
    const changed = liveView.update(viewIdentity, renderAutomationLibraryTabs(snapshot, markup, activeLibraryTab));
    if (changed && retainedDefinition) root.querySelector("[data-automation-definition-form]")?.replaceWith(retainedDefinition);
    markInsertion();
    updateDetailsVisibility();
    camera.restore();
    if (snapshot.selectedNodeId && snapshot.selectedNodeId !== previousNodeId && !stepEditor.isOpen())
      camera.revealNode(snapshot.selectedNodeId);
    root.setAttribute("aria-busy", String(snapshot.loading || Boolean(snapshot.mutation)));
  }

  function refreshToolPalette() {
    const results = root.querySelector("[data-automation-tool-results]");
    if (results) results.innerHTML = renderAutomationToolResults(current.catalog,
      { query: paletteQuery, selectedToolName: paletteSelectedTool });
  }

  async function selectLibraryTab(name, focus = false) {
    if (name === activeLibraryTab) return;
    if (name === "templates" && current.selectedAutomationId) {
      if (!prepareLeave() || !await actions.openRoute("", "")) return;
    }
    activeLibraryTab = name;
    activateAutomationLibraryTab(root, name, { focus });
  }

  async function saveDefinition() {
    const form = root.querySelector("[data-automation-definition-form]");
    if (!form || !current.draft?.definition) return;
    try {
      const patch = readAutomationDefinitionPatch(form, current.draft.definition);
      const saved = await actions.saveDefinition(patch);
      if (!saved) return;
      definitionDirty = false;
      render(actions.snapshot());
    } catch (error) { notify(error instanceof Error ? error.message : String(error)); }
  }

  async function addPaletteStep(target, location = insertion) {
    if (!requireSavedGraph()) return;
    const definition = current.draft?.definition;
    if (!definition) return;
    const nodeWithoutId = paletteNode(target, current.catalog);
    if (!nodeWithoutId) { notify("This step is unavailable under the current permission."); return; }
    const rootSequence = definition.body;
    const parentSequenceId = location?.parentSequenceId || rootSequence.id;
    const index = location?.index ?? rootSequence.children.length;
    const saved = await actions.mutateDraft({ kind: "add_node", parentSequenceId, index, nodeWithoutId });
    if (saved) { insertion = null; markInsertion(); }
  }

  function selectedPosition() {
    return findAutomationPosition(current.draft?.definition?.body, current.selectedNodeId);
  }

  async function moveStep(delta) {
    if (!requireSavedGraph()) return;
    const position = selectedPosition();
    if (!position) return;
    const index = position.index + (delta > 0 ? 2 : -1);
    if (index < 0 || index > position.count) return;
    await actions.mutateDraft({ kind: "move_node", nodeId: current.selectedNodeId, parentSequenceId: position.parentSequenceId, index });
  }

  async function moveToSlot() {
    if (!requireSavedGraph() || !insertion || !current.selectedNodeId) return;
    const moved = await actions.mutateDraft({
      kind: "move_node", nodeId: current.selectedNodeId,
      parentSequenceId: insertion.parentSequenceId, index: insertion.index,
    });
    if (moved) { insertion = null; markInsertion(); }
  }

  async function wrapParallel() {
    if (!requireSavedGraph()) return;
    const position = selectedPosition();
    if (!position?.next || !["agent", "tool"].includes(position.next.kind)) {
      notify("Select a step with another tool or agent immediately after it.");
      return;
    }
    if (!canWrapAutomationSequence(current.draft?.definition?.body, position.parentSequenceId)) {
      notify("This runtime supports at most two nested Parallel groups. Move these steps to a shallower branch before merging.");
      return;
    }
    await actions.mutateDraft({ kind: "wrap_parallel", nodeIds: [current.selectedNodeId, position.next.id] });
  }

  async function removeStep() {
    if (!requireSavedGraph()) return;
    if (!confirmDiscard("Remove this step from the draft?")) return;
    const removed = await actions.mutateDraft({ kind: "remove_node", nodeId: current.selectedNodeId });
    if (removed) actions.selectNode("");
  }

  function openPermissionDialog(purpose) {
    if (permissionDialog?.open) return;
    const selectedAutomation = current.automations.find((item) => item.id === current.selectedAutomationId);
    const definition = purpose === "activate" ? current.publishedDefinition : current.draft?.definition;
    if (!definition || (purpose === "activate" && definition.revision !== selectedAutomation?.publishedRevision)) {
      notify("The published revision is unavailable. Refresh ABot Studio before activating.");
      return;
    }
    const selection = selectedAutomationOperations(definition, current.catalog);
    if (selection.missing.length) {
      notify("A selected operation is no longer configured. Update the step before continuing.");
      return;
    }
    const automationId = current.selectedAutomationId;
    const revision = definition.revision;
    const dialog = documentRoot.createElement("dialog");
    permissionDialog = dialog;
    dialog.className = "automation-permission-modal";
    dialog.innerHTML = permissionDialogMarkup(selection, purpose, revision);
    documentRoot.body.append(dialog);
    dialog.addEventListener("close", () => {
      permissionDialog = null;
      dialog.remove();
    }, { once: true });
    dialog.querySelector("[data-close-permission]").addEventListener("click", () => dialog.close());
    const form = dialog.querySelector("form");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      const latest = actions.snapshot();
      const stillSame = latest.selectedAutomationId === automationId &&
        (purpose === "activate" ? latest.publishedDefinition?.revision : latest.draft?.revision) === revision;
      let completed = false;
      if (!stillSame) {
        dialog.querySelector(".automation-permission-feedback").textContent = "The revision changed. Refresh and confirm again.";
      } else {
        const granted = (selection.operations.length === 0 && !latest.grant) ||
          matchesAutomationGrant(latest.grant, selection) ||
          await actions.setPermission(selection.mode, selection.operations);
        if (granted) completed = purpose === "publish" ? await actions.publishDefinition()
          : purpose === "activate" ? await actions.setActive(true) : true;
        if (!completed) dialog.querySelector(".automation-permission-feedback").textContent =
          actions.snapshot().error || "This action could not be completed.";
      }
      if (completed) dialog.close();
      else submit.disabled = false;
    });
    dialog.showModal();
  }

  const command = {
    ...createAutomationDraftRecoveryCommands({ actions, requireSavedGraph, confirmDiscard,
      onRestored: () => { definitionDirty = false; insertion = null; } }),
    ...createAutomationArchiveCommands({ actions, getCurrent: () => current, requireSavedGraph,
      confirmDiscard, onFilterChange: (archived) => { showArchived = archived; } }),
    "show-full-step-output": () => actions.showFullStepOutput(),
    refresh: () => actions.refresh(), create: () => actions.create(),
    describe: () => actions.openAuthoringChat(current.selectedAutomationId, current.draft?.revision),
    back: () => { if (prepareLeave()) return actions.openRoute("", ""); },
    "save-draft": saveDefinition,
    "edit-step": () => stepEditor.open(root.querySelector('[data-action="edit-step"]')),
    "toggle-details": () => { detailsCollapsed = !detailsCollapsed; updateDetailsVisibility(); },
    "delete-draft": async () => {
      if (!current.draft || current.publishedDefinition ||
          current.automations.find((item) => item.id === current.selectedAutomationId)?.publishedRevision) return;
      if (!confirmDiscard("Delete this unpublished automation draft and all its steps? This cannot be undone.")) return;
      if (await actions.deleteDraft()) { definitionDirty = false; insertion = null; }
    },
    "save-agent": () => { if (requireSavedGraph()) return actions.saveAgent(); },
    validate: () => { if (requireSavedGraph()) return actions.validate(); },
    publish: async () => {
      if (!requireSavedGraph() || !await actions.validate()) return;
      if (actions.snapshot().validation?.issues?.length) return;
      openPermissionDialog("publish");
    },
    run: () => { if (requireSavedGraph()) return actions.startRun(); },
    "toggle-active": () => current.automations.find((item) => item.id === current.selectedAutomationId)?.status === "active"
      ? actions.setActive(false) : openPermissionDialog("activate"),
    "show-runs": () => { if (prepareLeave()) return current.runs[0] ? actions.openRun(current.runs[0].id) : notify("No runs yet."); },
    editor: () => { if (prepareLeave()) return actions.openRoute(current.selectedAutomationId, ""); },
    stop: () => actions.stopRun(),
    rerun: () => current.run &&
      confirmDiscard(automationRerunConfirmation(current.run)) && actions.rerun(),
    "open-chat-run": () => actions.showChatRun(current.selectedRunId),
    "move-up": () => moveStep(-1), "move-down": () => moveStep(1),
    "move-to-slot": moveToSlot,
    parallel: wrapParallel, "remove-node": removeStep,
  };

  root.addEventListener("input", (event) => {
    if (event.target.matches("[data-tool-search]")) {
      paletteQuery = event.target.value;
      refreshToolPalette();
      return;
    }
    if (event.target.closest("[data-automation-definition-form]")) definitionDirty = true;
  });
  root.addEventListener("change", (event) => {
    if (event.target.closest("[data-automation-definition-form]")) definitionDirty = true;
  });
  root.addEventListener("click", (event) => {
    const element = event.target.closest("button");
    if (!element || !root.contains(element)) return;
    if (element.dataset.automationListFilter) {
      showArchived = element.dataset.automationListFilter === "archived";
      render(actions.snapshot());
      return;
    }
    if (element.dataset.automationLibraryTab) {
      void selectLibraryTab(element.dataset.automationLibraryTab);
      return;
    }
    if (element.dataset.action && command[element.dataset.action]) {
      void command[element.dataset.action]();
      return;
    }
    if (element.dataset.selectAutomation !== undefined) {
      if (prepareLeave()) void actions.openRoute(element.dataset.selectAutomation, "");
      return;
    }
    if (element.dataset.templateId !== undefined) {
      if (prepareLeave()) void actions.createTemplate(element.dataset.templateId);
      return;
    }
    if (element.dataset.selectRun !== undefined) {
      if (prepareLeave()) void actions.openRun(element.dataset.selectRun);
      return;
    }
    if (element.dataset.selectNode !== undefined || element.dataset.automationNode !== undefined) {
      if (!prepareLeave()) return;
      const nodeId = element.dataset.selectNode || element.dataset.automationNode || "";
      if (nodeId === current.selectedNodeId || !nodeId) { actions.selectNode(""); return; }
      const nodeButton = element.dataset.automationNode !== undefined ? element
        : [...root.querySelectorAll("[data-automation-node]")]
          .find((item) => item.dataset.automationNode === nodeId);
      if (element.dataset.selectNode !== undefined)
        nodeButton?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      actions.selectNode(nodeId);
      if (current.selectedRunId) focusSelectedAutomationStep(root);
      return;
    }
    if (element.dataset.insertParent !== undefined) {
      insertion = { parentSequenceId: element.dataset.insertParent, index: Number(element.dataset.insertIndex) };
      markInsertion();
      const moveButton = root.querySelector('[data-action="move-to-slot"]');
      moveButton.hidden = !current.selectedNodeId;
      (current.selectedNodeId ? moveButton : root.querySelector("[data-palette-agent]"))?.focus();
      return;
    }
    if (element.dataset.paletteSelectTool !== undefined) {
      paletteSelectedTool = paletteSelectedTool === element.dataset.paletteSelectTool
        ? "" : element.dataset.paletteSelectTool;
      const focusedTool = element.dataset.paletteSelectTool;
      refreshToolPalette();
      [...root.querySelectorAll("[data-palette-select-tool]")]
        .find((button) => button.dataset.paletteSelectTool === focusedTool)?.focus();
      return;
    }
    if (element.dataset.paletteAddTool !== undefined)
      void addPaletteStep({ kind: "tool", id: element.dataset.paletteAddTool });
    if (element.dataset.paletteAgent !== undefined) void addPaletteStep({ kind: "agent", id: element.dataset.paletteAgent });
  });
  root.addEventListener("wheel", (event) => {
    const viewport = event.target.closest("[data-camera-viewport]");
    if (!viewport || !root.contains(viewport) || event.shiftKey ||
        event.target.closest(".automation-inline-inspector-frame")) return;
    if (camera.wheel(event)) event.preventDefault();
  }, { passive: false });
  root.addEventListener("keydown", (event) => {
    const tab = event.target.closest("[data-automation-library-tab]");
    if (tab) {
      const next = automationLibraryTabForKey(event.key, tab.dataset.automationLibraryTab === "studio" ? 0 : 1);
      if (next) { event.preventDefault(); void selectLibraryTab(next, true); }
      return;
    }
    if (!event.target.closest("[data-camera-viewport]")) return;
    if (["input", "textarea", "select"].some((tag) => event.target.closest(tag))) return;
    if (camera.keyboard(event)) event.preventDefault();
  });
  root.addEventListener("pointerdown", (event) => {
    if (camera.startPan(event)) event.preventDefault();
  });
  root.addEventListener("pointermove", (event) => {
    if (camera.movePan(event)) event.preventDefault();
  });
  root.addEventListener("pointerup", (event) => camera.endPan(event));
  root.addEventListener("pointercancel", (event) => camera.endPan(event));
  root.addEventListener("dragstart", (event) => {
    const item = event.target.closest("[data-palette-tool], [data-palette-agent], [data-automation-node][draggable]");
    if (!item) return;
    const target = item.dataset.automationNode !== undefined
      ? { kind: "existing", id: item.dataset.automationNode }
      : item.dataset.paletteTool !== undefined
      ? { kind: "tool", id: item.dataset.paletteTool }
      : { kind: "agent", id: item.dataset.paletteAgent };
    event.dataTransfer?.setData(DRAG_TYPE, JSON.stringify(target));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
  });
  root.addEventListener("dragover", (event) => {
    const target = event.target.closest("[data-insert-parent]");
    if (!target || !event.dataTransfer?.types.includes(DRAG_TYPE)) return;
    event.preventDefault();
    target.dataset.dragOver = "true";
  });
  root.addEventListener("dragleave", (event) => {
    event.target.closest("[data-insert-parent]")?.removeAttribute("data-drag-over");
  });
  root.addEventListener("drop", (event) => {
    const target = event.target.closest("[data-insert-parent]");
    if (!target) return;
    event.preventDefault();
    target.removeAttribute("data-drag-over");
    try {
      const payload = JSON.parse(event.dataTransfer?.getData(DRAG_TYPE) || "null");
      const location = { parentSequenceId: target.dataset.insertParent, index: Number(target.dataset.insertIndex) };
      if (payload?.kind === "existing" && payload.id) {
        if (requireSavedGraph()) void actions.mutateDraft({ kind: "move_node", nodeId: payload.id, ...location });
      } else void addPaletteStep(payload, location);
    } catch { notify("This step cannot be added here."); }
  });

  render(current);
  return { render, prepareLeave, isDirty };
}
