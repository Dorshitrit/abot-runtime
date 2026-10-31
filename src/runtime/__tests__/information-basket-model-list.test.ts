import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createRegisteredToolNormalInvocationExecutor } from "../adapters/registered-tool-normal-invocations.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { createInformationBasketToolModule } from "../capabilities/information-basket/tool-module.js";
import type { BasketSource, BasketView, InformationBasketService } from "../information-basket/contracts.js";
import { createInformationBasketService } from "../information-basket/service.js";
import type { ModelGatewayEmbeddingParams } from "../../model-gateway/types.js";
import { loadPublicRuntimeConfig } from "./public-runtime-config-fixture.js";
import { configureBasket, fixtureEmbedding, waitForBasketSource } from "./support/information-basket-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const unreadyStatuses = ["queued", "indexing", "failed", "stale", "missing", "unsupported"] as const;

function source(index: number, status: BasketSource["status"]): BasketSource {
  return {
    sourceId: "basket-00000000-0000-4000-8000-" + String(index).padStart(12, "0"),
    displayName: (status === "ready" ? "Visible" : "HIDDEN_" + status) + "_" + index,
    path: "/sources/document-" + index + ".txt", revision: index + 1, status,
    sizeBytes: 100, chunkCount: status === "ready" ? 1 : 0,
    indexedAt: status === "ready" ? "2026-10-25T00:00:00.000Z" : null, reason: null,
  };
}

function serviceFixture(sources: readonly BasketSource[]) {
  const view: BasketView = {
    settings: { matchMode: "balanced" as const, indexChatUploads: false, enabled: true, embeddingProfileId: "fixture", revision: 1 }, sources,
    embeddingProfiles: [], supportedExtensions: [".txt"],
    limits: { maxSources: 200, maxSourceBytes: 1024, maxReadCharacters: 1000 },
  };
  const list = vi.fn(async () => view);
  const service = { list, isReady: () => view.sources.some(entry => entry.status === "ready") } as unknown as InformationBasketService;
  return { service, view, list };
}

async function modelList(service: InformationBasketService) {
  const base = createConfiguredToolRegistry(undefined, [createInformationBasketToolModule(service)]);
  const registry = await base.prepareRequest!();
  const executor = createRegisteredToolNormalInvocationExecutor({
    registrations: registry.listNormalInvocations!(), toolRegistry: registry,
    nextApprovalId: () => "unexpected-basket-list-approval", requestId: "basket-model-list",
    abortSignal: new AbortController().signal, toolPermissionMode: "ask",
  });
  const operation = executor.operations.find(entry => entry.operation.operationId === "list_information_sources")!;
  expect(operation).toBeDefined();
  return async (cursor?: string) => {
    const prepared = await executor.prepare({ handle: operation.handle, controls: cursor === undefined ? {} : { cursor } });
    if (prepared.status !== "prepared") throw new Error("list_fixture_not_prepared");
    expect(prepared.approvalRequest).toBeUndefined();
    const executed = await prepared.execute();
    if (executed.status !== "executed") throw new Error("list_fixture_not_executed");
    return executed.result;
  };
}

type ListPage = {
  sources: Array<{ sourceId: string; expectedRevision: number; displayName: string; status: string }>;
  omittedCount: number;
  nextCursor: string | null;
};
const visible = (entry: BasketSource) => ({ sourceId: entry.sourceId, expectedRevision: entry.revision,
  displayName: entry.displayName, status: "ready" });

function assertNoHiddenSources(value: unknown, sources: readonly BasketSource[]) {
  const serialized = JSON.stringify(value);
  for (const entry of sources.filter(entry => entry.status !== "ready")) {
    expect(serialized).not.toContain(entry.sourceId);
    expect(serialized).not.toContain(entry.displayName);
  }
}

test("registered model listing exposes only ready references while GUI metadata retains every status", async () => {
  const sources = [source(1, "ready"), ...unreadyStatuses.map((status, i) => source(i + 2, status)), source(8, "ready")];
  const f = serviceFixture(sources);
  const before = await f.service.list();
  const result = await (await modelList(f.service))();
  expect(result.ok).toBe(true);
  const page = JSON.parse(result.output) as ListPage;
  expect(page).toEqual({ sources: [visible(sources[0]!), visible(sources.at(-1)!)], omittedCount: 0, nextCursor: null });
  expect(result.data).toMatchObject({ itemCount: 2, mutationEvidence: false });
  assertNoHiddenSources(result, sources);
  expect(await f.service.list()).toBe(before);
  expect(before.sources).toEqual(sources);
  expect(before.sources.map(entry => entry.status)).toEqual(["ready", ...unreadyStatuses, "ready"]);
});

