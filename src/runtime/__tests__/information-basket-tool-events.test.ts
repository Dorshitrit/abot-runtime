import { createHash } from "node:crypto";
import { expect, test, vi } from "vitest";
import type { ToolEventMetadata } from "../../capabilities/tool-types.js";
import { buildToolCompletedEventMetadata } from "../../capabilities/tool-event-metadata.js";
import { captureRegisteredToolResult } from "../adapters/registered-tool-worker-capabilities/result-evidence.js";
import { resolveRegisteredToolCapabilityCatalog } from "../adapters/registered-tool-worker-capabilities/catalog.js";
import { createRegisteredToolNormalInvocationExecutor } from "../adapters/registered-tool-normal-invocations.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { createInformationBasketToolModule } from "../capabilities/information-basket/tool-module.js";
import { InformationBasketError, type InformationBasketService } from "../information-basket/contracts.js";

const sourceId = "basket-9b33376e-e415-44c7-9d1b-fd10f6900407";
const source = {
  sourceId, revision: 1, displayName: "Research notes", status: "ready",
  path: "/PRIVATE_PATH/research.txt", sizeBytes: 30, chunkCount: 1, indexedAt: "2026-10-25T00:00:00Z", reason: null,
};
const read = {
  sourceId, expectedRevision: 1, displayName: source.displayName, path: source.path,
  contentHash: "a".repeat(64), text: "PRIVATE_BODY", startChar: 0, endChar: 12, totalCharacters: 12,
  omittedBefore: 0, omittedAfter: 0, nextStartChar: null,
};
const found = {
  status: "found", sources: [{
    sourceId, expectedRevision: 1, displayName: source.displayName, path: source.path, score: 0.9,
    matches: [{ chunkId: "chunk-0", startChar: 0, endChar: 12 }],
  }], omittedCount: 2,
};

function fixture(options: { presentation?: boolean; search?: unknown; names?: readonly string[]; failRead?: boolean } = {}) {
  const service = {
    isReady: () => true,
    list: async () => ({ settings: { enabled: true, revision: 1, embeddingProfileId: "fixture" },
      sources: (options.names ?? [source.displayName]).map((displayName, index) => ({
        ...source, sourceId: sourceId + "-" + index, displayName,
      })) }),
    search: async () => options.search ?? found,
    readSource: async () => {
      if (options.failRead) throw new InformationBasketError("basket_source_stale");
      return read;
    },
  } as unknown as InformationBasketService;
  const declared = createInformationBasketToolModule(service);
  const module = options.presentation === false
    ? { ...declared, definition: { ...declared.definition, eventPresentation: undefined } } : declared;
  const registry = createConfiguredToolRegistry(undefined, [module]);
  const onEvent = vi.fn();
  const executor = createRegisteredToolNormalInvocationExecutor({
    registrations: registry.listNormalInvocations!(), toolRegistry: registry,
    requestId: "basket-events", abortSignal: new AbortController().signal, toolPermissionMode: "ask",
    nextApprovalId: () => "basket-events-approval", onEvent,
  });
  async function execute(operationId: string, controls: Record<string, unknown> = {}) {
    const operation = executor.operations.find(entry => entry.operation.operationId === operationId)!;
    const prepared = await executor.prepare({ handle: operation.handle, controls });
    if (prepared.status !== "prepared") throw new Error("fixture_not_prepared");
    const executed = await prepared.execute();
    if (executed.status !== "executed") throw new Error("fixture_not_executed");
    const completed = onEvent.mock.calls.find(([name]) => name === "tool.completed")?.[1] as { meta?: ToolEventMetadata };
    return { executed, completed: completed.meta, events: onEvent.mock.calls };
  }
  return { execute, registry };
}
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

test.each([
  { operationId: "list_information_sources", controls: {}, expected: { documentName1: source.displayName, itemCount: 1, omittedDocumentCount: 0 } },
  { operationId: "search_information_sources", controls: { query: "PRIVATE_QUERY" },
    expected: { documentName1: source.displayName, itemCount: 1, omittedDocumentCount: 2, basketSearchStatus: "found" } },
  { operationId: "read_information_source", controls: { sourceId, expectedRevision: 1 },
    expected: { documentName: source.displayName, itemCount: 1 } },
])("ordinary  events expose names and counts without changing canonical results", async ({ operationId, controls, expected }) => {
  const current = fixture(), baseline = fixture({ presentation: false });
  const actual = await current.execute(operationId, controls);
  const original = await baseline.execute(operationId, controls);
  expect(actual.completed).toMatchObject({ basketAction: operationId, ...expected });
  expect(actual.executed.result).toEqual(original.executed.result);
  const evidence = captureRegisteredToolResult(actual.executed);
  expect(digest(evidence)).toBe(digest(captureRegisteredToolResult(original.executed)));
  const before = JSON.stringify(actual.executed.result);
  Object.freeze(actual.executed.result.data);
  Object.freeze(actual.executed.result);
  buildToolCompletedEventMetadata({ tool: "information_basket", params: { action: operationId, ...controls } },
    actual.executed.result, current.registry.getDefinition("information_basket"));
  expect(JSON.stringify(actual.executed.result)).toBe(before);
  expect(JSON.stringify(actual.events)).not.toContain("PRIVATE");
  expect(actual.completed).not.toHaveProperty("outputPreview");
  expect(actual.completed).not.toHaveProperty("params");
  expect(actual.executed.result.data).toEqual({ mutationEvidence: false, itemCount: 1 });
  expect(resolveRegisteredToolCapabilityCatalog(current.registry, false).descriptors)
    .toEqual(resolveRegisteredToolCapabilityCatalog(baseline.registry, false).descriptors);
});

test.each(["empty", "unavailable"])("search %s events retain zero count and status without source content", async (status) => {
  const f = fixture({ search: { status, sources: [], omittedCount: 0 } });
  const result = await f.execute("search_information_sources", { query: "PRIVATE_QUERY" });
  expect(result.completed).toMatchObject({ basketSearchStatus: status, itemCount: 0, omittedDocumentCount: 0 });
  expect(result.completed).not.toHaveProperty("documentName1");
  expect(JSON.stringify(result.events)).not.toContain("PRIVATE");
});

test("list events expose at most five returned names while preserving counts and evidence", async () => {
  const names = Array.from({ length: 23 }, (_, index) => "Document " + index);
  const result = await fixture({ names }).execute("list_information_sources");
  expect(result.completed).toMatchObject({
    documentName1: "Document 0", documentName5: "Document 4", itemCount: 20, omittedDocumentCount: 3,
  });
  expect(result.completed).not.toHaveProperty("documentName6");
  expect(JSON.parse(result.executed.result.output).sources).toHaveLength(20);
});

test("failed source reads keep error identity and never manufacture document names", async () => {
  const result = await fixture({ failRead: true }).execute("read_information_source", { sourceId, expectedRevision: 1 });
  expect(result.executed.result).toMatchObject({ ok: false, errorCode: "basket_source_stale" });
  expect(result.completed).toMatchObject({ basketAction: "read_information_source", basketSourceId: sourceId, errorCode: "basket_source_stale" });
  expect(result.completed).not.toHaveProperty("documentName");
  expect(result.completed).not.toHaveProperty("outputPreview");
});
