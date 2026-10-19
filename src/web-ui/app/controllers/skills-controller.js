/** Owns personal Skill drafts and environment-bound reads/mutations. */
export function createSkillsController({ client, getEnvironmentId, render,
  confirmDiscard = (message) => window.confirm(message) }) {
  const state = { items: [], skill: null, draft: "", archived: false, creating: false, name: "", description: "",
    loading: false, reading: false, mutation: "", error: "", message: "" };
  let epoch = 0;
  let listRead = 0;
  let detailRead = 0;
  let draftRevision = 0;
  let active = false;
  const snapshot = () => ({ ...state, items: [...state.items], dirty: isDirty() });
  const publish = () => render(snapshot());
  function isDirty() {
    if (state.creating) return Boolean(state.name || state.description || state.draft);
    return Boolean(state.skill && state.draft !== state.skill.content);
  }
  const capture = () => ({ epoch, environmentId: getEnvironmentId() });
  function isCurrent(scope) {
    if (scope.epoch !== epoch) return false;
    return scope.environmentId === getEnvironmentId();
  }
  function clearEditor() {
    detailRead += 1;
    draftRevision += 1;
    state.skill = null;
    state.creating = false;
    state.name = "";
    state.description = "";
    state.draft = "";
    state.reading = false;
  }
  function canEdit() {
    if (state.mutation || state.reading) return false;
    if (state.creating) return true;
    if (!state.skill || state.skill.archived) return false;
    return state.skill.source === "personal";
  }
  function prepareLeave() {
    if (state.mutation) return false;
    if (!isDirty()) return true;
    if (!confirmDiscard("Discard unsaved Skill changes?")) return false;
    const revision = draftRevision;
    const scope = capture();
    const commit = () => {
      if (!commit.canCommit()) return;
      if (state.creating) clearEditor();
      else { state.draft = state.skill.content; draftRevision += 1; }
      publish();
    };
    commit.canCommit = () => isCurrent(scope) && revision === draftRevision;
    return commit;
  }
  function acceptLeave() {
    const prepared = prepareLeave();
    if (prepared === false) return false;
    if (typeof prepared === "function") prepared();
    return true;
  }
  async function refresh() {
    if (!client.supportsSkills()) return;
    const scope = capture();
    const read = ++listRead;
    state.loading = true;
    publish();
    try {
      const result = await client.listPersonalSkills(scope.environmentId);
      if (!isCurrent(scope) || read !== listRead) return;
      state.items = result.items.filter((item) => item.source === "personal");
    } catch (error) {
      if (!isCurrent(scope) || read !== listRead) return;
      state.error = error.message || String(error);
    } finally {
      if (isCurrent(scope) && read === listRead) { state.loading = false; publish(); }
    }
  }
  async function select(skillId) {
    if (state.skill?.skillId === skillId) return true;
    if (!acceptLeave()) return false;
    if (!state.items.some((item) => item.skillId === skillId)) return false;
    return loadSkill(skillId);
  }
  async function loadSkill(skillId) {
    const scope = capture();
    clearEditor();
    const read = detailRead;
    state.error = "";
    state.message = "";
    state.reading = true;
    publish();
    try {
      const { skill } = await client.readPersonalSkill(skillId, scope.environmentId);
      if (!isCurrent(scope) || read !== detailRead) return false;
      if (skill.source !== "personal" || skill.skillId !== skillId) throw new Error("This personal Skill is unavailable.");
      state.skill = skill;
      state.draft = skill.content;
      draftRevision += 1;
      return true;
    } catch (error) {
      if (isCurrent(scope) && read === detailRead) state.error = error.message || String(error);
      return false;
    } finally {
      if (isCurrent(scope) && read === detailRead) { state.reading = false; publish(); }
    }
  }
  function setDraft(content) {
    if (!canEdit()) return;
    state.draft = content;
    draftRevision += 1;
    state.message = "";
    publish();
  }
  function beginCreate() {
    if (!acceptLeave()) return false;
    clearEditor();
    Object.assign(state, { creating: true, archived: false, error: "", message: "" });
    publish();
    return true;
  }
  function setCreationField(field, value) {
    if (!state.creating || !canEdit()) return;
    if (field !== "name" && field !== "description") return;
    state[field] = value;
    draftRevision += 1;
    state.message = "";
    publish();
  }
  function cancelCreate() {
    if (!state.creating || !acceptLeave()) return false;
    clearEditor();
    state.error = "";
    publish();
    return true;
  }
  function creationValidationMessage() {
    if (!state.name.trim() || state.name.length > 160) return "Enter a name of up to 160 characters.";
    if (!state.description.trim() || state.description.length > 512) return "Enter a description of up to 512 characters.";
    if (!state.draft.trim()) return "Enter the Skill content.";
    if (new TextEncoder().encode(state.draft).length > 65_536) return "Skill content must be no larger than 64 KiB.";
    return "";
  }
  async function create() {
    if (!state.creating || !canEdit()) return false;
    state.error = creationValidationMessage();
    if (state.error) { publish(); return false; }
    const scope = capture();
    const input = { name: state.name, description: state.description, content: state.draft };
    state.mutation = "create";
    state.message = "";
    publish();
    try {
      const { skill } = await client.createPersonalSkill(input, scope.environmentId);
      if (!isCurrent(scope)) return false;
      clearEditor();
      Object.assign(state, { skill, draft: skill.content, archived: false, message: "Skill created." });
      state.items = [...state.items.filter((item) => item.skillId !== skill.skillId), skill];
      await refresh();
      return true;
    } catch (error) {
      if (!isCurrent(scope)) return false;
      state.error = error.message || String(error);
      return false;
    } finally {
      if (isCurrent(scope)) { state.mutation = ""; publish(); }
    }
  }
  function setArchived(archived) {
    if (state.archived === archived) return true;
    if (!acceptLeave()) return false;
    state.archived = archived;
    state.error = "";
    state.message = "";
    clearEditor();
    publish();
    return true;
  }
  async function reloadSelected() {
    if (!state.skill || !acceptLeave()) return false;
    return loadSkill(state.skill.skillId);
  }
  async function mutate(action) {
    const skill = state.skill;
    if (!skill || skill.source !== "personal" || state.mutation || state.reading) return false;
    if (action === "save" && (!canEdit() || !isDirty() || !state.draft.trim())) return false;
    if (action === "archive" && skill.archived) return false;
    if (action === "restore" && !skill.archived) return false;
    const scope = capture();
    const content = state.draft;
    state.mutation = action;
    state.error = "";
    state.message = "";
    publish();
    try {
      const mutations = {
        save: () => client.updatePersonalSkill(skill.skillId, content, skill.revision, scope.environmentId),
        archive: () => client.archivePersonalSkill(skill.skillId, skill.revision, scope.environmentId),
        restore: () => client.restorePersonalSkill(skill.skillId, skill.revision, scope.environmentId),
      };
      const result = await mutations[action]();
      if (!isCurrent(scope)) return false;
      if (action === "save") {
        state.skill = result.skill;
        state.draft = result.skill.content;
        draftRevision += 1;
      } else {
        clearEditor();
      }
      state.message = { save: "Skill saved.", archive: "Skill archived.", restore: "Skill restored." }[action];
      await refresh();
      return true;
    } catch (error) {
      if (!isCurrent(scope)) return false;
      state.error = error.code === "knowledge_skill_revision_conflict"
        ? "This Skill changed elsewhere. Your draft is kept. Copy it before reloading the latest version."
        : error.message || String(error);
      return false;
    } finally {
      if (isCurrent(scope)) { state.mutation = ""; publish(); }
    }
  }
  function environmentChanged() {
    epoch += 1;
    listRead += 1;
    clearEditor();
    Object.assign(state, { items: [], archived: false, loading: false, mutation: "", error: "", message: "" });
    publish();
    if (active) void refresh();
  }
  function setActive(value) {
    const entering = value && !active;
    active = value;
    if (entering) void refresh();
  }
  return { snapshot, refresh, select, setDraft, setArchived, reloadSelected, prepareLeave,
    isDirty, environmentChanged, setActive, beginCreate, setCreationField, cancelCreate,
    save: () => state.creating ? create() : mutate("save"),
    archive: () => mutate("archive"), restore: () => mutate("restore") };
}
