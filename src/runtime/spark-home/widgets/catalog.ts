export const SPARK_HOME_WIDGET_LIMIT = 10;
export const SPARK_HOME_WIDGET_MAX_HEIGHT = 600;
export const SPARK_HOME_DASHBOARD_WIDGET_MINIMUM = 3;

const dashboardWidgets = Object.freeze([
  { id: "spark-status", group: "dashboard", title: "ABot Spark", defaultHeight: 200,
    purpose: "Review SPARK's current activity and controls for collection, learning and proactive assistance." },
  { id: "conversations", group: "dashboard", title: "Conversations", defaultHeight: 200,
    purpose: "Return to recent conversations and notice unread updates through the native conversation list." },
  { id: "approvals", group: "dashboard", title: "Approvals", defaultHeight: 200,
    purpose: "See requests waiting for a user decision and open the existing approval flow." },
  { id: "recent-activity", group: "dashboard", title: "Recent activity", defaultHeight: 200,
    purpose: "Review recent work and its recorded status through the existing activity view." },
  { id: "automations", group: "dashboard", title: "Automations", defaultHeight: 200,
    purpose: "Monitor running automations and open their live progress through the existing native view." },
  { id: "computer-access", group: "dashboard", title: "Computer access", defaultHeight: 200,
    purpose: "Review the configured computer connection and its user-controlled setup options." },
] as const);

export const SPARK_HOME_DASHBOARD_WIDGET_IDS = Object.freeze(dashboardWidgets.map(widget => widget.id));

const widgets = Object.freeze([
  ...dashboardWidgets,
  { id: "memory-candidates", group: "management", title: "Memory review", defaultHeight: 360,
    purpose: "Review unconfirmed memory candidates and let the user save or delete them through ABot's controls." },
  { id: "skills", group: "management", title: "Personal Skills", defaultHeight: 400,
    purpose: "Manage personal Skills through ABot's existing editor and archive/restore controls." },
  { id: "resources", group: "management", title: "Resources", defaultHeight: 400,
    purpose: "Manage indexed Resources through ABot's existing source and indexing controls." },
  { id: "feature-discovery", group: "management", title: "Discover ABot", defaultHeight: 240,
    purpose: "Show relevant ABot features that are not enabled, with user-controlled setup; no automatic enablement." },
  { id: "system-metrics", group: "monitoring", title: "System monitor", defaultHeight: 280,
    purpose: "Show live CPU and memory usage, and temperature where available. The native card identifies computer, WSL or container scope; it owns sampling and unavailable states." },
] as const);

export type SparkHomeWidgetId = (typeof widgets)[number]["id"];
export type SparkHomeWidgetSlot = Readonly<{
  instanceId: string;
  widgetId: SparkHomeWidgetId;
  defaultHeight: number;
}>;

export function findSparkHomeWidget(value: unknown) {
  return widgets.find(widget => widget.id === value);
}

/** Placement metadata only; the trusted host owns live data, controls and authority. */
export const SPARK_HOME_WIDGET_CATALOG = Object.freeze({
  kind: "spark_home_widget_catalog_v1", authority: "passive_host_component_catalog",
  provenance: "ABot's registered system widgets", purpose: "Choose useful native components and their positions in this requested HOME page.",
  applicability: "this_requested_spark_home_only", addsUserIntent: false, grantsActionAuthority: false,
  establishesCompletion: false, maximumInstances: SPARK_HOME_WIDGET_LIMIT, maximumInstancesPerId: 1,
  selection: Object.freeze({ dashboard: Object.freeze({ minimum: SPARK_HOME_DASHBOARD_WIDGET_MINIMUM,
    ids: SPARK_HOME_DASHBOARD_WIDGET_IDS }), otherWidgets: "optional", explicitUserExclusions: "authoritative" }),
  placement: '<div data-abot-widget="WIDGET_ID"></div>',
  layout: "Use empty div slots in normal document flow, at least 280 CSS pixels wide; the host owns their bounded height and contents.",
  availability: "The host checks current data and feature availability when displayed; a widget can collapse when no relevant content exists.",
  entries: widgets,
});
