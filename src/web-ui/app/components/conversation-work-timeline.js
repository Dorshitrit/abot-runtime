import { buildConversationActivityModel } from "./conversation-activity.js";
import { buildConversationWorkTimeline } from "../lib/conversation-work-timeline-model.js";
import { summarizeConversationTools } from "../lib/tool-activity-model.js";
import { eventTone, formatEventDetail, formatEventLabel, titleCaseEventValue } from "../lib/event-presentation.js";
import { applyTextDirection, renderMarkdown } from "../lib/text-format.js";
import { createConversationTools } from "./conversation-tools.js";
import { createConversationSources } from "./conversation-sources.js";
import { createConversationMemoryActivity } from "./conversation-memory-activity.js";
import { createConversationBasketActivity } from "./conversation-basket-activity.js";
import { createConversationSkillActivity } from "./conversation-skill-activity.js";
import { createConversationRoleDelegations } from "./conversation-role-delegations.js";
import { createConversationRoleReturns } from "./conversation-role-returns.js";

function hasTimelineContent(model, entries) {
  if (entries.length > 0) return true;
  if (model.sources.length > 0) return true;
  return model.hasContent;
}

function timelineFacts(model) {
  const facts = [];
  if (model.progress?.total > 0)
    facts.push(`${Math.min(model.progress.completed, model.progress.total)}/${model.progress.total} steps`);
  const toolSummary = summarizeConversationTools(model.toolActions);
  if (toolSummary) facts.push(toolSummary);
  if (!toolSummary && model.toolCount > 0)
    facts.push(`${model.toolCount} tool${model.toolCount === 1 ? "" : "s"}`);
  const sources = model.sources.reduce((total, group) => total + group.sources.length + (group.omittedSourceCount || 0), 0);
  if (sources > 0) facts.push(`${sources} source${sources === 1 ? "" : "s"}`);
  if (facts.length === 0 && model.eventCount > 0) facts.push(`${model.eventCount} events`);
  if (model.failureCount > 0) facts.push(`${model.failureCount} failed`);
  return facts.join(" · ");
}

function timelineRole(entry, model) {
  if (entry.role === "context") return { title: "Context management", responsibility: "" };
  const role = entry.role === "root" ? "supervisor" : entry.role;
  const card = model.roleCards.find((candidate) => candidate.role === role);
  if (card) return { title: card.title, responsibility: card.responsibility };
  if (entry.role === "root") return { title: "Root agent", responsibility: "Coordinates the request" };
  if (entry.role === "unknown") return { title: "Unattributed actions", responsibility: "Executor not recorded" };
  return { title: titleCaseEventValue(role), responsibility: "" };
}

function indexDisclosureRows(list, selector, identityKey) {
  const rows = new Map();
  for (const row of list?.children || []) {
    const disclosure = row.querySelector(selector);
    if (disclosure) rows.set(disclosure.dataset[identityKey], row);
  }
  return rows;
}

