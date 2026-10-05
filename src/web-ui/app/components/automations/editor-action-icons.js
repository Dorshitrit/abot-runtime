const EDITOR_ACTION_ICONS = {
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z"/><path d="M7 3v6h10V3M7 21v-8h10v8"/>',
  build: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  publish: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5"/>',
  run: '<path d="m8 4 12 8-12 8V4Z"/>',
  activate: '<path d="M12 2v10M6 5a9 9 0 1 0 12 0"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  archive: '<rect x="3" y="3" width="18" height="4" rx="1"/><path d="M5 7v14h14V7M9 11h6"/>',
  restore: '<path d="M3 11a9 9 0 1 1 2.6 7.4M3 4v7h7"/>',
  undo: '<path d="m9 4-6 6 6 6M3 10h11a7 7 0 0 1 7 7v3"/>',
  delete: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  manage: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2"/><circle cx="15" cy="17" r="2"/>',
};

export function renderAutomationEditorIcon(name) {
  return `<svg class="automation-editor-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${EDITOR_ACTION_ICONS[name] || ""}</svg>`;
}
