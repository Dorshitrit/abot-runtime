import { createSystemMetricsController } from "../../controllers/system-metrics-controller.js";
import { createSystemMetricsCard, SYSTEM_METRICS_HEIGHT } from "./metrics-card.js";

/** Metrics have their own lifecycle; management/dashboard refreshes never receive sample ticks. */
export function createSystemMetricsMounts({ client, getEnvironmentId, isAvailable, documentRoot,
  Observer = documentRoot.defaultView?.IntersectionObserver }) {
  const views = new Set();
  let active = false;
  function canDisplayMetrics(view) {
    if (!active || !isAvailable() || documentRoot.visibilityState === "hidden") return false;
    if (!view.visible || !view.inViewport) return false;
    return view.environmentId === getEnvironmentId();
  }
  const controller = createSystemMetricsController({ client, getEnvironmentId,
    render(state) { for (const view of views) if (canDisplayMetrics(view)) view.card.render(state); } });
  function reconcile() { controller.setActive([...views].some(canDisplayMetrics)); }
  return {
    mount(root, onHeight) {
      const view = { environmentId: getEnvironmentId(), card: createSystemMetricsCard(root, documentRoot),
        visible: !root.hidden, inViewport: !Observer, observer: null };
      if (Observer) {
        view.observer = new Observer(entries => {
          if (!views.has(view)) return;
          view.inViewport = entries.some(entry => entry.target === root && entry.isIntersecting);
          reconcile();
        });
        view.observer.observe(root);
      }
      views.add(view); onHeight(SYSTEM_METRICS_HEIGHT); reconcile();
      return {
        setVisible(value) { if (views.has(view)) { view.visible = value; reconcile(); } },
        dispose() {
          if (!views.delete(view)) return;
          view.observer?.disconnect(); view.card.dispose(); reconcile();
        },
      };
    },
    setActive(value) { active = value; reconcile(); },
    visibilityChanged: reconcile,
    environmentChanged() { reconcile(); controller.environmentChanged(); },
    reconnect() { if ([...views].some(canDisplayMetrics)) void controller.refresh(); },
    destroy() {
      active = false; controller.destroy();
      for (const view of views) { view.observer?.disconnect(); view.card.dispose(); }
      views.clear();
    },
  };
}
