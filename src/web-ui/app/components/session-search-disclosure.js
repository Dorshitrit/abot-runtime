export function bindSessionSearchDisclosure({ toggle, field, input }) {
  function closeSearch() {
    field.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    if (input.value) {
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    toggle.focus();
  }

  toggle.addEventListener("click", () => {
    if (!field.hidden) {
      closeSearch();
      return;
    }
    field.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    input.focus();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    closeSearch();
  });
}
