import { createAgentDeletion } from "./deletion-controller.js";
import { agentResponseStatus } from "./response-status.js";
import { createSessionInspector } from "./session-inspector.js";
import { createAgentDraftMigration } from "./draft-migration-dialog.js";
import { isLegacyCoordinatorDraftConflict } from "./legacy-coordinator-drafts.js";
import { createAgentSchedules } from "./schedule-controller.js";
import { createAgentRecovery, pausedAgentChatBlock } from "./recovery.js";
import { createAgentDrafts } from "./drafts.js";
import { createAgentWizard } from "./wizard-controller.js";

export function createAgentsWorkspaceController({ client, view, storage, getEnvironmentId, onNavigationChange = () => {}, onHome = () => {}, viewport = window, documentRoot = document }) {
  let migration = null;
  const drafts = createAgentDrafts(storage, { onConflict: (error) => migration?.conflict(error) });
  let environment = "", revision = 0, selected = "", detail = null, models = [], active = false, generation = 0, timer = 0, loading = false;
  let selectionVersion = 0, backdropPress = null, catalogEpoch = 0;
  let catalogIds = new Set();
  const submissions = new Map();
  const chats = new Map();
  let windowSerial = 0;
  const submissionKey = (scope) => JSON.stringify([scope.environment, scope.selected]);
  const getScope = (id = selected) => ({ environment, selected: id, generation, selectionVersion, windowToken: chats.get(id)?.token });
  const windowIsCurrent = scope => scopeIsCurrent(scope) && chats.get(scope.selected)?.token === scope.windowToken && Boolean(scope.windowToken);
  const chatView = scope => view.forWindow(scope.selected);
  const scopeIsCurrent = (scope) => scope.environment === environment && scope.environment === getEnvironmentId() && scope.generation === generation;
  const selectedScopeIsCurrent = (scope) => scopeIsCurrent(scope) && scope.selected === selected && scope.selectionVersion === selectionVersion;
  const wizard = createAgentWizard({ client, drafts, view, getScope, getModels: () => models, getRevision: () => revision,
    async onSaved(id) { await refresh(); if (id) await select(id); } });
  const deletion = createAgentDeletion({ client, view, drafts,
    isCurrent: scope => active && selectedScopeIsCurrent(scope),
    async onRemoved(id, scope, cleanupFailed) {
      submissions.delete(submissionKey({ environment: scope.environment, selected: id }));
      if (!scopeIsCurrent(scope)) return;
      const restoreFocus = selectedScopeIsCurrent(scope) && active;
      if (wizard.editingId() === id) wizard.reset();
      if (selected === id) await select("");
      if (restoreFocus) view.archive(false);
      await refresh(true);
      if (restoreFocus && !selected) view.query('[data-agents-action="create"]').focus();
      if (cleanupFailed) view.error("Agent deleted. Refresh the workspace to reload saved drafts.", false);
    },
  });
  const inspector = createSessionInspector({ client, view, getScope });
  const recovery = createAgentRecovery({ client, view, drafts, getScope, act: action });
  const schedules = createAgentSchedules({ client, drafts, view, getScope, viewport });
  migration = createAgentDraftMigration({ drafts, view, getScope, async onResolved() {
    wizard.reset(); schedules.close(); recovery.close();
    const scope = getScope();
    if (windowIsCurrent(scope)) chatView(scope).draft(drafts.read(scope.environment, scope.selected));
    await select(selected);
  } });
  function reschedule() {
    viewport.clearTimeout(timer); timer = 0;
    if (active && !documentRoot.hidden) timer = viewport.setTimeout(() => void refresh(), 2000);
  }
  async function loadModels() {
    const scope = getScope();
    const result = await client.listModels(scope.environment);
    if (!scopeIsCurrent(scope)) return false;
    models = result.profiles || result.models || [];
    return true;
  }
  async function refresh(force = false) {
    if (!active || !client.supportsAgents?.() || !environment) return;
    if (loading && !force) return;
    const epoch = ++catalogEpoch;
    const scope = getScope(); loading = true;
    const current = () => epoch === catalogEpoch && scopeIsCurrent(scope);
    try {
      const result = await client.listAgents(environment);
      if (!current()) return;
      revision = result.revision;
      const agents = result.agents || [];
      const nextIds = new Set(agents.map(agent => agent.id));
      const removedSelection = selected && catalogIds.has(selected) && !nextIds.has(selected);
      catalogIds = nextIds;
      view.renderCatalog(agents); view.error("", false);
      if (removedSelection) {
        if (wizard.editingId() === selected) wizard.reset();
        await select("");
      }
      for (const id of [...chats.keys()]) if (!nextIds.has(id)) closeWindow(id);
      await Promise.all([...chats.keys()].map(id => loadDetail(getScope(id))));
    } catch (error) { if (current()) view.error(error.message, false); }
    finally { if (current()) { loading = false; reschedule(); } }
  }
  function syncResponseStatus(scope = getScope()) {
    if(!windowIsCurrent(scope)) return;
    const node=chatView(scope).query('[data-agents-response-status]');
    const text=agentResponseStatus(chats.get(scope.selected).detail,submissions.get(submissionKey(scope)));
    if(node && node.textContent!==text) node.textContent=text;
  }
  function showDetail(result, scope=getScope()) {
    if(!windowIsCurrent(scope)) return;
    chats.get(scope.selected).detail=result;
    if(selected === scope.selected) { detail=result; recovery.sync(result); }
    chatView(scope).renderDetail(result); syncResponseStatus(scope);
  }
  async function loadDetail(scope) {
    if(!windowIsCurrent(scope)) return;
    const entry=chats.get(scope.selected);
    if(entry.loading) return;
    entry.loading=true;
    const epoch=++entry.epoch;
    const current=()=>windowIsCurrent(scope) && entry.epoch===epoch;
    const pane=chatView(scope);
    try {
      const result=await client.getAgent(scope.selected,scope.environment);
      if(!current()) return;
      showDetail(result,scope); pane.error(''); pane.recovered(drafts.recovered(scope.environment,scope.selected).length);
      const draft=drafts.read(scope.environment,scope.selected);
      if(draft.pendingId && result.messages?.some(message=>message.id===draft.pendingId || message.clientMessageId===draft.pendingId)) {
        await drafts.write(scope.environment,scope.selected,{});
        if(current()) pane.draft(drafts.read(scope.environment,scope.selected));
      }
      if(!current()) return;
      const through=result.latestVisibleReplyId;
      // Only the focused window can acknowledge visibility; another floating window may cover it.
      if(through && through!==entry.lastRead && selectedScopeIsCurrent(scope) && active && !documentRoot.hidden && documentRoot.hasFocus() && pane.isAttentionVisible(through,result)) {
        try { await client.readAgentReplies(scope.selected,through,scope.environment); if(current()) entry.lastRead=through; } catch { /* retry next poll */ }
      }
      if(current() && selectedScopeIsCurrent(scope)) await inspector.refresh(result);
    } catch(error) { if(current()) pane.error(error.message); }
    finally { entry.loading=false; }
  }
  function activate(id) {
    if(id===selected) { view.raiseWindow(id); return; }
    recovery.close(); inspector.close(); schedules.close();
    selectionVersion+=1; selected=id||''; detail=chats.get(selected)?.detail || null;
    view.select(selected); onNavigationChange();
  }
  function closeWindow(id) {
    if(!chats.has(id)) return;
    if(selected===id) activate('');
    chats.delete(id); view.closeWindow(id);
    if(!selected && chats.size) activate([...chats.keys()].at(-1));
  }
  async function select(id) {
    if(wizard.active() || schedules.active() || migration.active()) return;
    if(!id) { closeWindow(selected); return; }
    const fresh=!chats.has(id);
    if(fresh) chats.set(id,{token:++windowSerial,detail:null,epoch:0,lastRead:'',loading:false});
    activate(id);
    const scope=getScope(), pane=chatView(scope);
    pane.busy(submissions.has(submissionKey(scope)));
    if(fresh) pane.draft(drafts.read(environment,id));
    syncResponseStatus(scope);
    await loadDetail(scope);
    if(selectedScopeIsCurrent(scope) && windowIsCurrent(scope)) pane.focusComposer();
  }
  async function persistComposer(scope = getScope()) {
    if (!windowIsCurrent(scope)) return;
    const old = drafts.read(scope.environment, scope.selected);
    const text = chatView(scope).query('textarea[name="message"]').value;
    // A receipt binds text and intent together. Keep an untouched legacy draft's choice, too.
    if (old.pendingId || old.text === text) return;
    await drafts.write(scope.environment, scope.selected, { text, intent: "auto" });
  }
  async function send() {
    if (!selected || !detail || recovery.isOpen() || pausedAgentChatBlock(detail)) return;
    const scope = getScope(), pane = chatView(scope), entry = chats.get(scope.selected), key = submissionKey(scope), limits = detail.limits || detail.settings?.limits;
    if (submissions.has(key)) return;
    if (!limits) { wizard.open(detail); return; }
    if (!pane.query('textarea[name="message"]').value.trim()) return;
    submissions.set(key, ""); pane.busy(true); pane.error("");
    syncResponseStatus(scope);
    let submittedId = "";
    try {
      await persistComposer(scope);
      if (!windowIsCurrent(scope)) return;
      const draft = drafts.read(scope.environment, scope.selected);
      if (!draft.text.trim()) return;
      const pending = { ...draft, pendingId: draft.pendingId || viewport.crypto.randomUUID() };
      await drafts.write(scope.environment, scope.selected, pending);
      if (!windowIsCurrent(scope)) return;
      pane.draft(pending); submittedId = pending.pendingId;
      submissions.set(key, submittedId);
      const accepted = await client.sendAgentMessage(scope.selected, { text: pending.text, clientMessageId: pending.pendingId, intent: pending.intent, limits }, scope.environment);
      // An earlier poll can return after this receipt. Keep the admitted message on screen.
      if (windowIsCurrent(scope) && accepted?.agent && !entry.detail.messages.some((message) => message.id === submittedId)) {
        entry.epoch += 1;
        showDetail(accepted,scope);
      }
      if (drafts.read(scope.environment, scope.selected).pendingId === pending.pendingId) await drafts.write(scope.environment, scope.selected, {});
      if (!windowIsCurrent(scope)) return;
      pane.draft(drafts.read(scope.environment, scope.selected)); await refresh();
    } catch (error) {
      if (windowIsCurrent(scope)) {
        if (isLegacyCoordinatorDraftConflict(error)) { pane.error(error.message); return; }
        if (!submittedId) { pane.error(error.message); return; }
        const saved = drafts.read(scope.environment, scope.selected);
        if (saved.pendingId === submittedId) {
          pane.error("Delivery couldn’t be confirmed. Your draft is saved. Use Send to retry.");
          pane.draft(saved);
        }
      }
    } finally {
      submissions.delete(key);
      if (windowIsCurrent(scope)) { pane.busy(false); syncResponseStatus(scope); }
      if (scopeIsCurrent(scope) && chats.has(scope.selected) && !submissions.has(key)) {
        const currentScope = getScope(scope.selected);
        chatView(currentScope).busy(false);
        syncResponseStatus(currentScope);
      }
    }
  }
  async function action(action, id = selected, extra = {}) {
    if (!id) return;
    const scope = getScope(id);
    try {
      const result = await client.actOnAgent(id, { action, expectedRevision: revision, ...extra }, environment);
      if (!scopeIsCurrent(scope)) return;
      if (windowIsCurrent(scope) && result.agent) { chats.get(id).epoch += 1; showDetail(result,scope); }
      if (action === "archive" && windowIsCurrent(scope)) closeWindow(id);
      await refresh(); view.archive(false); return true;
    } catch (error) {
      if (windowIsCurrent(scope)) chatView(scope).error(error.message);
      if (scopeIsCurrent(scope) && !scope.windowToken) view.error(error.message, false);
    }
  }
  async function approve(index, approved) {
    const item = detail?.approvals?.[index]; if (!item) return;
    const scope = getScope();
    try { await client.decideAgentApproval(selected, { approvalId: item.request?.approvalId || item.approvalId || item.id, approved, ...(item.wait ? { ...item.wait, commandId: viewport.crypto.randomUUID() } : {}) }, environment); if (selectedScopeIsCurrent(scope)) await refresh(); }
    catch (error) { if (windowIsCurrent(scope)) chatView(scope).error(error.message); }
  }
  async function closeChat() {
    const previous = selected;
    if (!previous) return;
    closeWindow(previous);
    view.focusAgent(previous);
  }
  function closeWizard() {
    if (!wizard.close()) return;
    if (selected) view.focusComposer();
    else view.query('[data-agents-action="create"]').focus();
  }
  function activateTarget(target) {
    const id=target.closest('[data-agent-window]')?.dataset.agentWindow;
    if(id && chats.has(id) && !wizard.active() && !schedules.active() && !migration.active()) activate(id);
  }
  async function handleClick(event) {
    activateTarget(event.target);
    const clickScope=getScope();
    const startedOnSpace = Boolean(backdropPress);
    backdropPress = null;
    if (deletion.active()) return;
    if (view.isBackdrop(event.target) && (!event.detail || startedOnSpace)
      && !schedules.active() && !migration.active() && view.query("[data-agents-archive]").hidden) {
      if (wizard.active()) { closeWizard(); return; }
      if (selected) { await closeChat(); return; }
    }
    const manage = view.query("[data-agents-manage]");
    const target = event.target.closest("button");
    if (target?.dataset.sessionPage) { view.turnSessionPage(target.dataset.sessionPage, detail); return; }
    if (manage.open && (!manage.contains(event.target) || target)) view.closeManage();
    if (!target) return;
    if (target.closest("[data-agents-migration]")) { await migration.click(target); return; }
    if (target.closest("[data-agents-schedules]")) { await schedules.click(target); return; }
    if (target.dataset.recoveryBudget) { await recovery.choose(target.dataset.recoveryBudget); return; }
    if (target.dataset.agentSession) { await inspector.show(target.dataset.agentSession, detail); return; }
    if (target.dataset.agentId) { await select(target.dataset.agentId); return; }
    if (target.dataset.agentDelete) {
      if (!wizard.busy()) await deletion.remove(target.dataset.agentDelete, getScope());
      return;
    }
    if (target.dataset.agentRestore) { await action("restore", target.dataset.agentRestore); return; }
    if (target.dataset.agentChoice) { await wizard.choose(target.dataset.agentChoice, target.dataset.value); return; }
    if (target.dataset.agentApproval !== undefined) { await approve(Number(target.dataset.agentApproval), target.dataset.approved === "true"); return; }
    switch (target.dataset.agentsAction) {
      case "create": if (await loadModels() && selectedScopeIsCurrent(clickScope)) wizard.open(); break;
      case "recovered-drafts": migration.open(); break;
      case "schedules": if (detail) await schedules.open(detail); break;
      case "configure": if (await loadModels() && selectedScopeIsCurrent(clickScope) && detail) wizard.open(detail); break;
      case "close-wizard": closeWizard(); break;
      case "previous-step": wizard.back(); break;
      case "close-chat": await closeChat(); break;
      case "archived": view.archive(true); break;
      case "close-archived": view.archive(false); break;
      case "cancel": await action("cancel"); break;
      case "pause": await action("pause"); break;
      case "steer": if (await action("pause") && selectedScopeIsCurrent(clickScope) && detail) recovery.open(detail, "steer"); break;
      case "resume": if (detail) recovery.open(detail); break;
      case "close-recovery": recovery.close(); view.focusComposer(); break;
      case "close-session": inspector.close(); view.focusManage(); break;
      case "archive": if (selected !== "abot" && wizard.close()) await action("archive"); break;
    }
  }
  function bind() {
    view.root.addEventListener("focusin", event => activateTarget(event.target));
    view.root.addEventListener("pointerdown", event => {
      activateTarget(event.target);
      backdropPress = view.isBackdrop(event.target) ? { x: event.clientX, y: event.clientY } : null;
    });
    view.root.addEventListener("pointermove", event => {
      if (backdropPress && Math.hypot(event.clientX - backdropPress.x, event.clientY - backdropPress.y) > 5) backdropPress = null;
    });
    view.root.addEventListener("pointerup", event => { if (!view.isBackdrop(event.target)) backdropPress = null; });
    view.root.addEventListener("pointercancel", () => { backdropPress = null; });
    view.root.addEventListener("click", (event) => void handleClick(event).catch((error) => view.error(error.message)));
    view.root.addEventListener("submit", (event) => { event.preventDefault(); activateTarget(event.target); if (deletion.active()) return; if (event.target.dataset.agentsForm === "onboarding") void wizard.submit(); else if (event.target.dataset.agentsForm === "schedule") void schedules.save(); else if (event.target.dataset.agentsForm === "recovery") void recovery.submit(); else void send(); });
    view.root.addEventListener("input", (event) => {
      activateTarget(event.target);
      if (event.target.closest('[data-agents-form="schedule"]')) { void schedules.change(event.target).catch((error) => view.error(error.message)); return; }
      if (event.target.closest('[data-agents-form="recovery"]')) { void recovery.change(event.target).catch((error) => view.error(error.message)); return; }
      const operation = event.target.closest('[data-agents-form="onboarding"]') ? wizard.change(event.target) : persistComposer();
      void operation.catch((error) => view.error(error.message));
    });
    for (const name of ["pointerover", "focusin"]) view.root.addEventListener(name, (event) => { const node = event.target.closest("[data-agent-id]"); if (node) view.hover(node.dataset.agentId, node); });
    for (const name of ["pointerout", "focusout"]) view.root.addEventListener(name, () => view.hideHover());
    view.root.addEventListener("keydown", (event) => {
      activateTarget(event.target);
      if (event.key === "Enter" && event.target === view.query('textarea[name="message"]')) {
        // WebKit can report keyCode 229 on the final IME confirmation key.
        if (event.defaultPrevented || event.shiftKey || event.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        if (!event.repeat && event.target.value.trim()) event.target.form.requestSubmit();
        return;
      }
      if (event.key === "Tab" && (migration.active() || wizard.active() || schedules.active())) {
        const controls = [...view.query(migration.active() ? "[data-agents-migration]" : schedules.active() ? "[data-agents-schedules]" : "[data-agents-wizard]").querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), summary')];
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && documentRoot.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && documentRoot.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (deletion.active()) return;
      if (migration.active()) { migration.close(); return; }
      if (schedules.active()) { schedules.close(); return; }
      if (wizard.active()) { closeWizard(); return; }
      if (inspector.active()) { inspector.close(); view.focusManage(); return; }
      if (view.query("[data-agents-manage]").open) { view.closeManage(); view.focusManage(); return; }
      if (selected) { void closeChat(); return; }
      onHome();
    });
    documentRoot.addEventListener("visibilitychange", () => { viewport.clearTimeout(timer); if (!documentRoot.hidden) void refresh(); });
  }
  async function environmentChanged() {
    const next = getEnvironmentId(); if (environment === next) return;
    catalogIds = new Set();
    recovery.close(); inspector.close(); schedules.close();
    chats.clear(); view.resetWindows();
    environment = next; generation += 1; selected = ""; detail = null; revision = 0; loading = false; models = [];
    deletion.reset(); inspector.close(); view.select(""); view.renderCatalog([]); view.archive(false); wizard.reset(); recovery.close(); schedules.close(); migration.close(); view.busy(false);
    syncResponseStatus();
    if (!client.supportsAgents?.()) { view.error("Agents are available with the local Runtime backend.", false); return; }
    const scope = getScope();
    try { if (await loadModels()) wizard.refresh(); }
    catch (error) { if (scopeIsCurrent(scope)) view.error(error.message, false); }
    await refresh();
  }
  return {
    bind, refresh, environmentChanged, selectedId: () => selected,
    async openRoute(id) { await environmentChanged(); if (id) await select(id); else await select(""); return true; },
    setActive(value) { active = value; if (!value) deletion.reset(); view.setActive(value); viewport.clearTimeout(timer); if (value) { if (environment !== getEnvironmentId()) void environmentChanged(); else void refresh(); } },
  };
}
