import { agentColor } from "./appearance.js";

const inset = 9;
const spacing = 8;

export function currentOrbitNotice(agent) {
  if (agent.workStatus === "awaiting_approval" && agent.mission?.status === "active") {
    const target = agent.approvalAttention?.targets?.find(item => item.agentId !== agent.id);
    return { kind: "approval", missionId: agent.mission.id, createdAt: agent.mission.updatedAt || agent.mission.createdAt || "",
      text: target ? `${target.agentName} needs your approval` : "Waiting for your approval" };
  }
  const update = agent.latestWorkUpdate;
  const reply = agent.latestUnreadReply;
  const active = agent.mission?.status === "active" && ["thinking", "working"].includes(agent.workStatus);
  const work = active && update?.text?.trim() && update.missionId === agent.mission.id ? update : null;
  const unread = reply?.text?.trim() ? reply : null;
  const thinking = agent.workStatus === "thinking" && agent.mission?.status === "active" && !agent.hasWork && agent.thinkingSince
    ? { kind: "thinking", missionId: agent.mission.id, createdAt: agent.thinkingSince, text: "Thinking…" } : null;
  const activity = work ? { ...work, kind: "work" } : thinking;
  if (unread && (!activity || (activity.missionId === unread.missionId && Date.parse(unread.createdAt) >= Date.parse(activity.createdAt)))) {
    return { ...unread, kind: "reply" };
  }
  return activity;
}

function overlaps(a, b) {
  return a.left < b.right + 3 && a.right > b.left - 3 && a.top < b.bottom + 3 && a.bottom > b.top - 3;
}

function findRoom(anchor, size, bounds, occupied) {
  const { x, y, radius } = anchor, { width, height } = size;
  const above = y - radius - spacing - height, below = y + radius + 25 + spacing;
  const left = x - radius - spacing - width, right = x + radius + spacing;
  const halfway = y - height / 2;
  const sides = x < bounds.width / 2 ? [right, left] : [left, right];
  const candidates = [
    ...sides.map(side => [side, halfway]),
    [x - width / 2, above], [x - width / 2, below],
    ...sides.map(side => [side, above]), ...sides.map(side => [side, below]),
  ];
  for (const [cx, cy] of candidates) {
    const px = Math.max(inset, Math.min(bounds.width - width - inset, cx));
    const py = Math.max(inset, Math.min(bounds.height - height - inset, cy));
    const box = { left: px, top: py, right: px + width, bottom: py + height };
    if (!occupied.some(other => overlaps(box, other))) return box;
  }
  return null;
}

export function createOrbitNotices(field) {
  const layer = field.ownerDocument.createElement("div");
  layer.className = "agents-orbit-notices";
  field.appendChild(layer);
  const entries = new Map();
  let ordered = [], lastFrame = null, lastWidth = 0;

  function place() {
    if (!lastFrame || !ordered.length || layer.hidden) return;
    const { width, height, portraits } = lastFrame;
    if (width !== lastWidth) {
      for (const entry of ordered) entry.size = null;
      lastWidth = width;
    }
    const anchors = new Map();
    const occupied = [{ left: 4, right: 78, top: 4, bottom: 73 }, { left: 4, right: 86, top: height - 60, bottom: height }];
    const nameRadius = width <= 640 ? 50 : 80;
    for (const { id, point } of portraits) {
      const { x, y, size } = point, radius = size / 2 + 9;
      anchors.set(id, { x, y, radius });
      occupied.push({ left: x - radius, right: x + radius, top: y - radius - 5, bottom: y + radius });
      occupied.push({ left: x - nameRadius, right: x + nameRadius, top: y + size / 2 + 10, bottom: y + size / 2 + 33 });
    }
    for (const entry of ordered) {
      const anchor = anchors.get(entry.agentId);
      if (!entry.size) entry.size = { width: entry.node.offsetWidth, height: entry.node.offsetHeight };
      const room = anchor && findRoom(anchor, entry.size, lastFrame, occupied);
      entry.node.style.visibility = room ? "visible" : "hidden";
      if (!room) continue;
      occupied.push(room);
      entry.node.style.transform = `translate(${Math.round(room.left)}px, ${Math.round(room.top)}px)`;
    }
  }

  return {
    update(agents) {
      const present = new Set();
      for (const agent of agents) {
        const notice = currentOrbitNotice(agent);
        if (!notice) continue;
        present.add(agent.id);
        let entry = entries.get(agent.id);
        if (!entry) {
          const node = field.ownerDocument.createElement("div");
          node.className = "agents-orbit-notice";
          node.dir = "auto";
          node.setAttribute("role", "note");
          node.dataset.agentNotice = agent.id;
          layer.appendChild(node);
          entry = { agentId: agent.id, node };
          entries.set(agent.id, entry);
        }
        if (entry.node.textContent !== notice.text) {
          entry.node.textContent = notice.text;
          entry.size = null;
        }
        entry.node.setAttribute("aria-label", agent.definition.name);
        entry.node.dataset.kind = notice.kind;
        entry.node.style.setProperty("--agent-color", agentColor(agent));
        entry.createdAt = notice.createdAt;
      }
      for (const [id, entry] of entries) {
        if (present.has(id)) continue;
        entry.node.remove();
        entries.delete(id);
      }
      ordered = [...entries.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.agentId.localeCompare(b.agentId));
      place();
    },
    layout(frame) { lastFrame = frame; place(); },
    hide(value) { layer.hidden = value; if (!value) place(); },
  };
}
