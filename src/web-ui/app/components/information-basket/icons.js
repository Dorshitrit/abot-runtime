const paths = Object.freeze({
  basket: '<path d="M3 8h18v13H3zM2 3h20v5H2zm7 9h6" />',
  folder: '<path d="M3 20V5h7l2 3h9v12z" />',
  file: '<path d="M5 3h9l5 5v13H5zM14 3v6h5M8 13h8m-8 4h6" />',
  link: '<path d="m10 13 4-4m-6 6-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 3 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(2 0) scale(.85)" />',
  index: '<path d="M4 4h16v16H4zM8 8h8M8 12h8M8 16h4" />',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 3M18 18a8 8 0 0 1-13-3" />',
  search: '<circle cx="10" cy="10" r="6" /><path d="m15 15 6 6" />',
});
export function basketIcon(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.file}</svg>`;
}
