export function isSparkModelUnavailable(configuration) {
  if (!configuration?.sessionId) return false;
  if (!configuration.modelProfileId) return true;
  return configuration.modelAvailable === false;
}

function presentation(configuration) {
  if (!configuration?.sessionId) return { title: "SPARK", copy: "Loading your conversation…" };
  if (isSparkModelUnavailable(configuration)) return {
    title: "Choose a model for SPARK",
    copy: configuration.modelProfileId
      ? "The model selected for SPARK is no longer available. Choose a model under Proactive mode in SPARK settings."
      : "Before we can chat, choose a model under Proactive mode in SPARK settings.",
    needsModel: true,
  };
  return { title: "Hey, I’m SPARK 👋", copy: "What’s on your mind?" };
}

/** Keep setup guidance local to the companion's otherwise ordinary empty view. */
export function createSparkChatEmptyState({ getConfiguration, onOpenModelSettings }) {
  return {
    render(container) {
      const documentRoot = container.ownerDocument;
      const model = presentation(getConfiguration());
      const empty = documentRoot.createElement("div");
      empty.className = "empty-state chat-empty-state";
      const title = documentRoot.createElement("div");
      title.className = "mode-empty-title";
      title.textContent = model.title;
      const copy = documentRoot.createElement("div");
      copy.className = "mode-empty-copy";
      copy.textContent = model.copy;
      empty.append(title);
      empty.append(copy);
      if (model.needsModel) {
        const action = documentRoot.createElement("button");
        action.setAttribute("type", "button");
        action.textContent = "Choose model";
        action.addEventListener("click", onOpenModelSettings);
        empty.append(action);
      }
      container.append(empty);
    },
  };
}
