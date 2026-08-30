import { describe, expect, test, vi } from "vitest";

import { createLongTermMemoryController } from "../../web-ui/app/controllers/long-term-memory/controller.js";
import { managementErrorMessage } from "../../web-ui/app/controllers/long-term-memory/policy.js";
import { renderMemoryRecordEditor } from "../../web-ui/app/components/long-term-memory/record-editor.js";
import { renderMemoryRecordList } from "../../web-ui/app/components/long-term-memory/record-list.js";
import {
  buildMemoryDeleteConfirmation,
  createMemoryManagerView,
  parseMemoryTags,
} from "../../web-ui/app/components/long-term-memory/view-model.js";
import {
  createRuntimeWebClient,
  RuntimeWebClientError,
} from "../../web-ui/app/services/runtime-web-client.js";
import type {
  LongTermMemoryClient,
  LongTermMemoryRecord,
} from "../../web-ui/app/controllers/long-term-memory/controller.js";

const STORED_RECORD = Object.freeze({
  id: "memory/1",
  content: "Dor prefers concise answers.",
  tags: Object.freeze(["preference", "writing"]),
  origin: "passive_response",
  createdAt: "2026-08-26T08:00:00.000Z",
  updatedAt: "2026-08-26T08:00:00.000Z",
});

function memoryPage(
  items: readonly LongTermMemoryRecord[] = [],
  status = { enabled: true, available: true },
) {
  return { items, total: items.length, status };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function createControllerHarness(
  overrides: Partial<LongTermMemoryClient> = {},
) {
  const client = {
    loadLongTermMemoryStatus: vi.fn(async () => ({
      status: { enabled: true, available: true },
    })),
    listLongTermMemories: vi.fn(async () => memoryPage()),
    searchLongTermMemories: vi.fn(async () => ({ items: [], total: 0 })),
    createLongTermMemory: vi.fn(async () => ({ record: STORED_RECORD })),
    updateLongTermMemory: vi.fn(async () => ({ record: STORED_RECORD })),
    deleteLongTermMemory: vi.fn(async () => ({ deleted: true })),
    ...overrides,
  };
  const render = vi.fn();
  const controller = createLongTermMemoryController({
    client,
    getEnvironmentId: () => "dev",
    render,
    pageSize: 2,
  });
  return { client, controller, render };
}

describe("long-term memory Web UI client", () => {
  test("owns every management endpoint and keeps the selected environment explicit", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true, items: [], total: 0 }), {
          status: 200,
        }),
      ),
    );
    const client = createRuntimeWebClient({
      getConfig: () => ({ apiBasePath: "/web-api" }),
      getEnvironmentId: () => "dev profile",
      fetchImpl,
      origin: "http://localhost:5177",
    });

    await client.listLongTermMemories({ limit: 20, offset: 40 });
    await client.searchLongTermMemories({
      query: "עברית and English",
      limit: 10,
      offset: 0,
    });
    await client.createLongTermMemory({
      content: "Remember this",
      tags: ["qa"],
    });
    await client.updateLongTermMemory({
      id: "memory/1",
      content: "Updated",
      tags: ["qa"],
      expectedUpdatedAt: STORED_RECORD.updatedAt,
    });
    await client.deleteLongTermMemory({ id: "memory/1" });

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "/web-api/runtime/memory/records?environment=dev+profile&limit=20&offset=40",
      "/web-api/runtime/memory/records/search?environment=dev+profile&limit=10&offset=0&q=%D7%A2%D7%91%D7%A8%D7%99%D7%AA+and+English",
      "/web-api/runtime/memory/records",
      "/web-api/runtime/memory/records/memory%2F1",
      "/web-api/runtime/memory/records/memory%2F1?environment=dev%20profile",
    ]);
    expect(JSON.parse(String(fetchImpl.mock.calls[2]?.[1]?.body))).toEqual({
      environment: "dev profile",
      content: "Remember this",
      tags: ["qa"],
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[3]?.[1]?.body))).toEqual({
      environment: "dev profile",
      content: "Updated",
      tags: ["qa"],
      expectedUpdatedAt: STORED_RECORD.updatedAt,
    });
  });

  test("preserves HTTP status and domain code without changing error messages", async () => {
    const client = createRuntimeWebClient({
      getConfig: () => ({ apiBasePath: "/web-api" }),
      getEnvironmentId: () => "dev",
      fetchImpl: vi.fn(async () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              ok: false,
              error: "long_term_memory_management_conflict",
            }),
            { status: 409 },
          ),
        ),
      ),
      origin: "http://localhost:5177",
    });

    const error = await client
      .updateLongTermMemory({
        id: "memory-1",
        content: "Updated",
        tags: [],
        expectedUpdatedAt: STORED_RECORD.updatedAt,
      })
      .catch((reason) => reason);

    expect(error).toBeInstanceOf(RuntimeWebClientError);
    expect(error).toMatchObject({
      status: 409,
      code: "long_term_memory_management_conflict",
      message: "long_term_memory_management_conflict",
    });
  });
});

