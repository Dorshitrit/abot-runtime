const paths = {
  upload: '<path d="M12 16V4m-4 4 4-4 4 4"/><path d="M4 16v4h16v-4"/>',
  job: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18m-9 3v4m-2-2h4"/>',
  conversations:
    '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/>',
  configuration:
    '<path d="M4 7h9m4 0h3M4 17h3m4 0h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  arrow: '<path d="M7 17 17 7M7 7h10v10"/>',
  success: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  failed: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4h.01"/>',
  active: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  neutral: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
  briefing:
    '<rect x="4" y="4" width="16" height="17" rx="2"/><path d="M8 8h8M8 12h3m3 0h2m-8 4h8"/>',
  learning:
    '<path d="M12 5v16m0-16C8 2 4 3 2 4v15c3-1 6-1 10 2 4-3 7-3 10-2V4c-2-1-6-2-10 1Z"/>',
  reflection:
    '<rect x="5" y="3" width="15" height="18" rx="2"/><path d="M3 7h4M3 12h4M3 17h4m5-9h4m-4 4h4"/>',
};

export function dashboardIcon(name) {
  return `<svg aria-hidden="true" viewBox="0 0 24 24">${paths[name] || paths.neutral}</svg>`;
}
