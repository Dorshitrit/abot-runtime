export function createAutomationArchiveCommands({ actions, getCurrent, requireSavedGraph,
  confirmDiscard, onFilterChange }) {
  return {
    archive: async () => {
      if (!requireSavedGraph()) return;
      const current = getCurrent();
      const selected = current.automations.find((item) => item.id === current.selectedAutomationId);
      if (!selected?.publishedRevision || selected.status === "archived") return;
      if (!confirmDiscard("Archive this automation? Its schedule will pause, and its runs and reports will remain available.")) return;
      if (await actions.archive()) onFilterChange(true);
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
