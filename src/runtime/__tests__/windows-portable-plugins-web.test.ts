import { afterEach, expect, test } from "vitest";

import { createWebPlugin } from "../../../plugins/web/source/plugin.js";
import { WebPluginError } from "../../../plugins/web/source/errors.js";
import type { RuntimePluginEntrypointFactory } from "../../plugin-contract/entrypoint.js";
import { loadBundledPluginEntrypoint } from "./public-plugin-test-support.js";
import { article, feed, fixtureHttp, fixtureResponse, fixtureSource } from "./web-light-search/search-fixture.js";
import { createPortablePluginFixture, removePortablePluginFixtures } from "./windows-portable-plugins-fixture.js";

afterEach(removePortablePluginFixtures);

test("fetches readable public content through the portable transport interface", async () => {
  const context = await createPortablePluginFixture("web");
  const transport = fixtureHttp(({ url }) => fixtureResponse(url,
    article("Portable web", "Public source evidence from a deterministic fixture."),
  ));
  const plugin = createWebPlugin(context, transport);
  const result = await plugin.handlers.web_fetch!({ url: "https://portable.example/article" });
  expect(result).toMatchObject({ ok: true, data: { itemCount: 1 } });
  expect(result.output).toContain("Public source evidence");
  expect(result.output).toContain("BEGIN UNTRUSTED WEB CONTENT");
  expect(transport.requests).toHaveLength(1);
});

test("searches configured public sources with Light and no API key", async () => {
  const context = await createPortablePluginFixture("web");
  const source = fixtureSource("portable", "astronomy");
  const discoveredUrl = "https://portable.example/observation";
  const transport = fixtureHttp(({ url }) => {
    if (url === source.entryUrls[0]) return fixtureResponse(url,
      feed([{ title: "Astronomy observation", url: discoveredUrl }]),
      { contentType: "application/rss+xml" },
    );
    expect(url).toBe(discoveredUrl);
    return fixtureResponse(url, article("Astronomy observation", "Astronomy telescope evidence."));
  });
  const plugin = createWebPlugin({
    ...context,
    config: { light: { sources: [source] } },
  }, transport);
  const result = await plugin.handlers.web_search!({ query: "astronomy observation" });
  expect(result).toMatchObject({
    ok: true,
    data: { hasData: true, eventMeta: { lightSearch: { provider: "light" } } },
  });
  expect(result.output).toContain("Astronomy telescope evidence");
  expect(transport.requests.map(({ url }) => url)).toEqual([
    "https://portable.example/robots.txt", source.entryUrls[0], discoveredUrl,
  ]);
});

test("propagates caller cancellation while a fetch is pending", async () => {
  const context = await createPortablePluginFixture("web");
  const controller = new AbortController();
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
  const plugin = createWebPlugin(context, {
    httpClient: { get: (request) => new Promise((_resolve, reject) => {
      request.abortSignal?.addEventListener("abort", () => reject(
        new WebPluginError("web_request_aborted", "The web request was aborted."),
      ), { once: true });
      notifyStarted();
    }) },
  });
  const pending = plugin.handlers.web_fetch!({ url: "https://portable.example/slow" }, {
    abortSignal: controller.signal,
  });
  await started;
  controller.abort();
  expect(await pending).toMatchObject({
    ok: false,
    errorCode: "web_request_aborted",
    interruption: "aborted",
  });
});

test("bundled web rejects private URLs and pre-cancelled requests before network work", async () => {
  const context = await createPortablePluginFixture("web");
  const create = loadBundledPluginEntrypoint<
    Parameters<RuntimePluginEntrypointFactory>[0],
    ReturnType<RuntimePluginEntrypointFactory>
  >("web");
  const plugin = create(context);
  expect(await plugin.handlers.web_fetch!({ url: "http://127.0.0.1/" })).toMatchObject({
    ok: false,
    errorCode: "web_target_not_public",
  });
  const controller = new AbortController();
  controller.abort();
  expect(await plugin.handlers.web_fetch!({ url: "https://portable.example/cancelled" }, {
    abortSignal: controller.signal,
  })).toMatchObject({ ok: false, errorCode: "web_request_aborted", interruption: "aborted" });
});
