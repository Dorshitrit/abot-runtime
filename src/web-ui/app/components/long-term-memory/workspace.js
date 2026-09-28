function memoryTabIndexForKey(key, index, count) {
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowRight") return (index + 1) % count;
  if (key === "ArrowLeft") return (index + count - 1) % count;
  return -1;
}

export function createMemoryWorkspace({ root }) {
  const tabs = ["memories", "setup"].map((name) => ({
    name,
    button: root?.querySelector('[data-memory-tab="' + name + '"]'),
    panel: root?.querySelector('[data-memory-panel="' + name + '"]'),
  }));

  function hasMemoryTabSurface(tab) {
    if (!tab?.button) return false;
    return Boolean(tab.panel);
  }

  function activate(name, { focus = false } = {}) {
    const selected = tabs.find((tab) => tab.name === name);
    if (!hasMemoryTabSurface(selected)) return false;
    for (const tab of tabs) {
      if (!hasMemoryTabSurface(tab)) continue;
      const active = tab === selected;
      tab.panel.hidden = !active;
      tab.button.setAttribute("aria-selected", String(active));
      tab.button.tabIndex = active ? 0 : -1;
      tab.button.classList.toggle("active", active);
    }
    if (focus) selected.button.focus();
    return true;
  }

  tabs.forEach((tab, index) => {
    if (!hasMemoryTabSurface(tab)) return;
    tab.button.addEventListener("click", () => activate(tab.name));
    tab.button.addEventListener("keydown", (event) => {
      const nextIndex = memoryTabIndexForKey(event.key, index, tabs.length);
      if (nextIndex < 0) return;
      event.preventDefault();
      activate(tabs[nextIndex].name, { focus: true });
    });
  });
  activate("memories");
  return { activate };
}
