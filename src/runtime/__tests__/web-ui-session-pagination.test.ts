import { describe, expect, test } from "vitest";
import { sessionMetadataPage } from "../../web-ui/session-read-state/pagination.js";
import { projectSessionMetadata } from "../../sessions/metadata/projection.js";
import { buildWebUiConfig } from "../../runtime/config/web-ui.js";
import { validateWebUiConfigSection } from "../../runtime/config/validation/web-ui-config-validation.js";

const records = Array.from({ length: 45 }, (_, index) => projectSessionMetadata({
  id: `session-${index}`, title: `Chat ${index}`, createdAt: new Date(index).toISOString(), updatedAt: new Date(index).toISOString(),
  lastAgentMode: "reasoning", messageCount: 0, messages: [],
}, "source"));

describe("metadata session pages", () => {
  test("uses default 20 and validates a configured positive integer", () => {
    expect(buildWebUiConfig({})).toEqual({ pageSize: 20 });
    expect(buildWebUiConfig({ webUi: { pageSize: 7 } })).toEqual({ pageSize: 7 });
    for (const pageSize of [0, -1, 1.5, "20"]) {
      const issues: string[] = [];
      validateWebUiConfigSection(issues, { webUi: { pageSize } });
      expect(issues.length).toBeGreaterThan(0);
    }
  });
  test("returns stable pages with no overlap and exact total", () => {
    const first = sessionMetadataPage(records, {}, 20);
    const second = sessionMetadataPage(records, { cursor: first.nextCursor }, 20);
    const third = sessionMetadataPage(records, { cursor: second.nextCursor }, 20);
    expect(first.total).toBe(45);
    expect([first.records.length, second.records.length, third.records.length]).toEqual([20, 20, 5]);
    expect(new Set([...first.records, ...second.records, ...third.records].map((record) => record.summary.id)).size).toBe(45);
    expect(third.nextCursor).toBeNull();
  });
  test("filters and orders all metadata before paging, including old pinned and archived chats", () => {
    const first = sessionMetadataPage(records, { pinnedSessionIds: ["session-0"], archivedSessionIds: ["session-44"] }, 2);
    expect(first.records.map((record) => record.summary.id)).toEqual(["session-0", "session-43"]);
    expect(first.archivedCount).toBe(1);
    const archive = sessionMetadataPage(records, { archivedSessionIds: ["session-0"], archived: true }, 20);
    expect(archive.records.map((record) => record.summary.id)).toEqual(["session-0"]);
    const search = sessionMetadataPage(records, { query: "Chat 0" }, 20);
    expect(search.records.map((record) => record.summary.id)).toEqual(["session-0"]);
  });
});
