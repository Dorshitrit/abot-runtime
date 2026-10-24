import { captureAutomationConfirmationScope } from "./confirmation-actions.js";
import { focusSelectedAutomationStep } from "./run-steps-view.js";

/** Clean navigation stays synchronous; an async discard approval is never truthy permission. */
export function createAutomationWorkspaceNavigation({ actions, getCurrent, getEditRevision, prepareLeave, root }) {
  let requestRevision = 0;
  function leave(operation) {
    const revision = ++requestRevision;
    const isCurrent = captureAutomationConfirmationScope({ actions, getCurrent, getEditRevision });
    function commit(approved) {
      if (approved !== true && typeof approved !== "function") return false;
      if (revision !== requestRevision) return false;
      if (!isCurrent()) return false;
      if (approved?.canCommit?.() === false) return false;
      if (typeof approved === "function" && approved() === false) return false;
      return operation();
    }
    const approved = prepareLeave();
    if (typeof approved?.then === "function") return Promise.resolve(approved).then(commit);
    return commit(approved);
  }
  function selectNode(element) {
    return leave(() => {
      const current = getCurrent();
      const nodeId = element.dataset.selectNode || element.dataset.automationNode || "";
      if (nodeId === current.selectedNodeId || !nodeId) { actions.selectNode(""); return; }
      const nodeButton = element.dataset.automationNode !== undefined ? element
        : [...root.querySelectorAll("[data-automation-node]")]
          .find((item) => item.dataset.automationNode === nodeId);
      if (element.dataset.selectNode !== undefined)
        nodeButton?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      actions.selectNode(nodeId);
      if (current.selectedRunId) focusSelectedAutomationStep(root);
    });
  }
  return { leave, selectNode };
}
