/** Event-driven motion gate. No frame loop, model request or refresh timer. */
export function createAgentMotion(root) {
  const doc = root.ownerDocument;
  const agent = root.querySelector("[data-coworker-agent]");
  const Observer = doc.defaultView?.IntersectionObserver;
  let inViewport = true;
  let workspaceVisible = true;
  let previousObservation;
  let pulse = false;
  function sync() {
    const visible = doc.visibilityState !== "hidden" && workspaceVisible && inViewport;
    agent?.setAttribute("data-motion", visible ? "on" : "off");
  }
  const observer = Observer && agent ? new Observer((entries) => {
    inViewport = entries.some((entry) => entry.isIntersecting);
    sync();
  }) : null;
  if (agent) observer?.observe(agent);
  doc.addEventListener?.("visibilitychange", sync);
  return {
    update(snapshot) {
      workspaceVisible = snapshot.learningActive !== false || snapshot.homeActive === true;
      const observation = snapshot.status?.lastObservationAt;
      if (previousObservation && observation && previousObservation !== observation) {
        pulse = !pulse;
        agent?.setAttribute("data-observation-pulse", pulse ? "a" : "b");
      }
      previousObservation = observation;
      sync();
    },
    dispose() {
      observer?.disconnect();
      doc.removeEventListener?.("visibilitychange", sync);
      agent?.setAttribute("data-motion", "off");
    },
  };
}
