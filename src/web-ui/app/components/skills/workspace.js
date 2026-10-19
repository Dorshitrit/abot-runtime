import { escapeAttribute, escapeHtml } from "../../lib/text-format.js";

/** Mounts the existing shell's navigation/panel contract without growing index.html. */
export function mountSkillsWorkspace(dom, documentRoot = document) {
  const button = documentRoot.createElement("button");
  button.id = "skillsWorkspaceButton";
  button.className = "rail-button";
  button.type = "button";
  button.setAttribute("aria-label", "Open Skills");
  button.setAttribute("aria-controls", "skillsWorkspacePanel");
  button.title = "Skills";
  button.innerHTML = `<span class="rail-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="18" rx="2" /><path d="m8 9 1 1 2-2m2 1h3m-8 6 1 1 2-2m2 1h3" /></svg></span><span class="rail-button-label">Skills</span>`;
  dom.memoryWorkspaceButton.after(button);
  const panel = documentRoot.createElement("section");
  panel.id = "skillsWorkspacePanel";
  panel.className = "workspace-page-panel skills-workspace-panel";
  panel.hidden = true;
  panel.inert = true;
  panel.setAttribute("aria-hidden", "true");
  panel.setAttribute("aria-labelledby", "skillsWorkspaceTitle");
  panel.innerHTML = `<header class="workspace-page-header"><div class="workspace-page-heading"><p class="eyebrow">Personal guidance</p><h2 id="skillsWorkspaceTitle">Skills</h2></div><button type="button" class="workspace-page-back" data-skills-close>Back to chat</button></header><div class="workspace-page-body" data-skills-root></div>`;
  dom.app.append(panel);
  Object.assign(dom, { skillsWorkspaceButton: button, skillsWorkspacePanel: panel,
    closeSkillsWorkspaceButton: panel.querySelector("[data-skills-close]"), skillsRoot: panel.querySelector("[data-skills-root]") });
}

export function renderSkillRows(snapshot) {
  const items = snapshot.items.filter((item) => item.source === "personal" && item.archived === snapshot.archived);
  if (!items.length) return `<p class="skills-empty">${snapshot.loading ? "Loading Skills…" : snapshot.archived ? "No archived Skills." : "No personal Skills yet. Create one here or ask ABot to help."}</p>`;
  return items.map((item) => `<button type="button" class="config-model-button skills-list-item" data-skill-id="${escapeAttribute(item.skillId)}" aria-pressed="${item.skillId === snapshot.skill?.skillId}"><strong dir="auto">${escapeHtml(item.name)}</strong><span dir="auto">${escapeHtml(item.description)}</span></button>`).join("");
}

