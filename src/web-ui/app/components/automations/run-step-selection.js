import { workflowSteps } from "./run-steps-view.js";

/** Open the first displayable step while retaining an explicit selection on refresh. */
export function selectedAutomationRunStepId(run, selectedNodeId = "") {
  if (selectedNodeId) return selectedNodeId;
  return workflowSteps(run?.definition?.body)[0]?.id || "";
}