/** Render existing evidence in one chronology; disclosure state never owns Runtime state. */
export function createConversationWorkTimeline({ documentRoot = document, onOpenFile, canOpenFile, createFileChanges, onVisibilityChange } = {}) {
  const requests = new Map();
  const tools = createConversationTools({ documentRoot, onOpenFile, canOpenFile, createFileChanges, onVisibilityChange });
  const sources = createConversationSources({ documentRoot });
  const delegations = createConversationRoleDelegations({ documentRoot });
  const returns = createConversationRoleReturns({ documentRoot });
  let panelSequence = 0;

  function element(tag, className, text = "") {
    const node = documentRoot.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }

  function requestState(requestId, hasFinalAnswer) {
    const state = requests.get(requestId) || { finalSeen: false, expanded: true, toggle: null };
    requests.set(requestId, state);
    if (hasFinalAnswer && !state.finalSeen) {
      state.finalSeen = true;
      state.expanded = false;
    }
    return state;
  }

  function renderDiagnostic(event) {
    const row = element("div", "conversation-work-event");
    const presented = Boolean(event.eventName || event.key);
    row.dataset.tone = event.tone || eventTone(event);
    const label = presented ? event.name : formatEventLabel(event);
    const detail = presented ? event.summary : formatEventDetail(event);
    const title = element("span", "conversation-work-event-title", label || "Event");
    title.setAttribute("dir", "auto");
    row.appendChild(title);
    if (event.count > 1) row.appendChild(element("span", "conversation-work-event-count", `×${event.count}`));
    if (detail) {
      const description = element("span", "conversation-work-event-detail", detail);
      description.setAttribute("dir", "auto");
      row.appendChild(description);
    }
    return row;
  }

  function renderEntryContent(entry) {
    if (entry.kind === "message") {
      const node = element("div", "markdown-body conversation-work-message");
      node.dataset.source = entry.source;
      applyTextDirection(node, entry.text);
      node.innerHTML = renderMarkdown(entry.text);
      return node;
    }
    if (entry.kind === "memory") return createConversationMemoryActivity({ documentRoot, activities: entry.activities });
    if (entry.kind === "basket") return createConversationBasketActivity({ documentRoot, activities: entry.activities });
    if (entry.kind === "skill") return createConversationSkillActivity({ documentRoot, activities: entry.activities });
    if (entry.kind === "event") return renderDiagnostic(entry.event);
    return null;
  }

  function renderDisclosureRows(requestId, entries) {
    const toolNode = tools.createNode({ requestId, embedded: true,
      actions: entries.filter((entry) => entry.kind === "tool").map((entry) => entry.action) });
    const delegationNode = delegations.createNode({ requestId,
      delegations: entries.filter((entry) => entry.kind === "delegation").map((entry) => entry.delegation) });
    const returnNode = returns.createNode({ requestId,
      returns: entries.filter((entry) => entry.kind === "return").map((entry) => entry.receipt) });
    return {
      tool: indexDisclosureRows(toolNode?.querySelector(".conversation-tools-list"), ".conversation-tool", "actionId"),
      delegation: indexDisclosureRows(delegationNode, ".conversation-role-delegation", "delegationId"),
      return: indexDisclosureRows(returnNode, ".conversation-role-return", "returnId"),
    };
  }

  function entryRow(entry, rows) {
    if (entry.kind === "tool") return rows.tool.get(entry.action.id);
    if (entry.kind === "delegation") return rows.delegation.get(entry.delegation.id);
    if (entry.kind === "return") return rows.return.get(entry.receipt.id);
    const content = renderEntryContent(entry);
    if (!content) return null;
    const row = element("li", "conversation-work-entry");
    row.appendChild(content);
    return row;
  }

  function renderEntries(requestId, entries, model) {
    const list = element("ol", "conversation-work-entries");
    list.setAttribute("aria-label", "Request work timeline");
    const rows = renderDisclosureRows(requestId, entries);
    let previousRole = "";
    for (const entry of entries) {
      const row = entryRow(entry, rows);
      if (!row) continue;
      const role = timelineRole(entry, model);
      if (role.title !== previousRole) {
        const label = element("li", "conversation-work-role");
        label.dataset.role = entry.role;
        label.appendChild(element("span", "conversation-work-role-title", role.title));
        if (role.responsibility) label.appendChild(element("span", "conversation-work-role-description", `· ${role.responsibility}`));
        list.appendChild(label);
        previousRole = role.title;
      }
      row.classList.add("conversation-work-entry");
      row.dataset.entryId = entry.id;
      row.dataset.kind = entry.kind;
      row.dataset.role = entry.role;
      list.appendChild(row);
    }
    return list;
  }

  function isCurrentCompletedToggle(requestId, state, toggle, hasFinalAnswer) {
    if (!hasFinalAnswer) return false;
    if (requests.get(requestId) !== state) return false;
    return state.toggle === toggle;
  }

  function createNode(input = {}) {
    const model = input.summaryModel || buildConversationActivityModel(input);
    if (!model.requestId) return null;
    const entries = buildConversationWorkTimeline({ ...input, requestId: model.requestId });
    if (!hasTimelineContent(model, entries)) return null;
    const hasFinalAnswer = input.hasFinalAnswer === true;
    const state = requestState(model.requestId, hasFinalAnswer);
    const section = element("section", "conversation-work-timeline");
    section.dataset.requestId = model.requestId;
    section.setAttribute("aria-label", "Agents and progress");
    const header = element("header", "conversation-work-summary");
    header.appendChild(element("span", "conversation-work-heading", "Agents"));
    header.appendChild(element("span", "conversation-work-facts", timelineFacts(model)));
    const toggle = element("button", "conversation-work-toggle");
    toggle.type = "button";
    toggle.hidden = !hasFinalAnswer;
    state.toggle = toggle;
    const panel = element("div", "conversation-work-panel");
    panel.id = `conversation-work-panel-${++panelSequence}`;
    toggle.setAttribute("aria-controls", panel.id);
    header.appendChild(toggle);
    panel.appendChild(renderEntries(model.requestId, entries, model));
    const sourceCards = sources.createNode(model.sources);
    if (sourceCards) panel.appendChild(sourceCards);
    section.append(header, panel);
    function updateVisibility() {
      const expanded = !hasFinalAnswer || state.expanded;
      panel.hidden = !expanded;
      toggle.textContent = expanded ? "Hide timeline" : "Show timeline";
      toggle.setAttribute("aria-expanded", String(expanded));
    }
    toggle.addEventListener("click", () => {
      if (!isCurrentCompletedToggle(model.requestId, state, toggle, hasFinalAnswer)) return;
      state.expanded = !state.expanded;
      updateVisibility();
      onVisibilityChange?.();
    });
    updateVisibility();
    return section;
  }

  function forget(requestId) {
    requests.delete(requestId);
    tools.forget(requestId);
    delegations.forget(requestId);
    returns.forget(requestId);
  }

  function reset() {
    requests.clear();
    tools.reset();
    delegations.reset();
    returns.reset();
  }

  return { createNode, forget, reset, handlesProgressUpdates: true };
}
