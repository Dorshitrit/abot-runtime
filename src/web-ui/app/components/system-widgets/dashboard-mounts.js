const dashboardIds = Object.freeze({
  "spark-status": "learning", conversations: "conversations", approvals: "approvals",
  "recent-activity": "activity", automations: "automations", "computer-access": "computer",
});
export const DASHBOARD_SYSTEM_WIDGET_HEIGHTS = Object.freeze(
  Object.fromEntries(Object.keys(dashboardIds).map(id => [id, 200])),
);
export function isDashboardSystemWidget(id) { return Object.hasOwn(dashboardIds, id); }

/** Reuse the existing Dashboard's live panels and previews; never create another data owner. */
export function createDashboardSystemWidgetMounts({ registry, getEnvironmentId, isAvailable }) {
  const mounted = new Set();
  let active = false;
  function canUseDashboardMount(view) {
    if (!active || !isAvailable()) return false;
    return view.environmentId === getEnvironmentId();
  }
  function reconcile() {
    for (const view of mounted) view.mount.setActive(canUseDashboardMount(view));
  }
  return {
    mount(root, id, onHeight) {
      if (!isDashboardSystemWidget(id) || !registry?.mount) {
        onHeight(0);
        return { dispose() {} };
      }
      const mount = registry.mount(root, dashboardIds[id], onHeight);
      const view = { mount, environmentId: getEnvironmentId() };
      mounted.add(view);
      mount.setActive(canUseDashboardMount(view));
      return { dispose() {
        if (!mounted.delete(view)) return;
        mount.dispose();
      } };
    },
    setActive(value) { active = value; reconcile(); },
    environmentChanged: reconcile,
    destroy() {
      active = false;
      for (const view of mounted) view.mount.dispose();
      mounted.clear();
    },
  };
}
