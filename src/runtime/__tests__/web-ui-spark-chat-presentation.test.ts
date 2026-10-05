import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser presentation module.
import { createSparkChatResults } from "../../web-ui/app/components/spark-chat/results.js";
// @ts-expect-error Browser presentation module.
import { sparkMessageStatus, sparkWorkingStatus } from "../../web-ui/app/lib/spark-chat-presentation.js";
import { ContextElement } from "./support/composer-context-window-dom.js";

function harness() {
  const documentRoot = { createElement: (tag: string) => new ContextElement(tag) };
  const onOpenFile = vi.fn();
  return { onOpenFile, results: createSparkChatResults({ documentRoot, onOpenFile, canOpenFile: () => true }) };
}

describe("SPARK friendly presentation", () => {
  test("routine completion is quiet while failures, queued confirmation and approval remain visible", () => {
    expect(sparkMessageStatus("ABot response completed.")).toBe("");
    expect(sparkMessageStatus("ABot is working.")).toBe("");
    expect(sparkMessageStatus("File upload failed: connection lost")).toBe("File upload failed: connection lost");
    expect(sparkMessageStatus("Waiting for your approval.")).toBe("Waiting for your approval.");
    expect(sparkMessageStatus("Message queued for this conversation.")).toBe("Message queued for this conversation.");
    expect(sparkWorkingStatus({ label: "Running tool", animate: true })).toEqual({ label: "SPARK is working…", animate: true });
    expect(sparkWorkingStatus({ label: "Reconnecting", animate: false }).label).toBe("Reconnecting");
  });

  test("keeps exact file access and source links without Activity or event controls", () => {
    const { results, onOpenFile } = harness();
    const fileOutput = { version: 1, location: "agent_work", rootId: `sha256:${"a".repeat(64)}`, relativePath: "notes.txt", logicalPath: "notes.txt", operation: "created" };
    const node = results.createNode({ requestId: "r", events: [
      { requestId: "r", name: "tool.completed", executionId: "file", tool: "write_file", ok: true, meta: { fileOutput } },
      { requestId: "r", name: "tool.completed", executionId: "web", tool: "web_search", ok: true, webSources: { version: 1, operation: "search", sources: [{ url: "https://example.com/read", title: "Read this", retrieval: "retrieved", presentation: "content", contentTruncated: false }] } },
    ] });
    expect(node.querySelector(".conversation-activity")).toBeNull();
    const file = node.querySelector(".conversation-tool-file-action");
    file.dispatch("click", { preventDefault() {}, stopPropagation() {} });
    expect(onOpenFile).toHaveBeenCalledWith({ requestId: "r", executionId: "file", output: fileOutput }, file);
    expect(node.querySelector(".conversation-source-link").href).toBe("https://example.com/read");
    results.createNode({ requestId: "r", events: [{ requestId: "r", name: "tool.completed", executionId: "file", tool: "write_file", ok: true, meta: { fileOutput } }] });
    file.dispatch("click", { preventDefault() {}, stopPropagation() {} });
    expect(onOpenFile).toHaveBeenCalledTimes(2);
    results.reset();
    file.dispatch("click", { preventDefault() {}, stopPropagation() {} });
    expect(onOpenFile).toHaveBeenCalledTimes(2);
  });

  test("successful technical events add no chrome but errors remain scoped and visible", () => {
    const { results } = harness();
    expect(results.createNode({ requestId: "r", events: [{ requestId: "r", name: "request.completed" }] })).toBeNull();
    const node = results.createNode({ requestId: "r", events: [
      { requestId: "r", name: "tool.failed", executionId: "f", tool: "read_file", error: "The file is unavailable" },
      { requestId: "r", name: "Attachment warning", tone: "warning", summary: "Image could not be attached" },
      { requestId: "other", name: "Failure", tone: "failed", summary: "Other conversation" },
    ] });
    expect(node.textContent).toContain("The file is unavailable");
    expect(node.textContent).toContain("Image could not be attached");
    expect(node.textContent).not.toContain("Other conversation");
  });
});
