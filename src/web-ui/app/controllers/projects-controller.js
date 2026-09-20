function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function createProjectsController({
  client,
  getEnvironmentId,
  getConversationRevision,
  prepareConversation,
  openSession,
  loadSessions,
  onChange,
  notify,
  onSessionCreated = () => {},
}) {
  let revision = 0;
  let currentEnvironment = getEnvironmentId();
  let browseRevision = 0;
  let listRevision = 0;
  let activationRevision = 0;
  let state = {
    projects: [],
    loading: false,
    error: "",
    draft: null,
    busyProjectId: "",
  };
  const snapshot = () => state;
  const publish = () => onChange(snapshot());
  const isCurrentEnvironment = (environmentId, token) =>
    environmentId === getEnvironmentId() && token === revision;
  const hasCurrentDraft = (environmentId, token, draft) =>
    isCurrentEnvironment(environmentId, token) && state.draft === draft;

  function canApplyProjectList(environmentId, token, listToken) {
    if (!isCurrentEnvironment(environmentId, token)) return false;
    return listToken === listRevision;
  }

  function canApplyFolderListing(environmentId, token, draft) {
    if (state.draft !== draft) return false;
    if (token !== browseRevision) return false;
    if (!draft.pickerOpen) return false;
    return environmentId === getEnvironmentId();
  }

  function canEditProjectDraft(draft) {
    if (!draft) return false;
    return !draft.saving;
  }

  function canCreateProject(draft) {
    if (!canEditProjectDraft(draft)) return false;
    if (draft.pickerOpen) return false;
    return !draft.loading;
  }

  function canBrowseProjectFolders(draft) {
    if (!canEditProjectDraft(draft)) return false;
    return draft.pickerOpen;
  }

  function canSelectProjectFolder(draft) {
    if (!canBrowseProjectFolders(draft)) return false;
    if (draft.loading) return false;
    if (draft.error) return false;
    return Boolean(draft.listing?.directory);
  }

  function isProjectDraftField(field) {
    return ["name", "directory"].includes(field);
  }

  async function load() {
    const environmentId = getEnvironmentId();
    currentEnvironment = environmentId;
    const token = revision;
    const listToken = ++listRevision;
    state = { ...state, loading: true, error: "" };
    publish();
    if (!client.supportsProjects()) {
      state = { ...state, projects: [], loading: false };
      publish();
      return;
    }
    try {
      const result = await client.listProjects(environmentId);
      if (!canApplyProjectList(environmentId, token, listToken)) return;
      state = { ...state, projects: result.projects ?? [], loading: false };
    } catch (error) {
      if (!canApplyProjectList(environmentId, token, listToken)) return;
      state = { ...state, loading: false, error: errorMessage(error) };
    }
    publish();
  }

  function closeCreate() {
    activationRevision += 1;
    browseRevision += 1;
    state = { ...state, draft: null };
    publish();
    return true;
  }

  async function browse(directory = "", cursor = "") {
    const draft = state.draft;
    if (!canBrowseProjectFolders(draft)) return;
    const token = ++browseRevision;
    const environmentId = getEnvironmentId();
    draft.loading = true;
    draft.error = "";
    if (!cursor) draft.listing = null;
    publish();
    try {
      const result = await client.browseProjectFolders(
        directory,
        cursor,
        environmentId,
      );
      if (!canApplyFolderListing(environmentId, token, draft)) return;
      const entries = cursor
        ? [...(draft.listing?.entries ?? []), ...result.entries]
        : result.entries;
      draft.listing = { ...result, entries };
    } catch (error) {
      if (!canApplyFolderListing(environmentId, token, draft)) return;
      draft.error = errorMessage(error);
    }
    draft.loading = false;
    publish();
  }

  function openFolderPicker() {
    const draft = state.draft;
    if (!canEditProjectDraft(draft)) return Promise.resolve();
    draft.pickerOpen = true;
    return browse(draft.directory);
  }

  function cancelFolderPicker() {
    const draft = state.draft;
    if (!canEditProjectDraft(draft)) return;
    browseRevision += 1;
    draft.pickerOpen = false;
    draft.loading = false;
    draft.listing = null;
    draft.error = "";
    publish();
  }

  function selectFolder() {
    const draft = state.draft;
    if (!canSelectProjectFolder(draft)) return;
    draft.directory = draft.listing.directory;
    cancelFolderPicker();
  }

  function openCreate() {
    activationRevision += 1;
    state = {
      ...state,
      draft: {
        name: "",
        directory: "",
        pickerOpen: false,
        listing: null,
        loading: false,
        saving: false,
        error: "",
      },
    };
    publish();
  }

  function updateDraft(field, value) {
    if (!canEditProjectDraft(state.draft)) return;
    if (!isProjectDraftField(field)) return;
    state.draft[field] = value;
    if (field !== "directory") return;
    cancelFolderPicker();
  }

  async function create() {
    const draft = state.draft;
    if (!canCreateProject(draft)) return;
    const environmentId = getEnvironmentId();
    const token = revision;
    draft.saving = true;
    draft.error = "";
    publish();
    try {
      const result = await client.createProject(
        { name: draft.name.trim(), directory: draft.directory.trim() },
        environmentId,
      );
      if (!hasCurrentDraft(environmentId, token, draft)) return;
      const project = result.project;
      listRevision += 1;
      state.loading = false;
      state.projects = [
        ...state.projects.filter((entry) => entry.id !== project.id),
        project,
      ];
      draft.saving = false;
      closeCreate();
      await newConversation(project.id);
    } catch (error) {
      if (!hasCurrentDraft(environmentId, token, draft)) return;
      draft.saving = false;
      draft.error = errorMessage(error);
      publish();
    }
  }

  async function newConversation(projectId) {
    if (state.busyProjectId) return;
    if (!prepareConversation()) return;
    const environmentId = getEnvironmentId();
    const token = revision;
    const conversationRevision = getConversationRevision();
    const activationToken = ++activationRevision;
    state = { ...state, busyProjectId: projectId };
    publish();
    try {
      const result = await client.createProjectSession(
        projectId,
        environmentId,
      );
      onSessionCreated(result.sessionId);
      if (!isCurrentEnvironment(environmentId, token)) return;
      await loadSessions();
      if (!isCurrentEnvironment(environmentId, token)) return;
      if (activationToken !== activationRevision) return;
      if (getConversationRevision() !== conversationRevision) return;
      await openSession(result.sessionId);
    } catch (error) {
      if (isCurrentEnvironment(environmentId, token))
        notify(errorMessage(error), "failed");
    } finally {
      if (isCurrentEnvironment(environmentId, token)) {
        state = { ...state, busyProjectId: "" };
        publish();
      }
    }
  }

  function environmentChanged() {
    if (currentEnvironment === getEnvironmentId()) return Promise.resolve();
    currentEnvironment = getEnvironmentId();
    revision += 1;
    listRevision += 1;
    browseRevision += 1;
    state = {
      projects: [],
      loading: false,
      error: "",
      draft: null,
      busyProjectId: "",
    };
    publish();
    return load();
  }

  return {
    snapshot,
    load,
    environmentChanged,
    openCreate,
    closeCreate,
    updateDraft,
    openFolderPicker,
    cancelFolderPicker,
    selectFolder,
    browse,
    create,
    newConversation,
  };
}
