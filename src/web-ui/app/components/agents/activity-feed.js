import { escapeHtml as html, escapeAttribute as attr } from "../../lib/text-format.js";
import { agentColor } from "./appearance.js";

const nonempty = value => typeof value === "string" && value.trim().length > 0;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// Only the backend's retained public updates; never infer history from thinking or unread state.
export function selectAgentActivity(agents) {
  const events = [];
  for (const agent of Array.isArray(agents) ? agents : []) {
    if (!agent || !nonempty(agent.id) || agent.status === "archived" || agent.isDeleting) continue;
    for (const update of Array.isArray(agent.recentWorkUpdates) ? agent.recentWorkUpdates : []) {
      if (!update || !nonempty(update.id) || !nonempty(update.text) || !nonempty(update.createdAt)) continue;
      const timestamp = Date.parse(update.createdAt);
      if (!Number.isFinite(timestamp)) continue;
      events.push({ agentId: agent.id, id: update.id, text: update.text, timestamp, color: agentColor(agent),
        agentName: nonempty(agent.definition?.name) ? agent.definition.name : "Agent",
        sourceAgentName: nonempty(update.sourceAgentName) ? update.sourceAgentName : "" });
    }
  }
  events.sort((a, b) => b.timestamp - a.timestamp || compare(a.agentId, b.agentId) || compare(a.id, b.id) || compare(a.text, b.text) || compare(a.sourceAgentName, b.sourceAgentName) || compare(a.agentName, b.agentName));
  const seen = new Set();
  return events.filter(event => {
    const key = JSON.stringify([event.agentId, event.id]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, 10);
}

export function renderAgentActivity(agents) {
  const events = selectAgentActivity(agents);
  const heading = '<h2>Recent activity</h2>';
  if (!events.length) return heading + '<p class="agents-activity-empty">No recent activity.</p>';
  const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
  return heading + '<ol>' + events.map(event => {
    const date = new Date(event.timestamp).toISOString();
    const source = event.sourceAgentName ? '<small dir="auto">From ' + html(event.sourceAgentName) + '</small>' : '';
    return '<li><button type="button" class="agents-activity-item" data-agent-id="' + attr(event.agentId) + '" style="--agent-color:' + attr(event.color) + '"><strong dir="auto">' + html(event.agentName) + '</strong>' + source +
      '<span class="agents-activity-text" dir="auto">' + html(event.text) + '</span><time dir="auto" datetime="' + date + '" title="' + date + '">' + html(dateTime.format(event.timestamp)) + '</time></button></li>';
  }).join('') + '</ol>';
}
