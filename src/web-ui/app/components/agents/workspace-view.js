import { renderAgentActivity } from "./activity-feed.js";
import { renderAgentApprovalTray } from "./approval-attention.js";
import { createAgentApprovalDetails } from "./approval-details.js";
import { createConfirmationDialog } from "../confirmation-dialog.js";
import { createOrbitNotices, currentOrbitNotice } from "./orbit-notices.js";
import { escapeHtml as html, escapeAttribute as attr } from "../../lib/text-format.js";
import { renderAgentButton, agentStatusLabel, agentIsWorking, agentColor, agentHoverWork } from "./appearance.js";
import { renderAgentSessionPreview } from "./session-preview.js";
import { agentWindowPlacement, createAgentOrbitMotion } from "./orbits.js";
import { createAgentTimeline } from "./conversation-timeline.js";
import { agentSessionPage, renderAgentConversation, renderTaskControls, renderAgentApprovals, renderAgentTaskState, renderAgentSessions } from "./conversation.js";
import { isPausedAgentTask, pausedAgentChatBlock } from "./recovery.js";
import { renderAgentOnboarding } from "./onboarding.js";

export function createAgentsWorkspaceView({ root, viewport = window, documentRoot = document }) {
  const stars = Array.from({ length: 110 }, (_, index) => `<i style="left:${(index * 71.37) % 100}%;top:${(index * 37.91) % 100}%;--star-opacity:${.28 + index % 5 * .12};--star-size:${index % 5 ? 1.5 : 2.5}px;--star-delay:-${index * 2.7}s"></i>`).join("");
  root.innerHTML = `<div class="agents-cosmos">
    <div class="agents-stars" aria-hidden="true">${stars}</div>
    <div class="agents-nebula" aria-hidden="true"></div>
    <button type="button" class="agents-add" data-agents-action="create" aria-label="Add an agent"></button>
    <div class="agents-orbit-field" data-agents-field role="group" aria-label="Your agents">
      <div class="agents-orbit-guides" aria-hidden="true">
        <span class="agents-orbit-track" hidden></span><span class="agents-orbit-track" hidden></span>
      </div>
    </div>
    <aside class="agents-hover" id="agents-orbit-preview" data-agents-hover hidden role="tooltip">
      <strong dir="auto"></strong><p dir="auto" hidden></p>
      <small hidden><span></span> <bdi dir="auto"></bdi></small>
    </aside>
    <div class="agents-activity-rail">
      <aside class="agents-approval-tray" data-agents-approval-tray aria-label="Agents needing attention" aria-live="polite" hidden></aside>
      <aside class="agents-activity-feed" data-agents-activity-feed aria-label="Recent agent activity"></aside>
    </div>
    <div class="agents-space-error" data-agents-space-error role="status"></div>
    <button type="button" class="agents-plain agents-archive-trigger" data-agents-action="archived" hidden>Archived</button>
    <section class="agents-conversation" data-agents-chat hidden aria-label="Agent conversation">${renderAgentConversation()}</section>
    <section class="agents-wizard" data-agents-wizard hidden role="dialog" aria-modal="true" aria-label="Set up your agent"></section>
    <section class="agents-wizard" data-agents-schedules hidden role="dialog" aria-modal="true" aria-label="Agent schedules"></section>
    <section class="agents-wizard agents-draft-migration" data-agents-migration hidden role="dialog" aria-modal="true" aria-label="Saved Agent drafts"></section>
    <section class="agents-archive" data-agents-archive hidden aria-label="Archived agents"><header><h2>Archived agents</h2><button type="button" class="agents-close" data-agents-action="close-archived" aria-label="Close archived agents">×</button></header><div data-agent-archive-list></div><p class="agents-error" data-agent-delete-status role="status"></p></section>
  </div>`;
  let currentChat = null;
  const query = (selector) => currentChat?.querySelector(selector) || root.querySelector(selector), nodes = new Map();
  const windows = new Map();
  let serial = 0;
  const cosmos = root.querySelector('.agents-cosmos');
  const launcher = documentRoot.createElement('nav');
  launcher.className = 'agents-window-launcher';
  launcher.setAttribute('aria-label', 'Open agent conversations');
  cosmos.append(launcher);
  const field = query("[data-agents-field]"), wizard = query("[data-agents-wizard]");
  let chat = query("[data-agents-chat]");
  const emptyChat = chat;
  const addButton = query('[data-agents-action="create"]');
  const archiveButton = query('[data-agents-action="archived"]');
  const notices = createOrbitNotices(field);
  const guides = field.querySelectorAll(".agents-orbit-track");
  const motion = createAgentOrbitMotion({ field, chat, nodes, guides, onLayout: notices.layout, documentRoot, viewport });
  let timeline = createAgentTimeline(query("[data-agents-messages]"));
  const renderApprovalDetails = createAgentApprovalDetails({ documentRoot });
  let manage = query("[data-agents-manage]"), sessionIndex = query("[data-agents-session-index]");
  let inspector = query("[data-agents-session-preview]");
  let catalog = [], selected = "", previewMarkup = "";
  let confirmation;
  let sessionPageEnd = null;
  function renderSessionIndex(detail) {
    const sessions = detail.sessions || [];
    const page = agentSessionPage(sessions, sessionPageEnd);
    updateMarkup("[data-agents-sessions]", renderAgentSessions(page.sessions, detail.attempts));
    query("[data-agents-session-count]").textContent = String(sessions.length);
    sessionIndex.hidden = !sessions.length;
    query("[data-session-pages]").hidden = page.older === null && page.newer === null;
    query('[data-session-page="older"]').disabled = page.older === null;
    query('[data-session-page="newer"]').disabled = page.newer === null;
  }
  function turnSessionPage(direction, detail) {
    if (!detail || !["older", "newer"].includes(direction)) return;
    const page = agentSessionPage(detail.sessions, sessionPageEnd);
    const next = page[direction];
    if (next === null) return;
    sessionPageEnd = next === detail.sessions.length ? null : next;
    renderSessionIndex(detail);
    const button = query(`[data-session-page="${direction}"]`);
    if (button.disabled) query("[data-session-page]:not(:disabled)")?.focus();
  }
  let composer = query('textarea[name="message"]');
  let sendButton = query('[data-agents-form="message"] button[type="submit"]');
  let sending = false, pausedChatBlock = null;
  function updateComposerState(detail) {
    pausedChatBlock = pausedAgentChatBlock(detail);
    composer.placeholder = "Talk to your agent…";
    if (isPausedAgentTask(detail)) composer.placeholder = "Chat while the task is paused…";
    if (pausedChatBlock) composer.placeholder = "Draft a message…";
    if (detail?.pendingUserQuestionId) composer.placeholder = "Answer your agent’s question…";
    updateSendLabel();
  }
  function updateSendLabel() {
    sendButton.disabled = sending || Boolean(pausedChatBlock);
    let label = composer.readOnly ? "Retry send" : "Send message";
    if (pausedChatBlock) label = pausedChatBlock;
    if (sending) label = "Sending message";
    sendButton.setAttribute("aria-label", label);
    sendButton.title = label;
  }

  function snapshot() { return { chat, timeline, manage, sessionIndex, inspector, composer, sendButton, sending, pausedChatBlock, sessionPageEnd, previewMarkup }; }
  function adopt(value) {
    ({ chat, timeline, manage, sessionIndex, inspector, composer, sendButton, sending, pausedChatBlock, sessionPageEnd, previewMarkup } = value);
    currentChat = chat;
  }
  let emptyContext;
  function saveContext() { if (windows.has(selected)) windows.get(selected).context = snapshot(); }
  function withWindow(id, operation) {
    const entry = windows.get(id);
    if (!entry) return;
    const before = snapshot(), oldSelected = selected;
    saveContext(); selected = id; adopt(entry.context);
    try { return operation(); }
    finally {
      entry.context = snapshot();
      // Keep scalar changes in the active context; only a background pane needs restoration.
      if (oldSelected !== id) { selected = oldSelected; adopt(before); }
    }
  }
  function raise(id) {
    const entry = windows.get(id); if (!entry) return;
    const ordered = [...windows.values()].filter(value => value !== entry).sort((a,b) => Number(a.node.style.zIndex) - Number(b.node.style.zIndex));
    ordered.push(entry);
    ordered.forEach((value,index) => { value.node.style.zIndex = String(index + 1); value.node.classList.toggle('is-front', value === entry); });
  }
  function clamp(entry, x = entry.x, y = entry.y) {
    const width = cosmos.clientWidth, height = cosmos.clientHeight;
    if (!width || !height) return;
    entry.x = Math.max(0, Math.min(x, Math.max(0,width-entry.node.offsetWidth)));
    const lane = Math.min(180, height * .36);
    entry.y = Math.max(lane, Math.min(y, Math.max(lane,height-entry.node.offsetHeight)));
    entry.node.style.left = entry.x + 'px'; entry.node.style.top = entry.y + 'px';
    // Targets flow from pane geometry to portraits only, never back into pane positions.
    const fieldBounds = field.getBoundingClientRect(), bounds = cosmos.getBoundingClientRect();
    const size = width < 580 ? 49 : 74;
    const scale = Math.min(1.15, Math.max(.5, (entry.y - 74) / (size + 41)));
    const radius = Math.max(size / 2 + 8, width < 580 ? 50 : 80) * scale;
    const center = Math.max(radius, Math.min(entry.x + entry.node.offsetWidth / 2, width - radius));
    motion.setWindowTarget(entry.id, { x: center + bounds.left - fieldBounds.left,
      y: entry.y - 10 - (size / 2 + 28) * scale + bounds.top - fieldBounds.top, size, scale });
  }
  function reclamp() { for (const entry of windows.values()) clamp(entry); }
  const resizeObserver = viewport.ResizeObserver ? new viewport.ResizeObserver(reclamp) : null;
  resizeObserver?.observe(cosmos); resizeObserver?.observe(field); viewport.addEventListener('resize', reclamp);
  function installMovement(entry) {
    const header = entry.node.querySelector('.agents-conversation-head');
    header.tabIndex = 0;
    header.setAttribute('aria-label', 'Move conversation: use arrow keys, Shift for larger steps');
    let drag = null;
    header.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('button, summary, details, input, textarea, a')) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: entry.x, top: entry.y };
      header.setPointerCapture(event.pointerId); header.focus({preventScroll:true}); event.preventDefault();
    });
    header.addEventListener('pointermove', event => {
      if (drag?.id !== event.pointerId) return;
      clamp(entry, drag.left + event.clientX-drag.x, drag.top + event.clientY-drag.y);
    });
    const finish = event => { if (drag?.id !== event.pointerId) return; drag = null; if(header.hasPointerCapture(event.pointerId)) header.releasePointerCapture(event.pointerId); };
    header.addEventListener('pointerup',finish); header.addEventListener('pointercancel',finish);
    header.addEventListener('lostpointercapture',()=>{drag=null;});
    header.addEventListener('keydown',event=>{
      if(event.target !== header) return;
      const delta = {ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
      if(!delta) return; event.preventDefault(); const step=event.shiftKey?40:10;
      clamp(entry,entry.x+delta[0]*step,entry.y+delta[1]*step);
    });
  }
  const windowLayer = documentRoot.createElement('div');
  windowLayer.className='agents-window-layer'; cosmos.append(windowLayer);
  function activateWindow(id) {
    saveContext(); selected = id || '';
    if (!id) { adopt(emptyContext); hideHover(); return; }
    let entry=windows.get(id);
    if (!entry) {
      const node=emptyChat.cloneNode(true); node.hidden=false; node.dataset.agentWindow=id;
      const input=node.querySelector('textarea[name="message"]');
      input.id='agentsMessageInput-'+(++serial); node.querySelector('label[for]').htmlFor=input.id;
      node.setAttribute('aria-label', (catalog.find(agent=>agent.id===id)?.definition.name || 'Agent')+' conversation');
      windowLayer.append(node);
      currentChat=node; chat=node; timeline=createAgentTimeline(query('[data-agents-messages]'));
      manage=query('[data-agents-manage]'); sessionIndex=query('[data-agents-session-index]'); inspector=query('[data-agents-session-preview]');
      composer=input; sendButton=query('[data-agents-form="message"] button[type="submit"]');
      sending=false; pausedChatBlock=null; sessionPageEnd=null; previewMarkup='';
      const point = motion.windowPoint(id) || { x: cosmos.clientWidth / 2, y: cosmos.clientHeight / 2 };
      const fieldBounds = field.getBoundingClientRect(), bounds = cosmos.getBoundingClientRect();
      const placement = agentWindowPlacement({ x: point.x + fieldBounds.left - bounds.left,
        y: point.y + fieldBounds.top - bounds.top }, cosmos.clientWidth, cosmos.clientHeight, node.offsetWidth, node.offsetHeight);
      entry={id,node,...placement,context:snapshot()}; windows.set(id,entry);
      query('[data-agents-chat-name]').textContent=catalog.find(agent=>agent.id===id)?.definition.name || 'Agent';
      timeline.reset(); installMovement(entry); clamp(entry);
    } else adopt(entry.context);
    raise(id); hideHover(); syncDialogInert(); reclamp();
  }
  function closeWindow(id) {
    const entry=windows.get(id); if(!entry) return;
    motion.setWindowTarget(id, null);
    entry.node.remove(); windows.delete(id);
    if(selected===id) { selected=''; adopt(emptyContext); }
    syncOrbitNotices();
  }
  function resetWindows() { for(const id of [...windows.keys()]) closeWindow(id); activateWindow(''); }
  let motionActive=false;
  function syncStars() { cosmos.dataset.starsActive=String(motionActive && !documentRoot.hidden); }
  documentRoot.addEventListener('visibilitychange',syncStars);

  const lastMarkup = new WeakMap();
  function updateMarkup(selector, markup) {
    const node = query(selector);
    if (lastMarkup.get(node) !== markup) { node.innerHTML = markup; lastMarkup.set(node, markup); }
  }
  function closeManage() { manage.open = false; sessionIndex.open = false; }
  const tooltip = query("[data-agents-hover]");
  const previewName = tooltip.querySelector("strong"), previewMessage = tooltip.querySelector("p");
  const previewWork = tooltip.querySelector("small");
  const workLabel = previewWork.querySelector("span"), workText = previewWork.querySelector("bdi");
  let hoveredTarget = null;
  function syncOrbitNotices() {
    const overlay = selected || hoveredTarget || !wizard.hidden || !query("[data-agents-migration]").hidden ||
      !query("[data-agents-schedules]").hidden || !query("[data-agents-archive]").hidden;
    notices.hide(Boolean(overlay));
    query("[data-agents-activity-feed]").hidden = Boolean(selected || !wizard.hidden || !query("[data-agents-migration]").hidden || !query("[data-agents-schedules]").hidden || !query("[data-agents-archive]").hidden || !inspector.hidden);
  }
  function hideHover() {
    hoveredTarget?.removeAttribute("aria-describedby");
    hoveredTarget = null;
    tooltip.hidden = true;
    syncOrbitNotices();
  }
  function syncDialogInert() {
    const migrationOpen = !query("[data-agents-migration]").hidden;
    const schedulesOpen = !query("[data-agents-schedules]").hidden;
    const modalOpen = migrationOpen || schedulesOpen || !wizard.hidden;
    if (modalOpen) hideHover();
    for (const element of [windowLayer, launcher, field, addButton, archiveButton, query("[data-agents-approval-tray]"), query("[data-agents-activity-feed]")]) element.inert = modalOpen;
    wizard.inert = migrationOpen || schedulesOpen;
    query("[data-agents-schedules]").inert = migrationOpen;
    query("[data-agents-session-preview]").inert = migrationOpen;
    query("[data-agents-archive]").inert = migrationOpen;
    syncOrbitNotices();
  }

  function renderArchive() {
    const archived = catalog.filter(agent => agent.status === "archived");
    const rows = archived.map(agent => {
      const id = attr(agent.id);
      const restore = agent.isDeleting ? "" : `<button type="button" class="agents-plain" data-agent-restore="${id}">Restore</button>`;
      const remove = agent.id === "abot" ? "" : `<button type="button" class="agents-plain agents-destructive" data-agent-delete="${id}">${agent.isDeleting ? "Retry deletion…" : "Delete…"}</button>`;
      return `<div class="agents-archive-row"><span dir="auto">${html(agent.definition.name)}</span>${restore}${remove}</div>`;
    });
    updateMarkup("[data-agent-archive-list]", rows.join("") || "<p>No archived agents.</p>");
  }
  function renderCatalog(agents) {
    catalog = agents;
    const launchMarkup=agents.filter(agent=>agent.status!=='archived').map(agent=>`<button type="button" class="agents-plain" data-agent-id="${attr(agent.id)}">${html(agent.definition.name)}</button>`).join('');
    if(launcher.innerHTML!==launchMarkup) launcher.innerHTML=launchMarkup;
    updateMarkup("[data-agents-activity-feed]", renderAgentActivity(agents));
    syncOrbitNotices();
    const visible = agents.filter((agent) => agent.status !== "archived").sort((a, b) => Number(b.id === "abot") - Number(a.id === "abot"));
    const ids = visible.map((agent) => agent.id), previousIds = [...nodes.keys()];
    for (const [id, node] of nodes) if (!ids.includes(id)) { node.remove(); nodes.delete(id); }
    visible.forEach((agent, index) => {
      if (!nodes.has(agent.id)) { field.insertAdjacentHTML("beforeend", renderAgentButton(agent, index)); nodes.set(agent.id, field.lastElementChild); }
      const node = nodes.get(agent.id);
      node.querySelector(".agents-name").textContent = agent.definition.name;
      node.style.setProperty("--agent-color", agentColor(agent));
      node.classList.toggle("is-working", agentIsWorking(agent));
      node.classList.toggle("needs-approval", agent.workStatus === "awaiting_approval");
      node.setAttribute("aria-label", `${agent.definition.name} — ${agentStatusLabel(agent)}`);
    });
    const approvalMarkup = renderAgentApprovalTray(visible);
    updateMarkup("[data-agents-approval-tray]", approvalMarkup);
    query("[data-agents-approval-tray]").hidden = !approvalMarkup;
    notices.update(visible);
    if (JSON.stringify(previousIds) !== JSON.stringify(ids)) motion.update(ids);
    archiveButton.hidden = !agents.some((agent) => agent.status === "archived");
    if (!query("[data-agents-archive]").hidden) renderArchive();
    if (hoveredTarget) hover(hoveredTarget.dataset.agentId, hoveredTarget);
  }
  function renderDetail(value) {
    updateComposerState(value);
    query("[data-agents-chat-name]").textContent = value.agent.definition.name;
    query("[data-agents-chat-status]").textContent = value.status === "idle" ? "" : agentStatusLabel({ ...value.agent, workStatus: value.status });
    timeline.render(value.messages, value.updates);
    updateMarkup("[data-agents-approvals]", renderAgentApprovals(value.approvals));
    renderApprovalDetails(query("[data-agents-approvals]"), value.approvals);
    updateMarkup("[data-agents-task-state]", renderAgentTaskState(value));
    updateMarkup("[data-agents-task-controls]", renderTaskControls(value));
    renderSessionIndex(value);
  }
  function hover(id, target) {
    const agent = catalog.find((entry) => entry.id === id);
    if (!agent || selected || nodes.get(id) !== target) { hideHover(); return; }
    if (hoveredTarget !== target) {
      hideHover();
      hoveredTarget = target;
      target.setAttribute("aria-describedby", tooltip.id);
    }
    previewName.textContent = agent.definition.name;
    const notice = currentOrbitNotice(agent);
    const message = notice?.kind === "reply" ? notice.text : agent.latestAgentMessage;
    previewMessage.textContent = message || "";
    previewMessage.hidden = !message;
    const work = notice?.kind === "thinking" ? { label: notice.text, text: "" }
      : notice?.kind === "work" ? { label: "Update", text: notice.text } : agentHoverWork(agent);
    previewWork.hidden = !work;
    workLabel.textContent = work?.label || "";
    workText.textContent = work?.text || "";
    tooltip.hidden = false;
    syncOrbitNotices();

    const rect = target.getBoundingClientRect(), bounds = root.getBoundingClientRect();
    const label = (target.querySelector(".agents-name") || target).getBoundingClientRect();
    const left = rect.left - bounds.left + (rect.width - tooltip.offsetWidth) / 2;
    const below = label.bottom - bounds.top + 9;
    const above = rect.top - bounds.top - tooltip.offsetHeight - 9;
    tooltip.style.left = `${Math.max(12, Math.min(left, bounds.width - tooltip.offsetWidth - 12))}px`;
    tooltip.style.top = `${below + tooltip.offsetHeight <= bounds.height - 12 ? below : Math.max(12, above)}px`;
  }
  emptyContext = snapshot();
  const api = {
    root, query, renderCatalog, renderDetail, turnSessionPage, select: activateWindow, hover, closeManage,
    closeWindow, resetWindows, raiseWindow: raise,
    forWindow(id) {
      const invoke = (name, ...args) => withWindow(id, () => api[name](...args));
      return Object.fromEntries(['query','renderDetail','draft','busy','error','recovered','isAttentionVisible','focusComposer'].map(name=>[name,(...args)=>invoke(name,...args)]));
    },
    isBackdrop(target) { return target === field || target === field.parentElement; },
    isAttentionVisible(id, detail) {
      if (chat.hidden || chat.inert || windowLayer.inert || manage.open || !inspector.hidden) return false;
      if (timeline.isVisible(id)) return true;
      return detail.mission?.waitingReason === "agents_plan_invalid" &&
        (detail.latestPlanNoticeId === id || detail.responsibility?.some((trace) => trace.missionId === detail.mission.id && `plan-notice:${trace.id}` === id));
    },
    focusManage() { manage.querySelector("summary").focus(); },
    setActive(value) { motionActive=value; syncStars(); motion.setActive(value); if(value) reclamp(); },
    error(message, inChat = Boolean(selected)) { query(inChat ? "[data-agents-chat-error]" : "[data-agents-space-error]").textContent = message; },
    draft(value) { composer.value = value.text; composer.readOnly = Boolean(value.pendingId); updateSendLabel(); },
    busy(value) { sending = value; sendButton.setAttribute("aria-busy", String(value)); updateSendLabel(); },
    wizard(state) { wizard.hidden = !state; if (state) wizard.innerHTML = renderAgentOnboarding(state); syncDialogInert(); },
    archive(show) {
      const panel = query("[data-agents-archive]"); panel.hidden = !show; syncOrbitNotices();
      panel.querySelector("[data-agent-delete-status]").textContent = "";
      if (show) { renderArchive(); panel.querySelector("button")?.focus(); }
    },
    confirmDeletion(message, options) {
      confirmation ??= createConfirmationDialog({ documentRoot });
      return confirmation.confirm(message, options);
    },
    cancelDeletionConfirmation() { confirmation?.cancel(); },
    deletionStatus(message) {
      const panel = wizard.hidden ? query("[data-agents-archive]") : wizard;
      const status = panel.querySelector("[data-agent-delete-status]");
      if (status) status.textContent = message;
    },
    schedules(content) { const panel = query("[data-agents-schedules]"); panel.hidden = !content; if (content) panel.innerHTML = content; syncDialogInert(); },
    migration(content) { const panel = query("[data-agents-migration]"); panel.hidden = !content; if (content) panel.innerHTML = content; syncDialogInert(); if (content) panel.querySelector("button")?.focus(); },
    recovered(count) { const button = query('[data-agents-action="recovered-drafts"]'); button.hidden = !count; button.textContent = `Saved drafts (${count})`; },
    session(value) {
      const opening = inspector.hidden && Boolean(value);
      inspector.hidden = !value;
      syncOrbitNotices();
      const markup = value ? renderAgentSessionPreview(value) : "";
      if (markup !== previewMarkup) {
        const hadFocus = inspector.contains(documentRoot.activeElement);
        const scroll = inspector.querySelector(".agents-session-transcript")?.scrollTop || 0;
        inspector.innerHTML = markup;
        const transcript = inspector.querySelector(".agents-session-transcript");
        if (transcript) transcript.scrollTop = scroll;
        if (opening || hadFocus) inspector.querySelector("button")?.focus({ preventScroll: true });
        previewMarkup = markup;
      }
    },
    focusComposer() { query('textarea[name="message"]').focus(); },
    focusAgent(id) { nodes.get(id)?.focus(); },
    hideHover,
    dispose() { confirmation?.destroy(); motion.dispose(); resizeObserver?.disconnect(); viewport.removeEventListener("resize",reclamp); documentRoot.removeEventListener("visibilitychange",syncStars); resetWindows(); },
  };
  return api;
}
