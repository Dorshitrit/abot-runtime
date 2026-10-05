import { escapeHtml } from "../../lib/text-format.js";
import { listAvailableAutomationProducers } from "../../lib/automation-binding-producers.js";
import { findAutomationNode } from "./timeline.js";
import { workflowSteps } from "./run-steps-view.js";
import { renderAutomationToolIdentity } from "./tool-identity.js";
import { operationIdentity, readAutomationNodePatch, renderAutomationNodeInspector,
  renderAutomationToolInputs, updateAgentToolPicker } from "./node-inspector.js";
import { changeAutomationBindingKind, handleAutomationBindingClick,
  refreshAutomationInputNotice } from "./binding-editor.js";

function dialogMarkup(node, catalog, producers, steps) {
  const index = steps.findIndex((step) => step.id === node.id);
  return `<div class="automation-step-dialog-heading"><div><p>${node.kind === "agent" ? "Agent" : "Tool"} step</p>
    <h2 id="automation-step-dialog-title" dir="auto">${escapeHtml(node.title || "Edit step")}</h2>
    ${node.kind === "tool" ? `<div data-step-tool-identity>${renderAutomationToolIdentity(node.operation, catalog, { showPlugin: true })}</div>` : ""}</div>
    <div class="automation-step-dialog-navigation" role="group" aria-label="Navigate workflow steps">
      <button type="button" data-step-direction="-1" aria-label="Previous step" title="Previous step"${index <= 0 ? " disabled" : ""}><span aria-hidden="true">←</span></button>
      <span class="automation-step-position" aria-live="polite" aria-label="Step ${index + 1} of ${steps.length}">${index + 1} / ${steps.length}</span>
      <button type="button" data-step-direction="1" aria-label="Next step" title="Next step"${index >= steps.length - 1 ? " disabled" : ""}><span aria-hidden="true">→</span></button>
      <button type="button" class="automation-text-button" data-step-close aria-label="Close step editor">Close</button></div></div>
    <p class="automation-step-dialog-feedback" role="status" aria-live="polite"></p>
    <section class="automation-step-discard" data-step-discard hidden aria-label="Unsaved step changes">
      <p>Save your changes before closing?</p><div class="automation-actions">
      <button type="button" data-step-save data-step-guard-save>Save changes</button><button type="button" data-step-discard-confirm>Discard</button>
      <button type="button" data-step-keep>Keep editing</button></div></section>
    <div class="automation-step-dialog-content automation-inspector">${renderAutomationNodeInspector(node, catalog, null, producers, { dialog: true })}</div>
    <div class="automation-step-dialog-footer"><span>Changes are saved to the draft. Publishing is separate.</span>
      <div class="automation-actions"><button type="button" data-step-close>Cancel</button>
      <button type="button" class="automation-primary" data-step-save>Save step</button></div></div>`;
}

