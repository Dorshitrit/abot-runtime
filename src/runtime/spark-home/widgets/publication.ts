import { SPARK_HOME_DASHBOARD_WIDGET_IDS, SPARK_HOME_DASHBOARD_WIDGET_MINIMUM } from "./catalog.js";
import { captureSparkHomeWidgetSlots } from "./slots.js";

const dashboardIds: ReadonlySet<string> = new Set(SPARK_HOME_DASHBOARD_WIDGET_IDS);

/** Validate new generated pages using the same distinct static slots as the Web host. */
export function hasRequiredSparkHomeDashboardWidgets(html: string): boolean {
  const { slots } = captureSparkHomeWidgetSlots(html);
  const dashboardCount = slots.filter(slot => dashboardIds.has(slot.widgetId)).length;
  return dashboardCount >= SPARK_HOME_DASHBOARD_WIDGET_MINIMUM;
}
