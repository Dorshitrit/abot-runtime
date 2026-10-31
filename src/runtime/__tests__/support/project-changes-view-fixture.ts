import { vi } from "vitest";
// @ts-expect-error Browser composition has no declaration.
import { createConversationViewFeature } from "../../../web-ui/app/controllers/conversation-view-feature.js";
import type { ProjectChanges, ProjectOperationChanges } from "../../../web-ui/app/services/runtime-web-client/project-changes.js";
import { createFilePreviewDom } from "./conversation-file-preview-dom.js";
import { ContextElement } from "./composer-context-window-dom.js";

export const changes: ProjectChanges = {
  status: "available", revision: "rev", base: "head", totalFiles: 1, additions: 1, deletions: 1, truncated: false,
  files: [{ id: "one", path: "notes.txt", status: "modified", additions: 1, deletions: 1, binary: false }],
};
export const operation: ProjectOperationChanges = {
  status: "available", file: changes.files[0]!, base: "head", revision: "rev",
  preview: { id: "one", path: "notes.txt", status: "text", patch: "@@ -1 +1 @@\n-old\n+<script>שלום</script>\n" },
};
export function projectChangesFixture({ summary = changes, width = 1400, excerpt = "Recorded original excerpt" } = {}) {
  const dom = createFilePreviewDom(width <= 1200);
  Object.defineProperty(dom.chat, "innerHTML", { configurable: true, get: () => "", set: () => dom.chat.replaceChildren() });
  const originalMatchMedia = dom.viewport.matchMedia;
  const listeners: Array<() => void> = [];
  const wideQuery = { matches: width >= 1800, addEventListener: (_name: string, fn: () => void) => listeners.push(fn) };
  dom.viewport.matchMedia = ((query: string) => query === "(min-width: 1800px)" ? wideQuery : originalMatchMedia(query)) as Window["matchMedia"];
  const composer = dom.element("textarea"); composer.id = "composerInput"; dom.host.appendChild(composer);
  let scope = { environmentId: "dev", sessionId: "chat", activeRequestId: "" };
  const messages = [{ id: "last", role: "assistant", requestId: "last", text: "Final answer", streaming: false }];
  const events = [{ type: "event", name: "tool.completed", requestId: "last", executionId: "write", eventSequence: 1,
    tool: "write_file", executorRole: "supervisor", ok: true,
    meta: { path: "notes.txt", outputPreview: excerpt, fileOutput: { version: 1, location: "agent_work", rootId: "sha256:" + "a".repeat(64), relativePath: "notes.txt", logicalPath: "notes.txt", operation: "created" } },
  }, { type: "completed", requestId: "last", eventSequence: 2 }];
  const client = {
    supportsProjectChanges: () => true, supportsConversationFiles: () => true,
    loadProjectChanges: vi.fn(async () => ({ ok: true, changes: summary })),
    loadProjectChangeDiff: vi.fn(async () => ({ ok: true, file: operation.preview! })),
    loadProjectOperationChanges: vi.fn(async () => ({ ok: true, change: operation })),
    loadConversationFile: vi.fn(async () => ({ ok: true, file: { kind: "text", name: "notes.txt", mimeType: "text/plain", content: "Current file", size: 12, truncated: false } })),
  };
  const view = createConversationViewFeature({
    filePreviewClient: client, getFileEnvironmentId: () => scope.environmentId, getFileSessionId: () => scope.sessionId,
    dom: { messagesList: dom.chat, jumpToLatestButton: dom.element("button") },
    documentRoot: dom.documentRoot, viewport: dom.viewport,
    getMessages: () => messages, getActiveRequestId: () => scope.activeRequestId, getActivityForMessage: () => ({ events }),
    getPendingApprovals: () => [], createApprovalCard: () => dom.element("aside"),
    copyText: vi.fn(async () => undefined), notify() {}, showContextWindow: false, showReasoning: false,
    scrollBehavior: { afterRender() {} },
  });
  return { dom, view, client, messages, events, composer,
    scope(next: Partial<typeof scope>) { scope = { ...scope, ...next }; },
    resize(next: number) { wideQuery.matches = next >= 1800; listeners.forEach((fn) => fn()); dom.resize(next <= 1200); },
  };
}
export function node(root: ContextElement, selector: string) { return root.querySelector(selector)!; }
export function click(target: ContextElement) { target.dispatch("click", { preventDefault() {}, stopPropagation() {} }); }
export function toggleTool(f: ReturnType<typeof projectChangesFixture>, open: boolean) {
  const details = node(f.dom.chat, ".conversation-tool") as ContextElement & { open: boolean };
  details.open = open; details.dispatch("toggle"); return details;
}
export function showTimeline(f: ReturnType<typeof projectChangesFixture>) {
  if (node(f.dom.chat, ".conversation-work-panel").hidden) click(node(f.dom.chat, ".conversation-work-toggle"));
}
export function pending<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