export function createSkillsWorkspace({ root, actions, confirmArchive = (message) => window.confirm(message) }) {
  root.innerHTML = `<div class="config-dashboard skills-workspace-content"><div class="skills-toolbar"><div class="skills-filters" role="group" aria-label="Skill status"><button type="button" class="config-category-tab" data-skills-filter="active" aria-pressed="true">Active</button><button type="button" class="config-category-tab" data-skills-filter="archived" aria-pressed="false">Archived</button></div><div class="skills-toolbar-actions"><button type="button" data-skills-refresh>Refresh</button><button type="button" class="primary-button" data-skills-new>New Skill</button></div></div><p class="skills-intro">Personal Skills guide how ABot works. Built-in Skills are maintained by ABot.</p><p class="skills-feedback" role="alert" data-skills-error hidden></p><p class="skills-feedback" role="status" data-skills-message hidden></p><div class="skills-layout"><div class="skills-list" data-skills-list></div><section class="skills-detail" data-skills-detail><p class="skills-empty" data-skills-placeholder>Select a Skill to read or edit it.</p><form data-skills-form hidden><div data-skills-creation-fields hidden><h3>New Skill</h3><label class="skills-creation-label">Name<input type="text" data-skills-new-name maxlength="160" dir="auto" required disabled></label><label class="skills-creation-label">Description<textarea data-skills-new-description rows="3" maxlength="512" dir="auto" required disabled></textarea></label></div><div data-skills-saved-metadata><h3 dir="auto" data-skills-name></h3><p dir="auto" class="skills-description" data-skills-description></p><p class="skills-id">ID: <span dir="ltr" data-skills-id></span></p></div><label class="skills-content-label">Content<textarea data-skills-content rows="16" dir="auto" maxlength="65536" required></textarea></label><p class="skills-archived-note" data-skills-archived-note hidden>Archived Skills are unavailable to models. Restore this Skill to use or edit it.</p><div class="skills-editor-actions"><button class="primary-button" type="submit" data-skills-save>Save changes</button><button type="button" data-skills-cancel hidden>Cancel</button><button type="button" data-skills-reload>Reload saved</button><button type="button" data-skills-archive>Archive</button><button type="button" data-skills-restore hidden>Restore</button></div></form></section></div></div>`;
  const find = (selector) => root.querySelector(selector);
  const list = find("[data-skills-list]");
  const form = find("[data-skills-form]");
  const content = find("[data-skills-content]");
  const nameInput = find("[data-skills-new-name]");
  const descriptionInput = find("[data-skills-new-description]");
  let current;
  let listMarkup = "";
  root.addEventListener("click", (event) => {
    const selected = event.target.closest?.("[data-skill-id]");
    if (selected) void actions.select(selected.dataset.skillId);
    const filter = event.target.closest?.("[data-skills-filter]");
    if (filter) actions.setArchived(filter.dataset.skillsFilter === "archived");
    if (event.target.closest?.("[data-skills-new]")) actions.beginCreate();
    if (event.target.closest?.("[data-skills-cancel]")) actions.cancelCreate();
    if (event.target.closest?.("[data-skills-refresh]")) void actions.refresh();
    if (event.target.closest?.("[data-skills-reload]")) void actions.reloadSelected();
    if (event.target.closest?.("[data-skills-restore]")) void actions.restore();
    if (event.target.closest?.("[data-skills-archive]")) {
      const warning = current?.dirty ? " Unsaved edits will be discarded." : "";
      if (confirmArchive(`Archive this Skill? Models will no longer discover or read it.${warning}`)) void actions.archive();
    }
  });
  nameInput.addEventListener("input", () => actions.setCreationField("name", nameInput.value));
  descriptionInput.addEventListener("input", () => actions.setCreationField("description", descriptionInput.value));
  content.addEventListener("input", () => actions.setDraft(content.value));
  form.addEventListener("submit", (event) => { event.preventDefault(); void actions.save(); });
  function render(snapshot) {
    current = snapshot;
    const nextList = renderSkillRows(snapshot);
    if (nextList !== listMarkup) { list.innerHTML = nextList; listMarkup = nextList; }
    list.setAttribute("aria-busy", String(snapshot.loading));
    for (const button of root.querySelectorAll("[data-skills-filter]")) {
      const selected = (button.dataset.skillsFilter === "archived") === snapshot.archived;
      button.setAttribute("aria-pressed", String(selected));
      button.className = selected ? "config-category-tab active" : "config-category-tab";
      button.disabled = Boolean(snapshot.mutation);
    }
    for (const [selector, message] of [["[data-skills-error]", snapshot.error], ["[data-skills-message]", snapshot.message]]) {
      const element = find(selector); element.textContent = message; element.hidden = !message;
    }
    const skill = snapshot.skill;
    const creating = snapshot.creating === true;
    const editing = Boolean(skill) || creating;
    const archived = skill?.archived === true;
    const busy = Boolean(snapshot.mutation);
    find("[data-skills-new]").disabled = busy;
    const placeholder = find("[data-skills-placeholder]");
    placeholder.hidden = editing;
    placeholder.textContent = snapshot.reading ? "Loading Skill…" : "Select a Skill to read or edit it.";
    form.hidden = !editing;
    if (!editing) return;
    find("[data-skills-creation-fields]").hidden = !creating;
    find("[data-skills-saved-metadata]").hidden = creating;
    nameInput.disabled = !creating || busy;
    descriptionInput.disabled = !creating || busy;
    if (nameInput.value !== (snapshot.name || "")) nameInput.value = snapshot.name || "";
    if (descriptionInput.value !== (snapshot.description || "")) descriptionInput.value = snapshot.description || "";
    find("[data-skills-name]").textContent = skill?.name || "";
    find("[data-skills-description]").textContent = skill?.description || "";
    find("[data-skills-id]").textContent = skill?.skillId || "";
    if (content.value !== snapshot.draft) content.value = snapshot.draft;
    content.readOnly = archived;
    content.disabled = busy;
    find("[data-skills-archived-note]").hidden = !archived;
    find("[data-skills-save]").hidden = archived;
    find("[data-skills-save]").disabled = cannotSave(snapshot);
    const saveLabels = { create: "Creating…", save: "Saving…" };
    find("[data-skills-save]").textContent = saveLabels[snapshot.mutation] || (creating ? "Create Skill" : "Save changes");
    find("[data-skills-cancel]").hidden = !creating;
    find("[data-skills-reload]").hidden = creating;
    find("[data-skills-archive]").hidden = creating || archived;
    find("[data-skills-restore]").hidden = creating || !archived;
    for (const selector of ["[data-skills-cancel]", "[data-skills-reload]", "[data-skills-archive]", "[data-skills-restore]"])
      find(selector).disabled = busy;
  }
  return { render };
}

function cannotSave(snapshot) {
  if (snapshot.mutation || !snapshot.dirty || !snapshot.draft.trim()) return true;
  if (!snapshot.creating) return false;
  if (!snapshot.name.trim()) return true;
  return !snapshot.description.trim();
}
