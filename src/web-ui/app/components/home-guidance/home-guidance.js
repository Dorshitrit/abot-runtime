import { createSystemHostVisibility } from "../system-host/visibility.js";
import { hasIndependentHomeActivity } from "../passive-learning/home.js";
import { selectHomeSuggestion } from "./suggestion-policy.js";
import { createHomeGuidancePreferences } from "../../services/home-guidance-preferences.js";
import { createDailyMemoryReview } from "../../controllers/daily-memory-review.js";
import { createDailyReviewDialog } from "./daily-review.js";
import { createDailyReviewEntry } from "./daily-review-entry.js";

export function createHomeGuidance({ container, homeRegion, client, getEnvironmentId,
  getLearningSnapshot, getConnectionState, supportsConnection, refreshConnection,
  onOpen, isRuntimeReady = () => true, storage }) {
  const documentRoot = container?.ownerDocument;
  if (!documentRoot) return { render() {}, dispose() {} };
  let preferenceStorage = storage;
  try { preferenceStorage ??= documentRoot.defaultView?.localStorage; } catch { /* Session-only preferences. */ }
  const preferences = createHomeGuidancePreferences(preferenceStorage);
  const root = documentRoot.createElement("aside");
  root.className = "home-guidance";
  root.hidden = true;
  root.setAttribute("aria-label", "Setup suggestion");
  root.innerHTML = `<div class="home-guidance-copy"><h3 class="home-row-title"></h3><p class="home-row-detail"></p></div>
    <button type="button" class="home-text-button" data-guidance-open></button>
    <button type="button" class="home-text-button" data-guidance-dismiss aria-label="Dismiss this suggestion" title="Hide this suggestion"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" /></svg></button>`;
  const reviewEntry = createDailyReviewEntry({ container, onOpen: openMemoryReview });
  container.prepend(root);
  let environment = getEnvironmentId();
  let revision = 0;
  let memory = null;
  let plugins = null;
  let visible = false;
  let loaded = false;
  let loading = false;
  let disposed = false;
  let hiddenThisVisit = false;
  let selected = null;
  let reviewDismissed = false;
  let openingReview = false;
  let review;
  const dialog = createDailyReviewDialog({ container,
    onDecision: (action) => review.decide(action),
    onDismiss: () => { reviewDismissed = true; render(); },
  });
  review = createDailyMemoryReview({ client, getEnvironmentId, preferences, render: (snapshot) => {
    dialog.render(snapshot);
    if (canOfferDailyReview(snapshot) && dialog.canOpen() && review.markOffered()) dialog.open();
    renderSuggestion();
  } });
  root.querySelector("[data-guidance-open]").addEventListener("click", () => {
    if (root.hidden || !selected) return;
    onOpen(selected.id);
  });
  root.querySelector("[data-guidance-dismiss]").addEventListener("click", () => {
    if (!selected) return;
    preferences.dismiss(environment, selected.id);
    hiddenThisVisit = true;
    renderSuggestion();
  });
  const visibility = createSystemHostVisibility({ documentRoot, getRoot: () => homeRegion,
    isActive: () => Boolean(homeRegion), onChange: visibilityChanged });

  async function loadSuggestions() {
    if (loading || disposed || !visible || !isRuntimeReady()) return;
    loading = true;
    const operation = ++revision;
    const target = getEnvironmentId();
    const [memoryRead, pluginsRead] = await Promise.allSettled([
      client.loadLongTermMemoryStatus(target), client.getRuntimePlugins(target),
    ]);
    if (operation !== revision || target !== getEnvironmentId() || disposed) return;
    memory = memoryRead.status === "fulfilled" ? memoryRead.value?.status : null;
    plugins = pluginsRead.status === "fulfilled" ? pluginsRead.value : null;
    loading = false;
    loaded = true;
    render();
  }
  function renderSuggestion() {
    reviewEntry.render({ visible: canShowMemoryReviewEntry(),
      remaining: review?.snapshot().remaining || 0, loading: openingReview });
    selected = selectHomeSuggestion({ memory, plugins,
      connection: supportsConnection() ? getConnectionState() : null,
      dismissed: preferences.dismissed(environment) });
    root.hidden = !visible || hiddenThisVisit || dialog.isOpen() || !selected;
    if (root.hidden) return;
    root.querySelector("h3").textContent = selected.title;
    root.querySelector("p").textContent = selected.description;
    root.querySelector("[data-guidance-open]").textContent = selected.action;
  }
  function hasCurrentLearningActivity() {
    const learning = getLearningSnapshot();
    if (learning?.environmentId !== environment || learning.statusError) return false;
    return hasIndependentHomeActivity(learning.status);
  }
  function canReviewSavedMemories() {
    if (disposed || !visible || !isRuntimeReady()) return false;
    if (memory?.enabled === false) return false;
    if (memory?.available === false) return false;
    if (hasCurrentLearningActivity()) return true;
    return memory?.enabled === true && memory?.available !== false;
  }
  function canShowMemoryReviewEntry() {
    if (!canReviewSavedMemories() || dialog.isOpen()) return false;
    return review?.snapshot().remaining > 0;
  }
  function canOfferDailyReview(snapshot) {
    if (!visible || reviewDismissed || !snapshot.remaining) return false;
    return hasCurrentLearningActivity();
  }
  async function openMemoryReview() {
    if (openingReview || !canReviewSavedMemories() || !dialog.canOpen()) return;
    const operation = revision;
    const target = environment;
    openingReview = reviewDismissed = true;
    renderSuggestion();
    const loadedReview = await review.loadForReview();
    if (disposed || operation !== revision || target !== getEnvironmentId()) return;
    openingReview = false;
    if (loadedReview && canReviewSavedMemories() && dialog.canOpen()) {
      review.markOffered();
      dialog.open();
    }
    renderSuggestion();
  }
  function syncEnvironment() {
    const next = getEnvironmentId();
    if (next === environment) return;
    revision += 1;
    environment = next;
    memory = plugins = null;
    loaded = loading = hiddenThisVisit = reviewDismissed = openingReview = false;
    dialog.hide();
    review.reset();
  }
  function render() {
    if (disposed) return;
    syncEnvironment();
    if (visible && !loaded && !loading) void loadSuggestions();
    const canReview = canReviewSavedMemories();
    review.update(canReview);
    if (!canReview) dialog.hide();
    renderSuggestion();
  }
  function visibilityChanged() {
    if (disposed) return;
    const next = visibility.isVisible();
    if (next === visible) return;
    visible = next;
    if (visible) {
      hiddenThisVisit = reviewDismissed = false;
      loaded = false;
      if (supportsConnection()) void refreshConnection();
    } else {
      openingReview = false;
      dialog.hide();
    }
    render();
  }
  visibility.watch();
  visibilityChanged();
  return { render, dispose() { disposed = true; revision += 1; review.reset(); visibility.dispose(); dialog.dispose(); reviewEntry.dispose(); root.remove(); } };
}
