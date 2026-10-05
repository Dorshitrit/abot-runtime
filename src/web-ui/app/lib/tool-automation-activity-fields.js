const ACTION_TITLES = Object.freeze({
  browse_catalog: "Browse tools",
  catalog: "Browse tools",
  prepare_draft: "Prepare draft",
  list_drafts: "List drafts",
  read_draft: "Read draft",
  create_draft: "Create draft",
  create_automation_draft: "Create draft",
  apply_automation_draft_changes: "Update draft",
  validate_draft: "Validate draft",
  save_agent: "Save agent",
  add_saved_agent: "Add saved agent",
});

function boundedAutomationText(value, limit = 500) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

function textField(fields, label, value, limit) {
  const text = boundedAutomationText(value, limit);
  if (text) fields.push({ label, value: text });
}

function countField(fields, label, value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) return;
  fields.push({ label, value: String(value) });
}

function hasAutomationActivityTool(tool) {
  return tool === "automations" || tool === "automation_builder";
}

/** Project only explicit Studio display metadata; never inspect a plan or draft. */
export function automationActivityFields(meta, tool) {
  if (!hasAutomationActivityTool(tool)) return null;
  const action = boundedAutomationText(meta.automationAction, 128);
  const activityTitle = Object.hasOwn(ACTION_TITLES, action)
    ? ACTION_TITLES[action]
    : "";
  const automationId = boundedAutomationText(meta.automationId, 128);
  const automationTitle = boundedAutomationText(meta.automationTitle, 160);
  const sent = [];
  textField(sent, "Action", activityTitle || action);
  textField(sent, "Automation ID", automationId);
  countField(sent, "Expected revision", meta.expectedRevision, 1);
  textField(sent, "Step ID", meta.nodeId, 128);
  textField(sent, "Agent ID", meta.agentId, 128);
  textField(sent, "View", meta.view, 128);
  textField(sent, "Tool", meta.toolName, 128);
  textField(sent, "Operation", meta.operationId, 128);
  return {
    activityTitle,
    target: automationTitle || automationId,
    sent,
  };
}
