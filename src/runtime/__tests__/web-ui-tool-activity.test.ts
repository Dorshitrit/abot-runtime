import { describe, expect, test } from "vitest";
import { projectToolActivityEvent } from "../../web-ui/app/lib/tool-activity-event.js";
import {
  buildConversationToolActions,
  summarizeConversationTools,
} from "../../web-ui/app/lib/tool-activity-model.js";
import { isNonToolTimelineEvent } from "../../web-ui/app/lib/tool-timeline.js";

function event(
  name: string,
  eventSequence: number,
  extra: Record<string, unknown> = {},
) {
  return {
    type: "event",
    name,
    eventSequence,
    requestId: "req",
    executionId: "exec-1",
    tool: "write_file",
    meta: { path: "notes.txt" },
    ...extra,
  };
}

function actions(events: Record<string, unknown>[], streaming = true) {
  return buildConversationToolActions({ requestId: "req", events, streaming });
}

describe("tool activity projection and lifecycle", () => {
  test("four payload/execution events become one evolving action", () => {
    const events = [
      event("tool.payload.started", 1),
      event("tool.payload.completed", 2),
      event("tool.started", 3),
      event("tool.completed", 4, {
        ok: true,
        meta: {
          path: "notes.txt",
          state: "establish_target",
          byteCount: 30,
          outputPreview: "Written text",
        },
      }),
    ];
    const preparing = actions(events.slice(0, 1))[0]!;
    const running = actions(events.slice(0, 3))[0]!;
    const completed = actions(events, false);
    expect(preparing.status).toBe("preparing");
    expect(running.status).toBe("running");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      id: preparing.id,
      status: "completed",
      count: 1,
      preview: "Written text",
    });
    expect(running.id).toBe(preparing.id);
    expect(completed[0]!.received).toContainEqual({
      label: "Change",
      value: "Created file",
    });
    expect(events.filter(isNonToolTimelineEvent)).toEqual([]);
  });

  test("concurrent identical tools preserve exact independent input/output pairs", () => {
    const events = [
      event("tool.started", 1, { executionId: "a", meta: { path: "a.txt" } }),
      event("tool.started", 2, { executionId: "b", meta: { path: "b.txt" } }),
      event("tool.completed", 3, {
        executionId: "b",
        ok: false,
        meta: { path: "b.txt", errorCode: "blocked" },
      }),
      event("tool.completed", 4, {
        executionId: "a",
        ok: true,
        meta: { path: "a.txt", outputPreview: "A only" },
      }),
    ];
    const result = actions(events, false);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      target: "a.txt",
      preview: "A only",
      status: "completed",
    });
    expect(result[1]).toMatchObject({
      target: "b.txt",
      preview: "",
      status: "failed",
    });
  });

  test("overlapping replay and late starts cannot reopen a settled action", () => {
    const start = event("tool.started", 1);
    const end = event("tool.completed", 2, { ok: true });
    const result = actions([end, start, end]);
    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe("completed");
  });

  test("multi-stage payloads and approval update the same row", () => {
    const preparation = [
      event("tool.payload.started", 1),
      event("tool.payload.completed", 2),
      event("tool.payload.started", 3),
      event("tool.payload.completed", 4),
      event("tool.approval.required", 5),
    ];
    expect(actions(preparation)).toHaveLength(1);
    expect(actions(preparation)[0]!.status).toBe("awaiting_approval");
    const rejected = actions([
      ...preparation,
      event("tool.approval.rejected", 6, { reason: "Approval expired" }),
    ]);
    expect(rejected[0]).toMatchObject({
      status: "failed",
      statusLabel: "Not approved",
    });
    expect(rejected[0]!.received).toContainEqual({
      label: "Error",
      value: "Approval expired",
    });
  });

  test("payload failure remains visible without an execution start", () => {
    const result = actions(
      [
        event("tool.payload.started", 1),
        event("tool.payload.failed", 2, { error: "invalid_payload" }),
      ],
      false,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      status: "failed",
      statusLabel: "Preparation failed",
    });
    expect(result[0]!.received).toContainEqual({
      label: "Error",
      value: "invalid_payload",
    });
  });

  test("request completion never fabricates a missing tool outcome", () => {
    expect(actions([event("tool.started", 1)], false)[0]).toMatchObject({
      status: "incomplete",
      statusLabel: "Completion not recorded",
    });
    expect(actions([event("tool.completed", 1)], false)[0]!.status).toBe(
      "incomplete",
    );
  });

  test("legacy history shows outcomes once without guessing start/result correlation", () => {
    const legacy = [
      event("tool.payload.started", 1, { executionId: undefined }),
      event("tool.payload.completed", 2, { executionId: undefined }),
      event("tool.started", 3, { executionId: undefined }),
      event("tool.completed", 4, { executionId: undefined, ok: true }),
      event("tool.completed", 5, { executionId: undefined, ok: true }),
    ];
    const result = actions(legacy, false);
    expect(result).toHaveLength(2);
    expect(
      result.every((action) => action.legacy && action.status === "completed"),
    ).toBe(true);
    expect(new Set(result.map((action) => action.id)).size).toBe(2);
  });

  test("explicit empty/unchanged results remain different from failures", () => {
    const get = (tool: string, meta: object) =>
      actions(
        [event("tool.completed", 1, { ok: true, tool, meta })],
        false,
      )[0]!;
    expect(get("memory_search", { hasData: false }).status).toBe("empty");
    expect(get("write_file", { state: "unchanged" }).status).toBe("unchanged");
    expect(get("memory_delete", { deletedCount: 0 }).statusLabel).toBe(
      "No matching record",
    );
    expect(get("memory_delete", {}).status).toBe("completed");
    expect(
      actions([
        event("tool.completed", 1, { ok: false, meta: { state: "unchanged" } }),
      ])[0]!.status,
    ).toBe("failed");
  });

  test("requested and actual read windows are separate", () => {
    const result = actions([
      event("tool.started", 1, {
        tool: "dev_view",
        meta: { path: "a.txt", startLine: 10, endLine: 90 },
      }),
      event("tool.completed", 2, {
        tool: "dev_view",
        ok: true,
        meta: {
          path: "a.txt",
          mode: "file",
          startLine: 10,
          endLine: 35,
          complete: false,
        },
      }),
    ])[0]!;
    expect(result.sent).toContainEqual({
      label: "Requested lines",
      value: "10–90",
    });
    expect(result.received).toContainEqual({
      label: "Read lines",
      value: "10–35",
    });
    expect(result.partial).toBe(true);
  });

  test("preview clipping alone never says the source result was partial", () => {
    const result = actions([
      event("tool.completed", 1, {
        ok: true,
        meta: { outputPreview: "Excerpt", outputPreviewTruncated: true },
      }),
    ])[0]!;
    expect(result.preview).toBe("Excerpt");
    expect(result.partial).toBe(false);
  });

  test.each([
    { ok: false, meta: { mode: "file", startLine: 10, endLine: 90 } },
    {
      ok: true,
      meta: { mode: "file", startLine: 10, endLine: 90, locatorFound: false },
    },
  ])(
    "failed or unmatched reads do not present the requested range as received",
    (extra) => {
      const result = actions([
        event("tool.completed", 1, { tool: "dev_view", ...extra }),
      ])[0]!;
      expect(
        result.received.some((field) => field.label === "Read lines"),
      ).toBe(false);
      if (extra.ok)
        expect(result.statusLabel).toBe("No match in scanned range");
    },
  );

  test("memory total and returned record counts retain their distinct meanings", () => {
    const result = actions([
      event("tool.completed", 1, {
        tool: "memory_search",
        ok: true,
        meta: {
          query: "language",
          itemCount: 30,
          returnedItemCount: 10,
          sourceTruncated: true,
        },
      }),
    ])[0]!;
    expect(result.sent).toContainEqual({ label: "Query", value: "language" });
    expect(result.received).toEqual(
      expect.arrayContaining([
        { label: "Matching records", value: "30" },
        { label: "Returned records", value: "10" },
      ]),
    );
    expect(result.partial).toBe(true);
  });

  test("projection bounds text, ignores arbitrary metadata, and leaves source payload intact", () => {
    const input = event("tool.completed", 1, {
      ok: true,
      meta: {
        path: "a".repeat(1000),
        outputPreview: "x".repeat(9000),
        privateRaw: "do not retain",
        hasData: true,
      },
    });
    const before = JSON.stringify(input);
    const result = projectToolActivityEvent(input)!;
    expect(result.target.length).toBeLessThanOrEqual(500);
    expect(result.preview.length).toBeLessThanOrEqual(1200);
    expect(JSON.stringify(result)).not.toContain("do not retain");
    expect(JSON.stringify(input)).toBe(before);
  });

  test("automatic memory and non-tool diagnostics remain outside tool cards", () => {
    const memory = {
      type: "event",
      name: "memory.retrieval.completed",
      requestId: "req",
      retrievedCount: 3,
    };
    expect(projectToolActivityEvent(memory)).toBeNull();
    expect(isNonToolTimelineEvent(memory)).toBe(true);
    expect(
      actions([event("tool.completed", 1, { requestId: "another" }), memory]),
    ).toEqual([]);
  });

  test("inspection cards show target, scope, validity and actual bounded output", () => {
    const result = actions([
      event("tool.completed", 1, {
        tool: "inspect_json",
        ok: true,
        meta: {
          displayTarget: "blog/data.json",
          maxDepth: 4,
          syntaxValid: false,
          outputPreview: "Invalid JSON: trailing comma",
        },
      }),
    ])[0]!;
    expect(result).toMatchObject({
      title: "Inspect JSON",
      target: "blog/data.json",
      preview: "Invalid JSON: trailing comma",
    });
    expect(result.sent).toContainEqual({ label: "Maximum depth", value: "4" });
    expect(result.received).toContainEqual({
      label: "JSON syntax",
      value: "Invalid",
    });
  });

  test("attachment identity wins over a default working directory", () => {
    const result = actions([
      event("tool.completed", 1, {
        tool: "document_reader",
        ok: true,
        meta: {
          source: "report.pdf",
          displayTarget: ".",
          startChar: 0,
          endChar: 50,
          totalCharacters: 100,
          sourceTruncated: true,
        },
      }),
    ])[0]!;
    expect(result).toMatchObject({
      title: "Read document",
      target: "report.pdf",
      partial: true,
    });
    expect(result.sent).not.toContainEqual({ label: "Target", value: "." });
    expect(result.received).toContainEqual({
      label: "End character",
      value: "50",
    });
  });

  test("completion metadata does not rewrite the originally sent target", () => {
    const result = actions([
      event("tool.started", 1, { meta: { path: "notes.txt" } }),
      event("tool.completed", 2, {
        ok: true,
        meta: { path: "/workspace/notes.txt" },
      }),
    ])[0]!;
    expect(result.target).toBe("/workspace/notes.txt");
    expect(result.sent).toContainEqual({ label: "Path", value: "notes.txt" });
  });

  test("working-path document reads show the path actually used, not an unused source argument", () => {
    const result = actions([
      event("tool.completed", 1, {
        tool: "document_reader",
        ok: true,
        meta: {
          sourceMode: "working_path",
          source: "unused.pdf",
          displayTarget: "actual.pdf",
        },
      }),
    ])[0]!;
    expect(result.target).toBe("actual.pdf");
    expect(result.sent.some((field) => field.value === "unused.pdf")).toBe(
      false,
    );
  });

  test("summary counts actions instead of their lifecycle events", () => {
    const result = actions([
      event("tool.started", 1, { tool: "read_file" }),
      event("tool.completed", 2, { tool: "read_file", ok: true }),
      event("tool.completed", 3, {
        tool: "read_file",
        executionId: "second",
        ok: true,
      }),
    ]);
    expect(summarizeConversationTools(result)).toBe("2 reads");
  });
});