describe("long-term memory Web UI controller", () => {
  test("keeps list and delete available while memory is disabled", async () => {
    const listLongTermMemories = vi
      .fn()
      .mockResolvedValueOnce(
        memoryPage([STORED_RECORD], { enabled: false, available: true }),
      )
      .mockResolvedValueOnce({ items: [], total: 0 });
    const harness = createControllerHarness({
      listLongTermMemories,
    });

    await harness.controller.load();
    expect(harness.client.loadLongTermMemoryStatus).not.toHaveBeenCalled();
    harness.controller.beginCreate();
    expect(harness.controller.snapshot()).toMatchObject({
      enabled: false,
      items: [STORED_RECORD],
      editor: null,
    });
    expect(harness.controller.snapshot().error).toContain("Enable");

    await harness.controller.deleteMemory(STORED_RECORD.id);
    expect(harness.client.deleteLongTermMemory).toHaveBeenCalledWith({
      environmentId: "dev",
      id: STORED_RECORD.id,
    });
    expect(harness.controller.snapshot().items).toEqual([]);
  });

  test("does not expose a created record before the server accepts it", async () => {
    const creation = deferred<{ record: typeof STORED_RECORD }>();
    const listLongTermMemories = vi
      .fn()
      .mockResolvedValueOnce(memoryPage())
      .mockResolvedValueOnce({ items: [STORED_RECORD], total: 1 });
    const harness = createControllerHarness({
      createLongTermMemory: vi.fn(() => creation.promise),
      listLongTermMemories,
    });
    await harness.controller.load();
    harness.controller.beginCreate();

    const saving = harness.controller.save({
      content: STORED_RECORD.content,
      tags: [],
    });
    expect(harness.controller.snapshot()).toMatchObject({
      items: [],
      mutation: "create",
      editor: { mode: "create" },
    });

    creation.resolve({ record: STORED_RECORD });
    await saving;
    expect(harness.controller.snapshot()).toMatchObject({
      items: [STORED_RECORD],
      total: 1,
      mutation: "",
      editor: null,
      message: "Memory created.",
    });
  });

  test("ignores an older search response that completes last", async () => {
    const oldSearch = deferred<{
      items: (typeof STORED_RECORD)[];
      total: number;
    }>();
    const newRecord: LongTermMemoryRecord = {
      ...STORED_RECORD,
      id: "memory-2",
      content: "Newest",
    };
    const newSearch = deferred<{
      items: LongTermMemoryRecord[];
      total: number;
    }>();
    const searchLongTermMemories = vi
      .fn()
      .mockReturnValueOnce(oldSearch.promise)
      .mockReturnValueOnce(newSearch.promise);
    const harness = createControllerHarness({ searchLongTermMemories });
    await harness.controller.load();

    const first = harness.controller.search("old");
    const second = harness.controller.search("new");
    newSearch.resolve({ items: [newRecord], total: 1 });
    await second;
    oldSearch.resolve({ items: [STORED_RECORD], total: 1 });
    await first;

    expect(harness.controller.snapshot()).toMatchObject({
      query: "new",
      items: [newRecord],
      total: 1,
    });
  });

  test("marks embeddings unavailable after a provider-backed action fails", async () => {
    const harness = createControllerHarness({
      searchLongTermMemories: vi.fn(async () => {
        throw Object.assign(new Error("unavailable"), {
          status: 503,
          code: "long_term_memory_unavailable",
        });
      }),
    });
    await harness.controller.load();
    await harness.controller.search("preferred name");

    expect(harness.controller.snapshot()).toMatchObject({
      enabled: true,
      available: false,
      query: "preferred name",
    });
    expect(harness.controller.snapshot().error).toContain(
      "embedding provider is unavailable",
    );
  });

  test("reloads the current records instead of overwriting a stale edit", async () => {
    const freshRecord = {
      ...STORED_RECORD,
      content: "Changed in another tab",
      updatedAt: "2026-08-26T09:00:00.000Z",
    };
    const listLongTermMemories = vi
      .fn()
      .mockResolvedValueOnce(memoryPage([STORED_RECORD]))
      .mockResolvedValueOnce({ items: [freshRecord], total: 1 });
    const harness = createControllerHarness({
      listLongTermMemories,
      updateLongTermMemory: vi.fn(async () => {
        throw Object.assign(new Error("conflict"), {
          status: 409,
          code: "long_term_memory_management_conflict",
        });
      }),
    });
    await harness.controller.load();
    harness.controller.beginEdit(STORED_RECORD.id);
    await harness.controller.save({ content: "Mine", tags: [] });

    expect(harness.client.updateLongTermMemory).toHaveBeenCalledWith(
      expect.objectContaining({ expectedUpdatedAt: STORED_RECORD.updatedAt }),
    );
    expect(harness.controller.snapshot()).toMatchObject({
      items: [freshRecord],
      editor: { mode: "edit", recordId: STORED_RECORD.id },
    });
    expect(harness.controller.snapshot().error).toContain("changed elsewhere");
  });
});

