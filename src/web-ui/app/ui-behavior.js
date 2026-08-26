export function matchesSessionQuery(values, query) {
  const normalizedQuery = String(query ?? "")
    .trim()
    .toLocaleLowerCase();
  if (!normalizedQuery) return true;
  return values.some((value) =>
    String(value ?? "")
      .toLocaleLowerCase()
      .includes(normalizedQuery),
  );
}

export function isNearScrollEnd(metrics, threshold = 96) {
  const distance =
    Number(metrics?.scrollHeight || 0) -
    Number(metrics?.scrollTop || 0) -
    Number(metrics?.clientHeight || 0);
  return distance <= Math.max(0, Number(threshold) || 0);
}

export function pinScrollToEnd(viewport) {
  if (!viewport) return;
  const style = viewport.style;
  const previousScrollBehavior = style?.scrollBehavior ?? "";
  if (style) style.scrollBehavior = "auto";
  viewport.scrollTop = Number(viewport.scrollHeight || 0);
  if (style) style.scrollBehavior = previousScrollBehavior;
}

export function wrappedIndex(currentIndex, delta, length) {
  if (!Number.isInteger(length) || length <= 0) return -1;
  const next = (Number(currentIndex) || 0) + (Number(delta) || 0);
  return ((next % length) + length) % length;
}

export function normalizeWorkspaceDestination(value) {
  const destination = String(value ?? "")
    .trim()
    .toLowerCase();
  return ["operations", "config"].includes(destination) ? destination : "chat";
}

export function createInitialWorkspaceShellState() {
  return { workspace: "chat", activeSheet: "" };
}

export function toggleWorkspaceSheet(currentSheet, requestedSheet) {
  const requested = requestedSheet === "sessions" ? requestedSheet : "";
  if (!requested || currentSheet === requested) return "";
  return requested;
}

export function resolveComposerPrimaryAction(
  activeRequestId,
  attachmentCount = 0,
) {
  if (!String(activeRequestId ?? "").trim()) return "send";
  return Number(attachmentCount) > 0 ? "send_next" : "steer";
}

export function isMatchingActiveRequest(activeRequestId, requestId) {
  const active = String(activeRequestId ?? "").trim();
  const candidate = String(requestId ?? "").trim();
  return Boolean(active && candidate && active === candidate);
}

export function insertRequestUserMessageBeforeAssistant(messages, message) {
  const currentMessages = Array.isArray(messages) ? messages : [];
  const requestId = String(message?.requestId ?? "").trim();
  if (!requestId) return [...currentMessages, message];
  const assistantIndex = currentMessages.findIndex(
    (candidate) =>
      candidate?.role === "assistant" &&
      String(candidate?.requestId ?? "").trim() === requestId,
  );
  if (assistantIndex < 0) return [...currentMessages, message];
  return [
    ...currentMessages.slice(0, assistantIndex),
    message,
    ...currentMessages.slice(assistantIndex),
  ];
}
