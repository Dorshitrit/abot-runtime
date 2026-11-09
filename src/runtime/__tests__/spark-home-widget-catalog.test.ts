import { afterEach, expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { createHomeGenerationFixture } from "./support/spark-home-generation-fixture.js";
import { disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";
import { captureSparkHomeWidgetSlots } from "../spark-home/widgets/slots.js";
import { SPARK_HOME_WIDGET_CATALOG, SPARK_HOME_DASHBOARD_WIDGET_IDS,
  SPARK_HOME_DASHBOARD_WIDGET_MINIMUM, SPARK_HOME_WIDGET_LIMIT, findSparkHomeWidget } from "../spark-home/widgets/catalog.js";

afterEach(disposeCompositionFixtures);

test("native widget placement is passive HOME-only metadata without data or mutation authority", async () => {
  const f = await createHomeGenerationFixture();
  const run = await f.service.start({ expectedSettingsRevision: 1, instruction: "Keep my existing direction." });
  expect(await f.service.wait(run.runId)).toMatchObject({ status: "completed" });
  expect(f.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual(["spark_home.plan", "spark_home.followup", "spark_home.html"]);
  const messages = f.invoke.mock.calls.map(([input]) => input.messages as ChatMessage[]);
  for (const phase of messages) {
    expect(phase.map(message => message.role)).toEqual(["system", "user", "user"]);
    const requirements = JSON.parse(phase[1].content);
    expect(requirements).toMatchObject({ personalInstructions: "Show sourced astronomy news and today's date.", currentInstruction: "Keep my existing direction." });
    expect(requirements).not.toHaveProperty("systemWidgets");
    const reference = JSON.parse(phase[2].content);
    expect(reference).toMatchObject({ authority: "passive_reference", addsUserIntent: false, grantsActionAuthority: false });
    expect(reference.reference.systemWidgets).toEqual(SPARK_HOME_WIDGET_CATALOG);
    expect(reference.reference.systemWidgets.entries).toHaveLength(11);
    expect(reference.reference.systemWidgets.entries.find((entry: { id: string }) => entry.id === "system-metrics"))
      .toMatchObject({ group: "monitoring", defaultHeight: 280 });
    expect(reference.reference.systemWidgets.selection).toEqual({ dashboard: {
      minimum: SPARK_HOME_DASHBOARD_WIDGET_MINIMUM, ids: SPARK_HOME_DASHBOARD_WIDGET_IDS,
    }, otherWidgets: "optional", explicitUserExclusions: "authoritative" });
    for (const widget of reference.reference.systemWidgets.entries) {
      expect(widget).not.toHaveProperty("records");
      expect(widget).not.toHaveProperty("controls");
      expect(widget).not.toHaveProperty("api");
    }
  }
  expect(messages.map(phase => phase[1].content)).toEqual(Array(3).fill(messages[0][1].content));
  expect(f.models.invokeRaw).not.toHaveBeenCalled();
});

test("six dashboard components form their own bounded group and existing management widgets remain optional", () => {
  expect(SPARK_HOME_DASHBOARD_WIDGET_IDS).toEqual([
    "spark-status", "conversations", "approvals", "recent-activity", "automations", "computer-access",
  ]);
  const entries = SPARK_HOME_WIDGET_CATALOG.entries;
  expect(new Set(entries.map(widget => widget.id)).size).toBe(entries.length);
  expect(entries).toHaveLength(11);
  expect(SPARK_HOME_WIDGET_LIMIT).toBe(10);
  expect(SPARK_HOME_DASHBOARD_WIDGET_MINIMUM).toBe(3);
  expect(entries.filter(widget => widget.group === "dashboard").map(widget => widget.id)).toEqual(SPARK_HOME_DASHBOARD_WIDGET_IDS);
  expect(entries.filter(widget => widget.group === "management").map(widget => widget.id))
    .toEqual(["memory-candidates", "skills", "resources", "feature-discovery"]);
  for (const id of SPARK_HOME_DASHBOARD_WIDGET_IDS)
    expect(findSparkHomeWidget(id)).toMatchObject({ id, group: "dashboard", defaultHeight: 200 });
  expect(findSparkHomeWidget("unknown-widget")).toBeUndefined();
});

test("a generated monitor slot publishes without metric data, tool calls or a new mandatory dashboard card", async () => {
  const f = await createHomeGenerationFixture();
  f.setHtml('<html><body><div data-abot-widget="spark-status"></div><div data-abot-widget="conversations"></div>'
    + '<div data-abot-widget="approvals"></div><div data-abot-widget="system-metrics"></div></body></html>');
  const run = await f.service.start({ expectedSettingsRevision: 1, instruction: "Include a system monitor." });
  expect(await f.service.wait(run.runId)).toMatchObject({ status: "completed" });
  const published = f.screen().html!;
  expect(captureSparkHomeWidgetSlots(published).slots.map(slot => slot.widgetId))
    .toEqual(["spark-status", "conversations", "approvals", "system-metrics"]);
  expect(f.invoke).toHaveBeenCalledTimes(3);
  expect(f.models.invokeRaw).not.toHaveBeenCalled();
  expect(published).not.toMatch(/sampledAt|usedBytes|celsius|system-metrics\?/);
});
