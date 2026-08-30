const MEMORY_ICONS = Object.freeze({
  add: '<path d="M12 5v14M5 12h14" />',
  close: '<path d="m6 6 12 12M18 6 6 18" />',
  delete: '<path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" />',
  edit: '<path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z" />',
  expand: '<path d="m7 10 5 5 5-5" />',
  refresh:
    '<path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5" />',
  search: '<circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />',
});

export function renderMemoryIcon(name) {
  const paths = MEMORY_ICONS[name];
  if (!paths) return "";
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
}
