import { getRecord, titleCaseEventValue } from "./event-presentation.js";

const TOOL_EVENTS = new Set([
  "tool.payload.started",
  "tool.payload.completed",
  "tool.payload.failed",
  "tool.approval.required",
  "tool.approval.granted",
  "tool.approval.rejected",
  "tool.started",
  "tool.completed",
  "tool.failed",
]);

function boundedText(value, limit = 500) {
  if (typeof value !== "string") return "";
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function finiteCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function payloadStageMetadata(message) {
  if (!Number.isSafeInteger(message.payloadStage)) return {};
  if (!Number.isSafeInteger(message.payloadStageCount)) return {};
  if (message.payloadStage < 1) return {};
  if (message.payloadStage > message.payloadStageCount) return {};
  return {
    payloadStage: message.payloadStage,
    payloadStageCount: message.payloadStageCount,
  };
}

function addText(fields, label, value) {
  const text = boundedText(value).trim();
  if (text) fields.push({ label, value: text });
}

function addCount(fields, label, value) {
  if (finiteCount(value)) fields.push({ label, value: String(value) });
}

function lineRange(start, end) {
  if (!finiteCount(start)) return "";
  return finiteCount(end) ? `${start}–${end}` : `From ${start}`;
}

function inputFields(meta, completed, tool) {
  const fields = [];
  addText(fields, "Query", meta.query);
  addText(fields, "Path", meta.path);
  if (!meta.source || meta.displayTarget !== ".")
    addText(fields, "Target", meta.displayTarget);
  addText(fields, "Source", meta.source);
  addText(fields, "Folder", meta.searchRoot);
  addText(fields, "Mode", meta.searchMode);
  addText(fields, "Find", meta.locator);
  addText(fields, "Instruction", meta.instruction);
  addText(fields, "Memory ID", meta.id);
  addText(
    fields,
    tool === "edit_file" ? "Instruction" : "Content excerpt",
    meta.inputPreview,
  );
  addCount(fields, "Content characters", meta.contentLength);
  addCount(fields, "Offset", meta.offset ?? meta.params?.offset);
  addCount(fields, "Limit", meta.limit ?? meta.params?.limit);
  addCount(fields, "Depth", meta.depth);
  addCount(fields, "Maximum depth", meta.maxDepth);
  addCount(fields, "Maximum entries", meta.maxEntries);
  addCount(fields, "Maximum symbols", meta.maxSymbols);
  addCount(fields, "Character limit", meta.maxChars);
  if (!completed)
    addCount(fields, "Requested character offset", meta.startChar);
  if (!completed)
    addText(fields, "Requested lines", lineRange(meta.startLine, meta.endLine));
  return fields;
}

function resultCountLabel(tool) {
  if (tool === "memory_get") return "Stored records";
  if (tool === "memory_search") return "Matching records";
  if (tool === "local_search") return "Returned matches";
  if (tool === "web_search") return "Results";
  return "Items";
}

function resultFields(meta, tool, ok) {
  const fields = [];
  if (hasCompletedFileWindow(meta, ok)) {
    addText(fields, "Read lines", lineRange(meta.startLine, meta.endLine));
  }
  addText(
    fields,
    "Changed lines",
    lineRange(meta.changedStartLine, meta.changedEndLine),
  );
  addText(fields, "Edit", titleCaseEventValue(meta.operation));
  addCount(fields, "Bytes", meta.byteCount);
  addCount(fields, "Input bytes", meta.inputBytes);
  addCount(fields, "File lines", meta.lineCount);
  addCount(fields, "Total characters", meta.totalCharacters);
  if (ok === true && tool === "document_reader") {
    addCount(fields, "Start character", meta.startChar);
    addCount(fields, "End character", meta.endChar);
  }
  addCount(fields, "Directory entries", meta.returnedEntries);
  addResultCounts(fields, meta, tool);
  addCount(fields, "Deleted records", meta.deletedCount);
  addCount(fields, "Next offset", meta.nextOffset);
  addText(fields, "Saved memory ID", meta.savedId);
  addText(fields, "Document", meta.documentName);
  if (typeof meta.syntaxValid === "boolean") {
    addText(fields, "JSON syntax", meta.syntaxValid ? "Valid" : "Invalid");
  }
  addText(fields, "Error", meta.errorCode);
  if (meta.state === "establish_target")
    addText(fields, "Change", "Created file");
  if (meta.state === "refine_target")
    addText(fields, "Change", "Replaced file contents");
  return fields;
}

function hasCompletedFileWindow(meta, ok) {
  if (ok !== true) return false;
  if (meta.mode !== "file") return false;
  if (meta.hasData === false) return false;
  return meta.locatorFound !== false;
}

function addResultCounts(fields, meta, tool) {
  if (tool === "inspect_code_outline") {
    addCount(fields, "Returned symbols", meta.returnedItemCount);
    addCount(fields, "Total symbols", meta.totalItemCount);
    return;
  }
  if (tool === "memory_get" || tool === "memory_search") {
    addCount(fields, "Returned records", meta.returnedItemCount);
    addCount(
      fields,
      resultCountLabel(tool),
      meta.totalItemCount ?? meta.itemCount,
    );
    return;
  }
  if (tool === "local_search") {
    addCount(
      fields,
      "Returned matches",
      meta.returnedItemCount ?? meta.itemCount,
    );
    return;
  }
  if (tool === "dev_view" || tool === "read_file") return;
  addCount(fields, resultCountLabel(tool), meta.itemCount);
}

function hasPartialSource(meta) {
  if (meta.truncated === true) return true;
  if (meta.scanTruncated === true) return true;
  if (meta.outputTruncated === true) return true;
  if (meta.sourceTruncated === true) return true;
  if (meta.importsTruncated === true) return true;
  return meta.complete === false;
}

function completedOutcome(meta) {
  if (meta.state === "unchanged" || meta.stateAlreadySatisfied === true)
    return "unchanged";
  if (meta.locatorFound === false) return "empty";
  if (meta.hasData === false || meta.deletedCount === 0) return "empty";
  return "completed";
}

/** Retain only bounded display evidence; arbitrary event metadata stays out of UI state. */
export function projectToolActivityEvent(message) {
  const name =
    message.eventName || message.name || message.rawType || message.type;
  if (!TOOL_EVENTS.has(name)) return null;
  const tool = boundedText(message.tool, 128).trim();
  if (!tool) return null;
  const meta = effectiveToolMetadata(getRecord(message.meta) || {}, tool);
  const completed = name === "tool.completed";
  const params = getRecord(meta.params);
  const inputMeta = { ...meta, params };
  return {
    name,
    tool,
    executionId: boundedText(message.executionId, 200).trim(),
    executorRole: boundedText(message.executorRole, 128).trim(),
    roleCallId: boundedText(message.roleCallId, 200).trim(),
    ...payloadStageMetadata(message),
    beforeExternalExecution: message.stage === "before_external_execution",
    intent: boundedText(message.intent || meta.intent),
    target: boundedText(
      meta.source ||
        meta.displayTarget ||
        meta.path ||
        meta.searchRoot ||
        meta.query ||
        meta.id ||
        meta.savedId,
    ),
    sent: inputFields(inputMeta, completed, tool),
    received: completed ? resultFields(meta, tool, message.ok) : [],
    preview: completed ? boundedText(meta.outputPreview, 1_200) : "",
    previewTruncated: completed && hasClippedPreview(meta),
    partial: completed && hasPartialSource(meta),
    outcome: completedOutcome(meta),
    ok: typeof message.ok === "boolean" ? message.ok : null,
    error: boundedText(message.error || message.reason || meta.errorCode),
  };
}

function effectiveToolMetadata(meta, tool) {
  if (tool !== "document_reader") return meta;
  if (meta.sourceMode === "working_path") return { ...meta, source: undefined };
  return { ...meta, displayTarget: undefined };
}

function hasClippedPreview(meta) {
  if (meta.outputPreviewTruncated === true) return true;
  if (meta.evidenceTruncated === true) return true;
  return (
    typeof meta.outputPreview === "string" && meta.outputPreview.length > 1_200
  );
}
