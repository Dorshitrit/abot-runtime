import { coWorkerActivityStates, coWorkerActivityTones, coWorkerAgentState } from "./agent-state.js";
import { isObservationReviewActive } from "./processing-state.js";

const glyph = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3c0 6-3 9-9 9 6 0 9 3 9 9 0-6 3-9 9-9-6 0-9-3-9-9Z"/><path d="M18 3v4m-2-2h4"/></svg>`;

export function agentMarkup({ compact = false, actionMarkup = "" } = {}) {
  return `<section class="co-worker-agent${compact ? " co-worker-agent-compact" : ""}" data-coworker-agent data-agent-mode="quiet" data-motion="off" aria-label="ABot Spark activity">
    <div class="co-worker-agent-main">
      <div class="co-worker-art" aria-hidden="true"><div class="co-worker-wave"></div><div class="co-worker-orbit"><i data-orbit-phase="collection"></i><i data-orbit-phase="processing"></i><i data-orbit-phase="proactive"></i></div><div class="co-worker-core">${glyph}</div><div class="co-worker-spark"></div></div>
      <div class="co-worker-agent-copy"><span class="co-worker-agent-label" data-agent-status>Connecting</span><h3 data-agent-title tabindex="-1" data-learning-heading>ABot Spark</h3><p data-agent-description></p></div>
      ${actionMarkup}
    </div>
    <div class="co-worker-phases">
      <div class="co-worker-phase" data-agent-phase="collection"><span>Collection</span><p data-agent-collection data-learning-state>—</p><small data-agent-collection-time></small></div>
      <div class="co-worker-phase" data-agent-phase="processing" data-agent-processing-phase><span>Learning</span><p data-agent-processing role="status">—</p><small data-agent-processing-time></small></div>
      <div class="co-worker-phase" data-agent-phase="proactive"><span>Proactive</span><p data-agent-proactive>—</p><small data-agent-proactive-time></small></div>
    </div>
  </section>`;
}

export function renderAgent(root, snapshot) {
  const agent = root.querySelector("[data-coworker-agent]");
  if (!agent) return;
  const state = coWorkerAgentState(snapshot);
  agent.setAttribute("data-agent-mode", state.mode);
  agent.querySelector("[data-agent-processing-phase]").setAttribute("data-processing-active", String(!snapshot.statusError && isObservationReviewActive(snapshot.status)));
  const setText = (selector, value) => { const node = agent.querySelector(selector); if (node.textContent !== value) node.textContent = value; };
  setText("[data-agent-status]", state.label);
  setText("[data-agent-title]", state.title);
  setText("[data-agent-description]", state.description);
  const tones = coWorkerActivityTones(snapshot.status);
  for (const [key, [label, time]] of Object.entries(coWorkerActivityStates(snapshot.status))) {
    const tone = snapshot.statusError ? "attention" : tones[key];
    setText(`[data-agent-${key}]`, label);
    agent.querySelector(`[data-agent-${key}]`).setAttribute("data-phase-state", tone);
    agent.querySelector(`[data-agent-phase="${key}"]`).setAttribute("data-phase-state", tone);
    agent.querySelector(`[data-orbit-phase="${key}"]`).setAttribute("data-phase-state", tone);
    setText(`[data-agent-${key}-time]`, time);
  }
}
