function boundedIdentity(value, limit) {
  if (typeof value !== "string") return false;
  if (!value || value.length > limit) return false;
  return !/[\u0000-\u001f\u007f]/u.test(value);
}

function hasNormalizedRelativePath(value) {
  if (!boundedIdentity(value, 4096)) return false;
  if (value.startsWith("/") || value.includes("\\")) return false;
  if (/^[a-z]:/iu.test(value)) return false;
  return value
    .split("/")
    .every((part) => part && part !== "." && part !== "..");
}

export function parseConversationFileOutput(value) {
  if (!value || typeof value !== "object") return null;
  if (value.version !== 1) return null;
  if (!["agent_work", "workspace"].includes(value.location)) return null;
  if (typeof value.rootId !== "string") return null;
  if (!/^sha256:[a-f0-9]{64}$/u.test(value.rootId)) return null;
  if (!hasNormalizedRelativePath(value.relativePath)) return null;
  if (!boundedIdentity(value.logicalPath, 4096)) return null;
  const logicalPath =
    value.location === "workspace"
      ? "workspace/" + value.relativePath
      : value.relativePath;
  if (value.logicalPath !== logicalPath) return null;
  if (!["created", "updated"].includes(value.operation)) return null;
  return {
    version: 1,
    location: value.location,
    rootId: value.rootId,
    relativePath: value.relativePath,
    logicalPath: value.logicalPath,
    operation: value.operation,
  };
}

export function parseConversationFileReference(value) {
  if (!value || typeof value !== "object") return null;
  if (!boundedIdentity(value.requestId, 200)) return null;
  if (!boundedIdentity(value.executionId, 200)) return null;
  const output = parseConversationFileOutput(value.output);
  if (!output) return null;
  return { requestId: value.requestId, executionId: value.executionId, output };
}

export function projectConversationFileReference(message) {
  const name =
    message.eventName || message.name || message.rawType || message.type;
  if (name !== "tool.completed" || message.ok !== true) return null;
  return parseConversationFileReference({
    requestId: message.requestId,
    executionId: message.executionId,
    output: message.meta?.fileOutput,
  });
}

export function canViewConversationFile(action, requestId) {
  if (action.status !== "completed") return false;
  const reference = parseConversationFileReference(action.fileReference);
  if (!reference) return false;
  if (reference.requestId !== requestId) return false;
  return action.id === JSON.stringify([requestId, reference.executionId]);
}
