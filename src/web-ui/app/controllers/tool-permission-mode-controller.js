import { escapeAttribute, escapeHtml } from "../lib/text-format.js";
import {
  normalizeToolPermissionMode,
  supportsFullPlus,
  TOOL_PERMISSION_MODES,
  toolPermissionModeMeta,
  toolPermissionRequestError,
} from "../lib/tool-permission-mode.js";

export function createToolPermissionModeController({
  state, dom, preferences, recordControlEvent, getComposerSessionId,
}) {
  function sessionModeFor(sessionId) {
    const mode = state.sessionModes[sessionId];
    if (!mode || typeof mode !== "object") return {};
    if (Array.isArray(mode)) return {};
    return mode;
  }

  function currentToolPermissionMode() {
    const sessionId = getComposerSessionId();
    if (!sessionId) return preferences.loadLastToolPermissionMode(normalizeToolPermissionMode);
    return normalizeToolPermissionMode(sessionModeFor(sessionId).toolPermissionMode);
  }

  function clearSessionMode(sessionId) {
    if (!sessionId) return;
    delete state.sessionModes[sessionId];
    preferences.saveSessionModes(state.sessionModes);
  }

  function persistSessionSelection(sessionId, mode) {
    state.sessionModes[sessionId] = {
      ...sessionModeFor(sessionId),
      toolPermissionMode: mode,
      savedAt: Date.now(),
    };
  }

  function initializeSessionMode(sessionId) {
    if (!sessionId) return;
    const hasSavedSessionMode = Object.hasOwn(state.sessionModes, sessionId);
    if (hasSavedSessionMode) return;
    const mode = preferences.loadLastToolPermissionMode(normalizeToolPermissionMode);
    persistSessionSelection(sessionId, mode);
    preferences.saveSessionModes(state.sessionModes);
  }

  function setToolPermissionMode(mode) {
    const sessionId = getComposerSessionId();
    if (!sessionId) return;
    const normalized = normalizeToolPermissionMode(mode);
    const unavailable = toolPermissionRequestError(normalized, state.config);
    if (unavailable) {
      recordControlEvent({
        type: "control", name: "Tool permission mode unavailable",
        tone: "failed", summary: unavailable.message,
      });
      return;
    }
    persistSessionSelection(sessionId, normalized);
    preferences.saveLastToolPermissionMode(normalized);
    preferences.saveSessionModes(state.sessionModes);
    state.permissionModeMenuOpen = false;
    renderPermissionMode();
    dom.permissionModeButton.focus();
  }

  function isFullPlusUnavailable(mode) {
    if (mode !== "full_plus") return false;
    return !supportsFullPlus(state.config);
  }

  function renderPermissionOption(itemMode, currentMode) {
    const item = toolPermissionModeMeta(itemMode);
    const selected = itemMode === currentMode;
    const unavailable = isFullPlusUnavailable(itemMode);
    const description = unavailable
      ? "Unavailable on this server"
      : item.description;
    return `
      <button class="permission-mode-option ${selected ? "selected" : ""}" type="button"
        role="menuitemradio" aria-checked="${selected ? "true" : "false"}"
        ${unavailable ? 'disabled aria-disabled="true"' : ""}
        tabindex="${selected ? "0" : "-1"}" data-mode="${escapeAttribute(itemMode)}">
        <strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(description)}</small>
      </button>`;
  }

  function renderPermissionMode() {
    const mode = currentToolPermissionMode();
    const meta = toolPermissionModeMeta(mode);
    const unavailable = toolPermissionRequestError(mode, state.config);
    dom.permissionModeButton.innerHTML = `<span class="permission-mode-label">${escapeHtml(meta.label)}</span>`;
    dom.permissionModeButton.title = unavailable?.message || meta.title;
    dom.permissionModeButton.disabled = !getComposerSessionId();
    dom.permissionModeButton.classList.toggle("full", mode !== "ask");
    dom.permissionModeButton.classList.toggle("open", state.permissionModeMenuOpen);
    dom.permissionModeButton.setAttribute("aria-expanded", state.permissionModeMenuOpen ? "true" : "false");
    dom.permissionModeMenu.classList.toggle("open", state.permissionModeMenuOpen);
    dom.permissionModeMenu.hidden = !state.permissionModeMenuOpen;
    dom.permissionModeMenu.setAttribute("role", "menu");
    dom.permissionModeMenu.innerHTML = TOOL_PERMISSION_MODES
      .map((itemMode) => renderPermissionOption(itemMode, mode))
      .join("");
    dom.permissionModeMenu.querySelectorAll(".permission-mode-option")
      .forEach((button) => {
        button.addEventListener("click", () => setToolPermissionMode(button.dataset.mode));
      });
  }

  return {
    clearSessionMode, currentToolPermissionMode, initializeSessionMode,
    renderPermissionMode, setToolPermissionMode,
  };
}
