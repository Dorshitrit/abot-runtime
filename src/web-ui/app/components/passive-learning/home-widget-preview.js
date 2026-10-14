import { coWorkerActivityStates, coWorkerActivityTones } from "./agent-state.js";

const indicators = {
  off: { icon: "paused", tone: "neutral" },
  waiting: { icon: "active", tone: "neutral" },
  ready: { icon: "success", tone: "success" },
  active: { icon: "active", tone: "active" },
  attention: { icon: "failed", tone: "attention" },
};

/** Read-only projection of the same activity states used by the expanded owner. */
export function learningWidgetPreview(status) {
  if (!status?.preferences) return null;
  const states = coWorkerActivityStates(status);
  const tones = coWorkerActivityTones(status);
  return {
    kind: "metrics",
    items: [
      ["collection", "Collection"],
      ["processing", "Learning"],
      ["proactive", "Proactive"],
    ].map(([key, label]) => {
      const indicator = { ...(indicators[tones[key]] || indicators.off) };
      indicator.label = [label, ...states[key]].filter(Boolean).join(": ");
      if (key === "collection" && tones[key] === "active") indicator.icon = "collecting";
      if (key === "processing" && ["ready", "waiting"].includes(tones[key])
        && Number.isFinite(status.pendingObservations) && status.pendingObservations > 0)
        indicator.value = status.pendingObservations;
      return { label, indicator };
    }),
  };
}
