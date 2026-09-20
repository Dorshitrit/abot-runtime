import { describe, expect, test, vi } from "vitest";
import {
  parseConversationFileOutput,
  canViewConversationFile,
} from "../../web-ui/app/lib/conversation-file-reference.js";
import { projectToolActivityEvent } from "../../web-ui/app/lib/tool-activity-event.js";
import { buildConversationToolActions } from "../../web-ui/app/lib/tool-activity-model.js";
import { normalizeRealtimeMessage } from "../../web-ui/app/controllers/realtime-event-controller.js";
import { createConversationActivity } from "../../web-ui/app/components/conversation-activity.js";
import { ContextElement } from "./support/composer-context-window-dom.js";

const output = {
  version: 1,
  location: "agent_work",
  rootId: "sha256:" + "a".repeat(64),
  relativePath: "notes/report.md",
  logicalPath: "notes/report.md",
  operation: "created",
};
function event(overrides: Record<string, unknown> = {}) {
  return {
    name: "tool.completed",
    requestId: "r1",
    executionId: "e1",
    executorRole: "worker",
    tool: "write_file",
    ok: true,
    eventSequence: 3,
    meta: {
      path: "notes/report.md",
      outputPreview: "Recorded contents",
      fileOutput: output,
    },
    ...overrides,
  };
}
function actions(events: Record<string, unknown>[]) {
  return buildConversationToolActions({ requestId: "r1", events });
}

describe("conversation file references", () => {
  test("preserves only the bounded receipt through raw and projected event paths", () => {
    const raw = event();
    const projected = {
      requestId: raw.requestId,
      eventSequence: 3,
      toolActivity: projectToolActivityEvent(raw),
    };
    expect(actions([projected])).toEqual(actions([raw]));
    const [action] = actions([raw]);
    expect(action.fileReference).toEqual({
      requestId: "r1",
      executionId: "e1",
      output,
    });
    expect(canViewConversationFile(action, "r1")).toBe(true);
    expect(canViewConversationFile(action, "another")).toBe(false);
    expect(action.preview).toBe("Recorded contents");
  });

  test("hydrates the same reference from stored request event wrappers", () => {
    const live = event();
    const stored = normalizeRealtimeMessage({
      type: "runtime.event",
      requestId: "r1",
      sessionId: "session",
      name: "tool.completed",
      tool: "write_file",
      payload: {
        executionId: "e1",
        executorRole: "worker",
        ok: true,
        meta: live.meta,
      },
      eventSequence: 3,
    });
    expect(actions([stored])).toEqual(actions([live]));
  });

  test.each([
    { ok: false },
    { name: "tool.failed" },
    { name: "tool.started" },
    { executionId: "" },
    { requestId: "other" },
    { meta: { path: "notes/report.md", outputPreview: "Created file" } },
  ])("does not offer inferred or unsuccessful files: %j", (overrides) => {
    const result = actions([event(overrides)]);
    expect(
      result.every((action) => !canViewConversationFile(action, "r1")),
    ).toBe(true);
  });

  test.each([
    { relativePath: "../secret" },
    { relativePath: "/absolute" },
    { relativePath: "a/../secret" },
    { relativePath: "a\\secret" },
    { relativePath: "a//secret" },
    { logicalPath: "/unavailable-root/secret" },
    { rootId: "arbitrary" },
    { rootId: { toString: null } },
    { version: 2 },
    { location: "attachments" },
    { operation: "read" },
  ])("rejects malformed file output: %j", (invalid) => {
    expect(parseConversationFileOutput({ ...output, ...invalid })).toBeNull();
  });

  test("accepts workspace logical path only when bound to its location", () => {
    const descriptor = {
      ...output,
      location: "workspace",
      logicalPath: "workspace/" + output.relativePath,
    };
    expect(parseConversationFileOutput(descriptor)).toEqual(descriptor);
    expect(
      parseConversationFileOutput({
        ...descriptor,
        logicalPath: output.relativePath,
      }),
    ).toBeNull();
  });

  test("later failure invalidates an earlier reference for the same execution", () => {
    const [action] = actions([
      event(),
      event({ eventSequence: 4, name: "tool.failed", ok: false }),
    ]);
    expect(action.status).toBe("failed");
    expect(action.fileReference).toBeUndefined();
  });

  test("separate writes to the same filename keep separate exact references", () => {
    const result = actions([
      event(),
      event({ executionId: "e2", eventSequence: 4 }),
    ]);
    expect(result.map((action) => action.fileReference?.executionId)).toEqual([
      "e1",
      "e2",
    ]);
  });
});

