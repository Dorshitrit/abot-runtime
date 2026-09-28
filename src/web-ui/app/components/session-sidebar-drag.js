export function createSessionSidebarDrag({ canMove, onMove }) {
  let sourceId = "";
  let draggedItem = null;
  let targetItem = null;

  function clearTarget() {
    targetItem?.classList.remove("session-drop-before", "session-drop-after");
    targetItem = null;
  }

  function reset() {
    clearTarget();
    draggedItem?.classList.remove("session-dragging");
    draggedItem = null;
    sourceId = "";
  }

  function placementAt(item, event) {
    const bounds = item.getBoundingClientRect();
    return event.clientY >= bounds.top + bounds.height / 2 ? "after" : "before";
  }

  function bind(item, sessionId) {
    const handle = item.querySelector(".session-open-button");
    handle.draggable = true;
    handle.addEventListener("dragstart", (event) => {
      reset();
      sourceId = sessionId;
      draggedItem = item;
      item.classList.add("session-dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", sessionId);
    });
    handle.addEventListener("dragend", reset);
    item.addEventListener("dragover", (event) => {
      clearTarget();
      if (!canMove(sourceId, sessionId)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      targetItem = item;
      item.classList.add(`session-drop-${placementAt(item, event)}`);
    });
    item.addEventListener("dragleave", (event) => {
      if (item.contains(event.relatedTarget)) return;
      clearTarget();
    });
    item.addEventListener("drop", (event) => {
      if (!canMove(sourceId, sessionId)) return;
      event.preventDefault();
      const movedSessionId = sourceId;
      const placement = placementAt(item, event);
      reset();
      onMove(movedSessionId, sessionId, placement);
    });
  }

  return { bind, reset };
}