/** Own the editable DOM outside the live timeline; refreshes never replace it. */
export function createAutomationStepEditorDialog({ root, actions, documentRoot, onAction }) {
  let active = null;

  function sameContext(entry, snapshot = actions.snapshot()) {
    return snapshot.selectedAutomationId === entry.automationId && !snapshot.selectedRunId &&
      snapshot.selectedNodeId === entry.node.id &&
      (actions.navigationRevision?.() || 0) === entry.navigationRevision;
  }

  function feedback(entry, message) {
    entry.dialog.querySelector(".automation-step-dialog-feedback").textContent = message;
  }

  function close() {
    const entry = active;
    if (!entry) return;
    active = null;
    entry.dialog.close();
    entry.dialog.remove();
    const trigger = root.contains(entry.trigger) ? entry.trigger :
      [...root.querySelectorAll("[data-automation-node]")].find((item) => item.dataset.automationNode === entry.node.id);
    trigger?.focus({ preventScroll: true });
  }

  function requestClose() {
    return requestTransition(null);
  }

  function requestTransition(target) {
    const entry = active;
    if (!entry) return true;
    if (entry.saving) return false;
    if (!entry.dirty) return finishTransition(entry, target);
    entry.pending = target;
    const guard = entry.dialog.querySelector("[data-step-discard]");
    guard.hidden = false;
    guard.querySelector("p").textContent = target ? "Save your changes before moving to another step?" : "Save your changes before closing?";
    guard.querySelector("[data-step-guard-save]").textContent = target ? "Save & continue" : "Save changes";
    guard.querySelector("[data-step-discard-confirm]").textContent = target ? "Discard & continue" : "Discard";
    guard.querySelector("[data-step-keep]").focus({ preventScroll: true });
    return false;
  }

  function makeEntry(snapshot, node, dialog, trigger) {
    return { dialog, trigger, node, catalog: snapshot.catalog || {},
      producers: listAvailableAutomationProducers(snapshot.draft.definition.body, node.id),
      automationId: snapshot.selectedAutomationId, revision: snapshot.draft.revision,
      navigationRevision: actions.navigationRevision?.() || 0, dirty: false, saving: false, pending: null };
  }

  function finishTransition(entry, target) {
    if (!target) { close(); return true; }
    const snapshot = actions.snapshot();
    const steps = workflowSteps(snapshot.draft?.definition?.body);
    const node = steps.find((step) => step.id === target.nodeId);
    if (!sameContext(entry, snapshot) || snapshot.draft?.revision !== entry.revision || !node) {
      feedback(entry, "The draft changed. Keep your changes here, or close and reopen before moving to another step.");
      return false;
    }
    const next = makeEntry(snapshot, node, entry.dialog, null);
    active = next;
    actions.selectNode(node.id);
    if (active !== next) return false;
    entry.dialog.innerHTML = dialogMarkup(node, next.catalog, next.producers, steps);
    entry.dialog.querySelector(".automation-step-dialog-content").scrollTop = 0;
    const arrow = entry.dialog.querySelector(`[data-step-direction="${target.direction}"]`);
    (arrow?.disabled ? entry.dialog.querySelector('[name="title"]') : arrow)?.focus({ preventScroll: true });
    return true;
  }

  function requestStep(direction) {
    const entry = active, snapshot = actions.snapshot();
    if (!entry || entry.saving) return;
    if (!sameContext(entry, snapshot) || snapshot.draft?.revision !== entry.revision) {
      feedback(entry, "The draft changed. Close and reopen this step before navigating.");
      return;
    }
    const steps = workflowSteps(snapshot.draft?.definition?.body);
    const index = steps.findIndex((step) => step.id === entry.node.id);
    const next = steps[index + direction];
    if (index < 0 || !next) return;
    requestTransition({ nodeId: next.id, direction });
  }

  function setSaving(entry, saving) {
    entry.saving = saving;
    entry.dialog.querySelector("form").inert = saving;
    const steps = workflowSteps(actions.snapshot().draft?.definition?.body);
    const index = steps.findIndex((node) => node.id === entry.node.id);
    for (const button of entry.dialog.querySelectorAll("button")) {
      const unavailableDirection = button.hasAttribute("data-step-direction") &&
        (index < 0 || !steps[index + Number(button.dataset.stepDirection)]);
      button.disabled = saving || unavailableDirection;
    }
    entry.dialog.setAttribute("aria-busy", String(saving));
  }

  async function save() {
    const entry = active;
    if (!entry || entry.saving) return false;
    const snapshot = actions.snapshot();
    if (!sameContext(entry, snapshot)) { close(); return false; }
    if (snapshot.draft?.revision !== entry.revision) {
      feedback(entry, "The draft changed while you were editing. Copy your changes, then close and reopen this step before saving.");
      return false;
    }
    const form = entry.dialog.querySelector("form");
    if (!form.reportValidity()) return false;
    try {
      const patch = readAutomationNodePatch(form, entry.node, entry.catalog);
      setSaving(entry, true);
      const saved = await actions.saveNode(entry.node.id, patch);
      if (active !== entry || !sameContext(entry)) return false;
      if (saved) {
        entry.dirty = false;
        entry.revision = actions.snapshot().draft?.revision;
        setSaving(entry, false);
        return finishTransition(entry, entry.pending);
      }
      feedback(entry, actions.snapshot().error || "The step could not be saved. Your changes are still here.");
    } catch (error) {
      if (active === entry) feedback(entry, error.message || "The step could not be saved.");
    } finally {
      if (active === entry) setSaving(entry, false);
    }
    return false;
  }

  function updateFields(entry, event) {
    const target = event.target;
    const form = entry.dialog.querySelector("form");
    if (target.matches("[data-agent-tool-search]")) { updateAgentToolPicker(form); return; }
    if (!form.contains(target) || entry.saving) return;
    entry.dirty = true;
    if (target.matches("[data-agent-tool]")) updateAgentToolPicker(form);
    if (event.type === "change" && target.matches('[name="toolOperation"]')) {
      const operations = entry.catalog?.grantableOperations || entry.catalog?.operations || [];
      const operation = operations.find((item) => operationIdentity(item) === target.value);
      form.querySelector("[data-automation-tool-inputs]").innerHTML =
        renderAutomationToolInputs(operation, {}, undefined, entry.producers);
      entry.dialog.querySelector("[data-step-tool-identity]").innerHTML = renderAutomationToolIdentity(
        operation || { ...entry.node.operation, operationId: "" }, entry.catalog, { showPlugin: true });
    }
    if (event.type === "change" && target.matches("[data-binding-kind]"))
      changeAutomationBindingKind(target, entry.producers, documentRoot);
    refreshAutomationInputNotice(form);
  }

  async function command(entry, element) {
    if (entry.saving) return;
    if (element.hasAttribute("data-step-direction")) { requestStep(Number(element.dataset.stepDirection)); return; }
    if (element.hasAttribute("data-step-close")) { requestClose(); return; }
    if (element.hasAttribute("data-step-save")) { await save(); return; }
    if (element.hasAttribute("data-step-discard-confirm")) { finishTransition(entry, entry.pending); return; }
    if (element.hasAttribute("data-step-keep")) {
      entry.dialog.querySelector("[data-step-discard]").hidden = true;
      entry.pending = null;
      entry.dialog.querySelector('[name="title"]').focus();
      return;
    }
    if (handleAutomationBindingClick(element, entry.producers, documentRoot)) { entry.dirty = true; return; }
    if (!element.dataset.action) return;
    if (entry.dirty) { feedback(entry, "Save the step before changing its position or saving an agent template."); return; }
    if (!sameContext(entry) || actions.snapshot().draft?.revision !== entry.revision) {
      feedback(entry, "The draft changed. Close and reopen this step to continue.");
      return;
    }
    await onAction(element.dataset.action);
    if (active !== entry) return;
    if (actions.snapshot().draft?.revision !== entry.revision) { close(); return; }
    feedback(entry, actions.snapshot().error || actions.snapshot().feedback || "");
  }

  function open(trigger) {
    if (active) { active.dialog.querySelector('[name="title"]').focus(); return; }
    const snapshot = actions.snapshot();
    const node = findAutomationNode(snapshot.draft?.definition?.body, snapshot.selectedNodeId);
    const archived = snapshot.draft?.archivedAt || snapshot.automations?.some((item) =>
      item.id === snapshot.selectedAutomationId && item.status === "archived");
    if (!node || !["agent", "tool"].includes(node.kind) || snapshot.selectedRunId || archived) return;
    const dialog = documentRoot.createElement("dialog");
    dialog.className = "automation-step-dialog";
    dialog.setAttribute("aria-labelledby", "automation-step-dialog-title");
    const entry = makeEntry(snapshot, node, dialog, trigger);
    dialog.innerHTML = dialogMarkup(node, entry.catalog, entry.producers, workflowSteps(snapshot.draft.definition.body));
    active = entry;
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); requestClose(); });
    dialog.addEventListener("input", (event) => { if (active?.dialog === dialog) updateFields(active, event); });
    dialog.addEventListener("change", (event) => { if (active?.dialog === dialog) updateFields(active, event); });
    dialog.addEventListener("click", (event) => {
      const element = event.target.closest("button");
      if (element && dialog.contains(element) && active?.dialog === dialog) void command(active, element);
    });
    dialog.addEventListener("submit", (event) => { event.preventDefault(); void save(); });
    documentRoot.body.append(dialog);
    dialog.showModal();
    dialog.querySelector('[name="title"]').focus({ preventScroll: true });
  }

  function sync(snapshot) {
    if (!active) return;
    if (!sameContext(active, snapshot) || !findAutomationNode(snapshot.draft?.definition?.body, active.node.id)) {
      close();
      return;
    }
    if (!active.saving && snapshot.draft.revision !== active.revision)
      feedback(active, "The draft changed while you were editing. Your unsaved changes are preserved here; close and reopen before saving.");
  }

  return { open, sync, prepareLeave: requestClose, isDirty: () => Boolean(active?.dirty), isOpen: () => Boolean(active) };
}
