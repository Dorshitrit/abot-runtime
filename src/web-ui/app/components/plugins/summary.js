const SUMMARY_LABELS = [
  "Installed plugins",
  "Enabled in saved config",
  "Selected tools (saved)",
  "Excluded tools (saved)",
];

function unavailablePluginSummaryValue(state, environmentId) {
  if (state.environmentId !== environmentId) return "Not loaded";
  if (state.busy) return "Loading…";
  if (state.snapshot) return null;
  if (state.error) return "Unavailable";
  return "Not loaded";
}

/** Counts describe the saved catalog selection, never the running Runtime. */
export function projectPluginSummary(state, environmentId) {
  const unavailable = unavailablePluginSummaryValue(state, environmentId);
  if (unavailable) {
    return {
      label: "Plugins · saved configuration",
      items: SUMMARY_LABELS.map((label) => ({
        label,
        value: unavailable,
        status: true,
      })),
    };
  }
  const plugins = state.snapshot.plugins;
  const enabled = plugins.filter(
    (plugin) => plugin.pluginEnabled === true,
  ).length;
  const selected = plugins.reduce(
    (sum, plugin) => sum + plugin.selectedCapabilityCount,
    0,
  );
  const total = plugins.reduce(
    (sum, plugin) => sum + plugin.capabilityCount,
    0,
  );
  const values = [
    String(plugins.length),
    String(enabled),
    `${selected} / ${total}`,
    String(total - selected),
  ];
  return {
    label: "Plugins · saved configuration",
    items: SUMMARY_LABELS.map((label, index) => ({
      label,
      value: values[index],
    })),
  };
}
