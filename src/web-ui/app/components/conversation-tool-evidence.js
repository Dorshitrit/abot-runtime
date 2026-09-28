function text(value) {
  return typeof value === "string" ? value : "";
}

function hasRecordedFields(fields) {
  return Array.isArray(fields) && fields.length > 0;
}

function hasNoDisplayEvidence(fields, blocks) {
  if (hasRecordedFields(fields)) return false;
  return blocks.length === 0;
}

function repeatsActionTarget(field, target) {
  if (!target || field.value !== target) return false;
  return ["Path", "Folder", "Memory ID", "Target", "Source", "Query"].includes(
    field.label,
  );
}

function isTextInputField(field) {
  return [
    "Content excerpt",
    "Instruction",
    "Command",
    "Command excerpt",
    "Typed text",
    "Typed text excerpt",
  ].includes(field.label);
}

function inputBlockLabel(field, executed) {
  if (field.label === "Typed text")
    return executed ? "Sent text" : "Prepared text";
  if (field.label === "Typed text excerpt")
    return executed ? "Sent text excerpt" : "Prepared text excerpt";
  if (field.label === "Instruction") return "Instruction";
  if (field.label === "Command")
    return executed ? "Sent command" : "Prepared command";
  if (field.label === "Command excerpt")
    return executed ? "Sent command excerpt" : "Prepared command excerpt";
  if (executed) return "Sent content excerpt";
  return "Prepared content excerpt";
}

/** Render recorded evidence consistently in approval and activity surfaces. */
export function createConversationToolEvidence(
  action,
  { documentRoot = document, hideRepeatedTarget = false } = {},
) {
  function element(tag, className, value = "") {
    const node = documentRoot.createElement(tag);
    node.className = className;
    node.textContent = text(value);
    return node;
  }

  function isolatedText(tag, className, value) {
    const node = element(tag, className, value);
    node.setAttribute("dir", "auto");
    return node;
  }

  function evidencePanel(title, fields, blocks = []) {
    if (hasNoDisplayEvidence(fields, blocks)) return null;
    const panel = element("section", "conversation-tool-evidence");
    panel.setAttribute("aria-label", title);
    if (hasRecordedFields(fields)) {
      const list = element("dl", "conversation-tool-fields");
      for (const field of fields) {
        const row = element("div", "conversation-tool-field");
        const label = isolatedText(
          "dt",
          "conversation-tool-field-label",
          field.label,
        );
        const value = element("dd", "conversation-tool-field-value");
        value.appendChild(isolatedText("bdi", "", field.value));
        row.append(label, value);
        list.appendChild(row);
      }
      panel.appendChild(list);
    }
    for (const block of blocks) {
      const content = element("div", "conversation-tool-text-block");
      content.appendChild(
        element("p", "conversation-tool-preview-label", block.label),
      );
      const preview = isolatedText(
        "pre",
        "conversation-tool-preview",
        block.value,
      );
      preview.setAttribute("aria-label", block.label);
      content.appendChild(preview);
      panel.appendChild(content);
    }
    return panel;
  }

  const input = (action.sent || []).filter(
    (field) =>
      !hideRepeatedTarget || !repeatsActionTarget(field, action.target),
  );
  const labels = action.executed
    ? ["Sent", "Received"]
    : ["Prepared input", "Status"];
  const preview = text(action.preview);
  const panels = [
    evidencePanel(
      labels[0],
      input.filter((field) => !isTextInputField(field)),
      input.filter(isTextInputField).map((field) => ({
        ...field,
        label: inputBlockLabel(field, action.executed),
      })),
    ),
    evidencePanel(
      labels[1],
      action.received,
      preview
        ? [
            {
              label: action.executed ? "Returned excerpt" : "Status",
              value: preview,
            },
          ]
        : [],
    ),
  ].filter(Boolean);
  if (panels.length === 0) return null;
  const groups = element("div", "conversation-tool-panels");
  groups.append(...panels);
  return groups;
}