describe("long-term memory Web UI presentation", () => {
  test("parses tags, confirms the exact record, and renders only safe fields", () => {
    const view = createMemoryManagerView({
      enabled: true,
      available: true,
      items: [{ ...STORED_RECORD, vector: [0.1, 0.2] }],
      total: 1,
      offset: 0,
      limit: 20,
      query: "",
      loading: false,
      mutation: "",
      message: "",
      error: "",
      editor: null,
    });
    const markup = renderMemoryRecordList(view);

    expect(parseMemoryTags("one, two\nthree")).toEqual(["one", "two", "three"]);
    expect(buildMemoryDeleteConfirmation(STORED_RECORD)).toContain(
      STORED_RECORD.content,
    );
    expect(markup).toContain("Dor prefers concise answers.");
    expect(markup).toContain('aria-label="Edit memory"');
    expect(markup).toContain('aria-label="Delete memory"');
    expect(markup).not.toContain(">Edit</button>");
    expect(markup).not.toContain(">Delete</button>");
    expect(markup).not.toContain("0.1");
    expect(
      createMemoryManagerView({
        ...view,
        enabled: true,
        available: false,
      }).status,
    ).toEqual({ tone: "unavailable", label: "Unavailable" });
    expect(
      renderMemoryRecordList({
        ...view,
        items: [],
        total: 0,
        loading: true,
      }),
    ).toContain("Loading memories");
    expect(
      renderMemoryRecordList({
        ...view,
        items: [],
        total: 0,
        loading: false,
      }),
    ).toContain("No long-term memories");
    expect(
      managementErrorMessage({
        code: "long_term_memory_management_sensitive_data",
      }),
    ).toContain("sensitive");
  });

  test("keeps long content collapsible and places edit forms beside the selected record", () => {
    const longRecord = {
      ...STORED_RECORD,
      content: "A detailed preference. ".repeat(20),
    };
    const view = createMemoryManagerView({
      enabled: true,
      available: true,
      items: [longRecord],
      total: 1,
      offset: 0,
      limit: 20,
      query: "",
      loading: false,
      mutation: "",
      message: "",
      error: "",
      editor: { mode: "edit", recordId: longRecord.id, draft: null },
    });

    const markup = renderMemoryRecordList(view);
    expect(markup).toContain('data-memory-management-action="toggle-content"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup.indexOf("memory-record")).toBeLessThan(
      markup.indexOf("memory-editor-card"),
    );
    expect(renderMemoryRecordEditor(view)).toContain('rows="3"');
  });
});