test("pagination counts and cursors follow the ready subset despite interleaved unavailable rows", async () => {
  const ready = Array.from({ length: 45 }, (_, index) => source(index * 2 + 1, "ready"));
  const sources = ready.flatMap((entry, index) => [source(index * 2 + 2, unreadyStatuses[index % unreadyStatuses.length]!), entry]);
  const f = serviceFixture(sources);
  const list = await modelList(f.service);
  const first = await list();
  const firstPage = JSON.parse(first.output) as ListPage;
  expect(firstPage).toEqual({ sources: ready.slice(0, 20).map(visible), omittedCount: 25, nextCursor: ready[19]!.sourceId });
  const second = await list(firstPage.nextCursor!);
  const secondPage = JSON.parse(second.output) as ListPage;
  expect(secondPage).toEqual({ sources: ready.slice(20, 40).map(visible), omittedCount: 5, nextCursor: ready[39]!.sourceId });
  const third = await list(secondPage.nextCursor!);
  const thirdPage = JSON.parse(third.output) as ListPage;
  expect(thirdPage).toEqual({ sources: ready.slice(40).map(visible), omittedCount: 0, nextCursor: null });
  expect(first.data).toMatchObject({ itemCount: 20 });
  expect(second.data).toMatchObject({ itemCount: 20 });
  expect(third.data).toMatchObject({ itemCount: 5 });
  assertNoHiddenSources([first, second, third], sources);
  expect((await f.service.list()).sources).toHaveLength(90);
});

test.each(unreadyStatuses)("a %s source cannot be used as a model-list cursor", async status => {
  const hidden = source(1, status);
  const f = serviceFixture([hidden, source(2, "ready")]);
  const result = await (await modelList(f.service))(hidden.sourceId);
  expect(result).toMatchObject({ ok: false, errorCode: "basket_source_cursor_stale", producedNewInformation: false });
  assertNoHiddenSources(result, [hidden]);
});

test("a previously ready cursor becomes stale when the source loses readiness", async () => {
  const first = source(1, "ready");
  const sources = [first, source(2, "ready")];
  const f = serviceFixture(sources);
  const list = await modelList(f.service);
  expect((await list(first.sourceId)).ok).toBe(true);
  sources[0] = { ...first, status: "stale", chunkCount: 0 };
  expect(await list(first.sourceId)).toMatchObject({ ok: false, errorCode: "basket_source_cursor_stale" });
  const page = JSON.parse((await list()).output) as ListPage;
  expect(page.sources).toEqual([visible(sources[1]!)]);
  expect((await f.service.list()).sources[0]!.status).toBe("stale");
});

test("refreshing a real indexed source hides it from an existing model tool while GUI reports indexing", async () => {
  const base = join(process.cwd(), ".codex", "artifacts", "information-basket-model-list-20261025");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "case-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "source.txt");
  await writeFile(path, "A registered source used to test readiness transitions.");
  const original = loadPublicRuntimeConfig([]);
  let holdIndex = false;
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const embed = vi.fn(async (input: ModelGatewayEmbeddingParams) => {
    if (holdIndex) await waiting;
    return fixtureEmbedding(input);
  });
  const service = createInformationBasketService({ config: {
    ...original, runtimeId: "model-list-fixture",
    paths: { ...original.paths, runtimeDir: join(root, "runtime"), agentWorkDir: root, workspaceDir: root },
    models: { ...original.models,
      providers: { ...original.models?.providers, basketFixture: { type: "ollama", baseUrl: "http://invalid.test" } },
      embeddingProfiles: { fixture: { label: "Fixture", provider: "basketFixture", model: "fixture" } },
    },
  }, models: { embed } });
  cleanups.push(async () => { const stopping = service.stop(); release(); await stopping; });
  await service.start();
  await configureBasket(service);
  await service.addSources({ paths: [path] });
  const ready = await waitForBasketSource(service);
  const list = await modelList(service);
  expect(JSON.parse((await list()).output).sources).toEqual([visible(ready)]);

  holdIndex = true;
  await service.refreshSource({ sourceId: ready.sourceId, expectedRevision: ready.revision });
  const indexing = await waitForBasketSource(service, "indexing");
  const result = await list();
  expect(result.ok).toBe(true);
  expect(JSON.parse(result.output)).toEqual({ sources: [], omittedCount: 0, nextCursor: null });
  assertNoHiddenSources(result, [indexing]);
  expect(await list(ready.sourceId)).toMatchObject({ ok: false, errorCode: "basket_source_cursor_stale" });
  expect((await service.list()).sources).toEqual([indexing]);
});
