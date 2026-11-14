import { matchingComposerCommands } from "../lib/composer-command.js";

export function createComposerCommandMenu({
  form,
  input,
  visible,
  definitions,
}) {
  const element = input.element || input;
  const documentRoot = form?.ownerDocument;
  if (!documentRoot?.createElement || !element.addEventListener)
    return { render() {} };
  const menu = documentRoot.createElement("div");
  menu.className = "composer-command-menu";
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", "Commands");
  menu.hidden = true;
  form.appendChild(menu);
  let entries = [],
    selected = 0,
    revision = 0,
    dismissed = "";
  function choose(entry) {
    if (!entry) return;
    input.value = `/${entry.name}`;
    dismissed = input.value;
    menu.hidden = true;
    input.focus();
  }
  function paint() {
    menu.replaceChildren();
    entries.forEach((entry, index) => {
      const button = documentRoot.createElement("button");
      button.type = "button";
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(index === selected));
      button.textContent = `/${entry.name} — ${entry.description}`;
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => choose(entry));
      menu.appendChild(button);
    });
    menu.hidden = !entries.length;
  }
  async function render() {
    const version = ++revision;
    if (!visible()) {
      menu.hidden = true;
      return;
    }
    const text = input.value;
    if (
      !/^\/\s*[a-z0-9_-]*$/i.test(text.trim()) ||
      dismissed === text
    ) {
      menu.hidden = true;
      return;
    }
    try {
      const available = await definitions();
      if (version !== revision || text !== input.value || !visible()) return;
      entries = matchingComposerCommands(text, available);
      selected = Math.min(selected, Math.max(0, entries.length - 1));
      paint();
    } catch {
      menu.hidden = true;
    }
  }
  element.addEventListener("input", () => {
    dismissed = "";
    void render();
  });
  element.addEventListener(
    "keydown",
    (event) => {
      if (menu.hidden || !visible() || event.isComposing) return;
      if (
        !["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        dismissed = input.value;
        menu.hidden = true;
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        choose(entries[selected]);
        return;
      }
      selected =
        (selected + (event.key === "ArrowDown" ? 1 : entries.length - 1)) %
        entries.length;
      paint();
    },
    true,
  );
  return { render };
}
