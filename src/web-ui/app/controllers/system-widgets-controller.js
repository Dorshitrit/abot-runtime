import { createKnowledgeCandidateActions } from "./knowledge-candidate-actions.js";

const widgetSources = {
  "memory-candidates": ["candidates"], skills: ["skills"], resources: ["resources"],
  "feature-discovery": ["learning", "skills", "resources"],
};

/** Live, environment-bound data for native widgets in any host surface. Never enters generated HTML. */
export function createSystemWidgetsController({ client, getEnvironmentId, isAvailable = () => true, render }) {
  let environmentId = getEnvironmentId();
  let epoch = 0;
  let read = 0;
  let active = false;
  let widgetIds = [];
  let sources = {};
  const candidates = () => sources.candidates?.data?.items || [];
  const candidateActions = createKnowledgeCandidateActions({ client, getEnvironmentId, getCandidates: candidates,
    isRuntimeReady: () => active && isAvailable(), onChange: publish,
    onCommitted: async ({ id }) => {
      sources.candidates = { ...sources.candidates, data: { items: candidates().filter(item => item.id !== id) } };
      publish(); await refresh();
    },
  });
  function snapshot() {
    return { environmentId, sources: { ...sources }, candidates: candidates(), ...candidateActions.snapshot() };
  }
  function publish() { render(snapshot()); }
  function requiredSources() { return [...new Set(widgetIds.flatMap(id => widgetSources[id] || []))]; }
  function canReadSource(source) {
    if (source === "skills") return client.supportsSkills?.() === true;
    if (source === "resources") return client.supportsInformationBasket?.() === true;
    if (source === "learning") return typeof client.loadPassiveLearning === "function";
    return typeof client.listPassiveLearningCandidates === "function";
  }
  function requestSource(source, environment) {
    if (source === "skills") return client.listPersonalSkills(environment);
    if (source === "resources") return client.listInformationBasket(environment);
    if (source === "learning") return client.loadPassiveLearning(environment);
    return client.listPassiveLearningCandidates(environment);
  }
  async function refresh() {
    if (!active || !isAvailable()) return;
    const scope = { environmentId: getEnvironmentId(), epoch, read: ++read };
    const current = () => scope.epoch === epoch && scope.read === read && scope.environmentId === getEnvironmentId();
    const needed = requiredSources();
    for (const source of needed) sources[source] = { ...sources[source], loading: canReadSource(source), error: "",
      supported: canReadSource(source) };
    publish();
    await Promise.all(needed.map(async source => {
      if (!canReadSource(source)) return;
      try {
        const data = await requestSource(source, scope.environmentId);
        if (current()) sources[source] = { data, loading: false, error: "", supported: true };
      } catch {
        if (current()) sources[source] = { loading: false, error: "Could not refresh. Try again.", supported: true };
      }
      if (current()) publish();
    }));
  }
  return {
    ...candidateActions, snapshot, refresh,
    setWidgets(ids) {
      const next = [...new Set(ids.filter(id => Object.hasOwn(widgetSources, id)))].sort();
      if (JSON.stringify(next) === JSON.stringify(widgetIds)) return;
      widgetIds = next; void refresh();
    },
    setActive(value) { const entered = value && !active; active = value; if (entered) void refresh(); },
    environmentChanged() {
      epoch += 1; read += 1; environmentId = getEnvironmentId(); sources = {}; candidateActions.reset();
      publish(); if (active) void refresh();
    },
  };
}