function activityDocument() {
  return {
    createElement: (tag: string) =>
      Object.assign(new ContextElement(tag), {
        open: false,
        scrollTop: 0,
        scrollHeight: 200,
      }),
  } as unknown as Document;
}

function activateFileAction(button: ContextElement) {
  const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
  button.dispatch("click", click);
  expect(click.preventDefault).toHaveBeenCalledOnce();
  expect(click.stopPropagation).toHaveBeenCalledOnce();
}

describe("file action in existing Activity disclosure", () => {
  test("uses the existing filename while preserving disclosure expansion and recorded evidence", () => {
    const opened: unknown[] = [];
    const documentRoot = activityDocument();
    const view = createConversationActivity({
      documentRoot,
      onOpenFile: (reference) => opened.push(reference),
    });
    const render = () =>
      view.createNode({ requestId: "r1", events: [event()] })!;
    const initial = render();
    const details = initial.querySelector(
      ".conversation-tool",
    ) as unknown as ContextElement & { open: boolean };
    const button = initial.querySelector(
      ".conversation-tool-file-action",
    ) as unknown as ContextElement;
    const summary = details.querySelector("summary")!;
    expect(summary.contains(button)).toBe(true);
    expect(button.tagName).toBe("button");
    expect(button.type).toBe("button");
    expect(button.textContent).toBe("notes/report.md");
    expect(button.classList.contains("conversation-tool-target")).toBe(true);
    expect(summary.textContent.match(/notes\/report\.md/g)).toHaveLength(1);
    expect(summary.textContent).not.toContain("View file");
    expect(details.textContent).toContain("Recorded contents");
    activateFileAction(button);
    expect(opened).toHaveLength(1);
    expect(details.open).toBe(false);
    details.open = true;
    details.dispatch("toggle");
    const refreshed = render();
    expect(
      (refreshed.querySelector(".conversation-tool") as HTMLDetailsElement)
        .open,
    ).toBe(true);
    activateFileAction(button);
    expect(opened).toHaveLength(1);
    view.reset();
    activateFileAction(
      refreshed.querySelector(
        ".conversation-tool-file-action",
      ) as unknown as ContextElement,
    );
    expect(opened).toHaveLength(1);
  });

  test("keeps a mixed-language logical filename inert and directionally isolated", () => {
    const logicalPath =
      "workspace/notes/סיכום-" + "long-".repeat(30) + "<draft>.txt";
    const opened = vi.fn();
    const view = createConversationActivity({
      documentRoot: activityDocument(),
      onOpenFile: opened,
    });
    const receipt = {
      ...output,
      location: "workspace",
      relativePath: logicalPath.slice("workspace/".length),
      logicalPath,
    };
    const rendered = view.createNode({
      requestId: "r1",
      events: [event({ meta: { path: logicalPath, fileOutput: receipt } })],
    })!;
    const button = rendered.querySelector(
      ".conversation-tool-file-action",
    ) as unknown as ContextElement;
    expect(button.textContent).toBe(logicalPath);
    expect(button.getAttribute("dir")).toBe("auto");
    expect(button.querySelector("draft")).toBeNull();
    activateFileAction(button);
    expect(opened).toHaveBeenCalledWith(
      { requestId: "r1", executionId: "e1", output: receipt },
      button,
    );
  });

  test.each(["missing-receipt", "unavailable-backend"])(
    "retains the plain filename when preview is unavailable: %s",
    (reason) => {
      const view = createConversationActivity({
        documentRoot: activityDocument(),
        onOpenFile: vi.fn(),
        canOpenFile: () => reason !== "unavailable-backend",
      });
      const source = event(
        reason === "missing-receipt"
          ? { meta: { path: "notes/report.md" } }
          : {},
      );
      const rendered = view.createNode({ requestId: "r1", events: [source] })!;
      expect(
        rendered.querySelector(".conversation-tool-file-action"),
      ).toBeNull();
      const target = rendered.querySelector(".conversation-tool-target")!;
      expect(target.tagName).toBe("bdi");
      expect(target.textContent).toBe("notes/report.md");
    },
  );
});
