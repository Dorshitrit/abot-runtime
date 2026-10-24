export function createAutomationArchiveCommands({ actions, getCurrent, requireSavedGraph,
  confirmations, onFilterChange }) {
  return {
    archive: async () => {
      if (!requireSavedGraph()) return;
      const current = getCurrent();
      const selected = current.automations.find((item) => item.id === current.selectedAutomationId);
      if (!selected?.publishedRevision || selected.status === "archived") return;
      const archived = await confirmations.run(
        "Archive this automation? Its schedule will pause, and its runs and reports will remain available.",
        { title: "Archive automation", confirmLabel: "Archive", tone: "danger" }, () => actions.archive());
      if (archived) onFilterChange(true);
    },
    restore: async () => {
      if (!requireSavedGraph()) return;
      const current = getCurrent();
      const selected = current.automations.find((item) => item.id === current.selectedAutomationId);
      if (selected?.status !== "archived") return;
      if (await actions.restore()) onFilterChange(false);
    },
  };
}
