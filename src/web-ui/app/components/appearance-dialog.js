import { COLOR_PALETTES } from "../lib/color-palettes.js";

const paletteIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 0 0 17v-17Z"/><path d="M12 8h5m-5 4h7m-7 4h5"/></svg>';

export function createAppearanceDialog({ mount, onOpen, onSelect, onSelectNavigation, onSave, onClose }) {
  const doc = mount.ownerDocument;
  const launcher = doc.createElement("button");
  launcher.type = "button";
  launcher.className = "rail-button appearance-launcher";
  launcher.title = "Appearance";
  launcher.setAttribute("aria-label", "Appearance");
  launcher.setAttribute("aria-haspopup", "dialog");
  launcher.innerHTML = `<span class="rail-icon">${paletteIcon}</span><span class="rail-button-label">Appearance</span>`;
  launcher.addEventListener("click", onOpen);
  mount.append(launcher);

  const dialog = doc.createElement("dialog");
  dialog.className = "appearance-dialog";
  dialog.setAttribute("aria-labelledby", "appearance-title");
  dialog.innerHTML = `<form class="appearance-form">
    <header class="appearance-heading">
      <h2 id="appearance-title">Appearance</h2>
      <button type="button" class="appearance-close" aria-label="Close appearance">×</button>
    </header>
    <p class="appearance-description">Choose your workspace colors and sidebar layout.</p>
    <fieldset class="appearance-palettes"><legend class="sr-only">Color palette</legend></fieldset>
    <fieldset class="appearance-navigation"><legend>Sidebar layout</legend>
      <label><input type="radio" name="navigation-display" value="labels"><span>Icons and text</span></label>
      <label><input type="radio" name="navigation-display" value="icons"><span>Icons only</span></label>
    </fieldset>
    <p class="appearance-status" role="status" aria-live="polite"></p>
    <footer class="appearance-footer"><button type="button" class="appearance-cancel">Cancel</button>
      <button type="submit" class="appearance-save">Apply</button></footer>
  </form>`;
  const choices = dialog.querySelector(".appearance-palettes");
  for (const palette of COLOR_PALETTES) {
    const card = doc.createElement("label");
    card.className = "appearance-palette";
    card.style.setProperty("--preview-bg", palette.background);
    card.style.setProperty("--preview-panel", palette.panel);
    card.style.setProperty("--preview-accent", palette.accent);
    card.innerHTML = `<input type="radio" name="color-palette" value="${palette.id}">
      <span class="appearance-preview" aria-hidden="true"><span class="appearance-preview-rail"></span>
        <span class="appearance-preview-content"><i></i><i></i><i></i><b></b></span></span>
      <span class="appearance-palette-heading"><strong>${palette.name}</strong><span class="appearance-check" aria-hidden="true">✓</span></span>
      <span class="appearance-palette-caption">${palette.description}</span>`;
    card.querySelector("input").addEventListener("change", () => onSelect(palette.id));
    choices.append(card);
  }
  const close = dialog.querySelector(".appearance-close");
  const navigation = dialog.querySelector(".appearance-navigation");
  for (const input of navigation.querySelectorAll("input"))
    input.addEventListener("change", () => onSelectNavigation(input.value));
  const cancel = dialog.querySelector(".appearance-cancel");
  const save = dialog.querySelector(".appearance-save");
  const status = dialog.querySelector(".appearance-status");
  close.addEventListener("click", onClose);
  cancel.addEventListener("click", onClose);
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); onClose(); });
  dialog.querySelector("form").addEventListener("submit", (event) => { event.preventDefault(); onSave(); });
  doc.body.append(dialog);
  return {
    render(state) {
      for (const input of choices.querySelectorAll("input")) input.checked = input.value === state.selectedId;
      for (const input of navigation.querySelectorAll("input")) input.checked = input.value === state.selectedNavigationMode;
      choices.disabled = state.pending;
      navigation.disabled = state.pending;
      close.disabled = state.pending;
      cancel.disabled = state.pending;
      save.disabled = state.pending;
      save.textContent = state.pending ? "Saving…" : "Apply";
      status.textContent = state.error || "Previewing now. Apply to save across conversations.";
      status.classList.toggle("is-error", Boolean(state.error));
      if (state.open && !dialog.open) dialog.showModal();
      if (!state.open && dialog.open) dialog.close();
    },
    destroy() { dialog.remove(); launcher.remove(); },
  };
}
