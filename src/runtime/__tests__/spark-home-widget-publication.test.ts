import { afterEach, expect, test } from "vitest";
import { createHomeGenerationFixture } from "./support/spark-home-generation-fixture.js";
import { disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";
import { hasRequiredSparkHomeDashboardWidgets } from "../spark-home/widgets/publication.js";

afterEach(disposeCompositionFixtures);
const slots = (...ids: string[]) => ids.map(id => `<div data-abot-widget="${id}"></div>`).join("");

test.each([
  ["none", "<p>New content</p>"],
  ["one", slots("conversations")],
  ["two", slots("conversations", "approvals")],
  ["duplicates", slots("conversations", "conversations", "conversations")],
  ["only management", slots("memory-candidates", "skills", "resources", "feature-discovery")],
  ["mixed with management", slots("conversations", "approvals", "resources")],
  ["unknown IDs", slots("conversations", "not-registered", "not-another-widget")],
  ["inactive markup", slots("conversations") + `<template>${slots("approvals")}</template>`
    + `<svg><foreignObject>${slots("recent-activity")}</foreignObject></svg>`
    + `<!--${slots("automations")}--><script>const fake='${slots("computer-access")}';</script>`],
  ...["noscript", "iframe", "noembed", "noframes"].map(tag => [
    `${tag} text content`, `<${tag}>${slots("conversations", "approvals", "recent-activity")}</${tag}>`,
  ]),
  ["plaintext remainder", `<plaintext></plaintext>${slots("conversations", "approvals", "recent-activity")}`],
  ["partial before plaintext", slots("conversations", "approvals")
    + `<plaintext></plaintext>${slots("recent-activity")}`],
  ["forged instance", slots("conversations", "approvals") + '<div data-abot-widget="automations" data-abot-widget-slot="forged"></div>'],
])("%s cannot publish a replacement screen or trigger a repair call", async (_name, html) => {
  const f = await createHomeGenerationFixture();
  const previous = f.screen();
  f.setHtml(html);
  const run = await f.service.start({ expectedSettingsRevision: 1 });
  const result = await f.service.wait(run.runId);
  expect(result).toMatchObject({ status: "failed", phase: "compose", screenRevision: null,
    errorCode: "spark_home_dashboard_widgets_required" });
  expect(f.saved()).toEqual(result);
  expect(f.update).not.toHaveBeenCalled();
  expect(f.screen()).toBe(previous);
  expect(await f.dependencies.screen.read()).toEqual(previous);
  expect(f.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual(["spark_home.plan", "spark_home.followup", "spark_home.html"]);
});

test("three distinct Dashboard cards publish the authored HTML unchanged", async () => {
  const f = await createHomeGenerationFixture();
  const html = `<main><h1>My useful content</h1>${slots("recent-activity", "automations", "computer-access", "resources")}</main>`;
  f.setHtml(html);
  const run = await f.service.start({ expectedSettingsRevision: 1 });
  expect(await f.service.wait(run.runId)).toMatchObject({ status: "completed", screenRevision: 4, errorCode: null });
  expect(f.update).toHaveBeenCalledExactlyOnceWith({ expectedRevision: 3, html }, { abortSignal: expect.any(AbortSignal) });
  expect(f.screen().html).toBe(html);
});

test("plain text, non-div attributes and inert template references cannot replace supported static slots", () => {
  expect(hasRequiredSparkHomeDashboardWidgets('conversations approvals recent-activity')).toBe(false);
  expect(hasRequiredSparkHomeDashboardWidgets('<section data-abot-widget="conversations"></section>'
    + slots("approvals", "recent-activity"))).toBe(false);
  expect(hasRequiredSparkHomeDashboardWidgets(`<math>${slots("conversations", "approvals", "recent-activity")}</math>`)).toBe(false);
});
