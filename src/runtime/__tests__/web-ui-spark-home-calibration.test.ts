import { expect, test, vi } from "vitest";
import { FakeElement } from "./support/model-setup-wizard-harness.js";
import { readSparkHomeCalibrationOptions } from "../spark-home/calibration/options.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
// @ts-expect-error Browser controller.
import { createSparkHomeCalibrationController } from "../../web-ui/app/controllers/spark-home-calibration-controller.js";
// @ts-expect-error Browser settings owner.
import { createSparkHomeSettingsController } from "../../web-ui/app/controllers/spark-home-settings-controller.js";
// @ts-expect-error Browser dialog.
import { createSparkHomeCalibrationDialog } from "../../web-ui/app/components/spark-home/calibration-dialog.js";

const options = [
  { id: "calendar", label: "Calendar", description: "The current date", available: true, reason: null },
  { id: "web_topics", label: "Updates", description: "Topics you choose", available: false, reason: "Web is unavailable" },
];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function fixture(instructions = "") {
  const document = {} as ConstructorParameters<typeof FakeElement>[1];
  document.createElement = (tag) => new FakeElement(tag, document);
  document.documentElement = document.createElement("html"); document.body = document.createElement("body");
  const launcher = document.createElement("button"); document.body.append(launcher); launcher.focus();
  let environment = "dev";
  let stored = { revision: 4, personalInstructions: instructions, modelProfileId: null as string | null,
    available: true, models: [{ id: "home-model", label: "Home model" }], calibrationRequired: !instructions.trim() };
  const client = {
    getSparkHomeSettings: vi.fn(async () => ({ settings: structuredClone(stored) })),
    listModels: vi.fn(async () => ({ profiles: [{ id: "home-model" }] })),
    configureSparkHomeSettings: vi.fn(async (input: any, _environment: string) => {
      stored = { ...stored, ...input, revision: stored.revision + 1, calibrationRequired: !input.personalInstructions.trim() };
      return { settings: structuredClone(stored) };
    }),
    getSparkHomeCalibrationOptions: vi.fn(async (_input: any, _environment: string) => ({ calibration: { options } })),
    draftSparkHomeInstructions: vi.fn(async (_input: any, _environment: string) => ({ draft: { personalInstructions: "Generated direction" } })),
  };
  const settings = createSparkHomeSettingsController({ client, getEnvironmentId: () => environment, canUseSettings: () => true, render: vi.fn() });
  let controller: any;
  const view = createSparkHomeCalibrationDialog({ documentRoot: document,
    onChange: (name: string, value: unknown) => controller.change(name, value), onDraft: () => controller.draft(),
    onSave: (request: boolean) => controller.save(request), onClose: () => controller.close() });
  const onSaved = vi.fn(); const onRequest = vi.fn(async () => true);
  controller = createSparkHomeCalibrationController({ client, settings, getEnvironmentId: () => environment, render: view.render, onSaved, onRequest });
  const query = (selector: string) => document.body.querySelector(selector)!;
  return { controller, client, settings, document, launcher, query, onSaved, onRequest,
    environment: (next: string) => { environment = next; controller.environmentChanged(); return settings.environmentChanged(); } };
}

test("first request opens setup without saving, generating, or choosing personal defaults", async () => {
  const h = await fixture();
  await h.controller.requestScreen();
  expect(h.controller.snapshot()).toMatchObject({ open: true, answers: { widgetIds: [], topics: "", constraints: "", personalInstructions: "" } });
  expect(h.query("dialog").open).toBe(true);
  expect(h.query('input[value="web_topics"]').disabled).toBe(true);
  expect(h.query('input[value="calendar"]').disabled).toBe(false);
  expect(h.onRequest).not.toHaveBeenCalled();
  expect(h.client.configureSparkHomeSettings).not.toHaveBeenCalled();
  expect(h.client.draftSparkHomeInstructions).not.toHaveBeenCalled();
});

test("a saved personal direction skips onboarding without overwriting it", async () => {
  const h = await fixture("Existing direction");
  await h.controller.requestScreen();
  expect(h.onRequest).toHaveBeenCalledOnce();
  expect(h.controller.snapshot().open).toBe(false);
  expect(h.client.getSparkHomeCalibrationOptions).not.toHaveBeenCalled();
  expect(h.client.configureSparkHomeSettings).not.toHaveBeenCalled();
});

test("guided answers reach only the draft endpoint and remain editable before explicit save", async () => {
  const h = await fixture(); await h.controller.open();
  h.controller.change("widgetIds", ["calendar", "web_topics"]);
  h.controller.change("topics", "Astronomy"); h.controller.change("constraints", "Brief, in Hebrew");
  expect(await h.controller.draft()).toBe(true);
  expect(h.client.draftSparkHomeInstructions).toHaveBeenCalledExactlyOnceWith({ expectedRevision: 4, modelProfileId: null,
    widgetIds: ["calendar"], topics: "Astronomy", constraints: "Brief, in Hebrew" }, "dev");
  expect(h.query("[data-calibration-preview]").hidden).toBe(false);
  expect(h.client.configureSparkHomeSettings).not.toHaveBeenCalled();
  expect(h.onSaved).not.toHaveBeenCalled();
  const preview = h.query('[data-calibration-field="personalInstructions"]');
  preview.value = "Edited direction"; preview.dispatch("input");
  expect(await h.controller.save(false)).toBe(true);
  expect(h.client.configureSparkHomeSettings.mock.lastCall?.[0]).toMatchObject({ personalInstructions: "Edited direction" });
  expect(h.onSaved).toHaveBeenCalledExactlyOnceWith({ requestScreen: false, environmentId: "dev" });
});

test("the guided system monitor is selectable without probe plugins and keeps the user's review step", async () => {
  const h = await fixture();
  const nativeOptions = readSparkHomeCalibrationOptions({ tools: createConfiguredToolRegistry(undefined, []), toolPermissionMode: "ask" });
  h.client.getSparkHomeCalibrationOptions.mockResolvedValueOnce({ calibration: { options: [...nativeOptions] } });
  await h.controller.open();
  const checkbox = h.query('input[value="system_status"]');
  expect(checkbox.disabled).toBe(false);
  expect((checkbox as any).checked).toBe(false);
  h.controller.change("widgetIds", ["system_status"]);
  expect(await h.controller.draft()).toBe(true);
  expect(h.client.draftSparkHomeInstructions).toHaveBeenCalledExactlyOnceWith({ expectedRevision: 4, modelProfileId: null,
    widgetIds: ["system_status"], topics: "", constraints: "" }, "dev");
  expect(h.query("[data-calibration-preview]").hidden).toBe(false);
  expect(h.client.configureSparkHomeSettings).not.toHaveBeenCalled();
  expect(h.onRequest).not.toHaveBeenCalled();
});

test("manual instructions use the HOME settings draft and preserve the selected model", async () => {
  const h = await fixture(); await h.settings.loadForCalibration();
  h.settings.change("modelProfileId", "home-model");
  await h.controller.open();
  expect(h.client.getSparkHomeCalibrationOptions).toHaveBeenCalledExactlyOnceWith({ expectedRevision: 4, modelProfileId: "home-model" }, "dev");
  h.controller.change("mode", "manual"); h.controller.change("personalInstructions", "My own direction");
  expect(await h.controller.save(true)).toBe(true);
  expect(h.client.configureSparkHomeSettings.mock.lastCall?.[0]).toEqual({ expectedRevision: 4, personalInstructions: "My own direction", modelProfileId: "home-model" });
  expect(h.client.draftSparkHomeInstructions).not.toHaveBeenCalled();
  expect(h.onSaved).toHaveBeenCalledExactlyOnceWith({ requestScreen: true, environmentId: "dev" });
  expect(h.query("dialog").open).toBe(false);
});

test("draft failure preserves answers and manual writing remains available", async () => {
  const h = await fixture(); await h.controller.open();
  h.controller.change("topics", "Gardening");
  h.client.draftSparkHomeInstructions.mockRejectedValueOnce(new Error("Model unavailable"));
  expect(await h.controller.draft()).toBe(false);
  expect(h.controller.snapshot()).toMatchObject({ answers: { topics: "Gardening" }, drafting: false, error: "Model unavailable" });
  h.controller.change("mode", "manual"); h.controller.change("personalInstructions", "Gardening ideas");
  expect(await h.controller.save()).toBe(true);
});

test("closing the dialog retains answers and ignores late model output without persisting it", async () => {
  const h = await fixture(); await h.controller.open();
  h.controller.change("topics", "Design");
  const pending = deferred<any>(); h.client.draftSparkHomeInstructions.mockReturnValueOnce(pending.promise);
  const drafting = h.controller.draft(); h.query("dialog").dispatch("cancel");
  expect(h.document.activeElement).toBe(h.launcher);
  pending.resolve({ draft: { personalInstructions: "Late output" } }); await drafting;
  expect(h.controller.snapshot()).toMatchObject({ open: false, answers: { topics: "Design", personalInstructions: "" } });
  expect(h.client.configureSparkHomeSettings).not.toHaveBeenCalled();
  await h.controller.open(); expect(h.query('[data-calibration-field="topics"]').value).toBe("Design");
});

test("environment switch clears private answers and rejects late draft results", async () => {
  const h = await fixture(); await h.controller.open(); h.controller.change("topics", "Private topic");
  const pending = deferred<any>(); h.client.draftSparkHomeInstructions.mockReturnValueOnce(pending.promise);
  const drafting = h.controller.draft(); await h.environment("prod");
  pending.resolve({ draft: { personalInstructions: "Private output" } }); await drafting;
  expect(h.controller.snapshot()).toMatchObject({ open: false, environmentId: "prod", answers: { topics: "", personalInstructions: "" } });
  expect(h.onSaved).not.toHaveBeenCalled();
});

test("save conflicts retain the proposed instructions and never request a screen", async () => {
  const h = await fixture(); await h.controller.open();
  h.controller.change("mode", "manual"); h.controller.change("personalInstructions", "My pending direction");
  h.client.configureSparkHomeSettings.mockRejectedValueOnce(Object.assign(new Error("Conflict"), { code: "spark_home_settings_conflict" }));
  expect(await h.controller.save(true)).toBe(false);
  expect(h.controller.snapshot()).toMatchObject({ open: true, answers: { personalInstructions: "My pending direction" }, saving: false });
  expect(h.onSaved).not.toHaveBeenCalled();
  expect(h.settings.snapshot().reloadRequired).toBe(true);
});

test("no-input guided draft and blank manual instructions never call model or persistence", async () => {
  const h = await fixture(); await h.controller.open();
  expect(await h.controller.draft()).toBe(false);
  h.controller.change("mode", "manual"); h.controller.change("personalInstructions", "   ");
  expect(await h.controller.save(true)).toBe(false);
  expect(h.client.draftSparkHomeInstructions).not.toHaveBeenCalled();
  expect(h.client.configureSparkHomeSettings).not.toHaveBeenCalled();
});

test("a selected choice that becomes unavailable remains visible and removable without silent preference loss", async () => {
  const h = await fixture(); await h.controller.open(); h.controller.change("widgetIds", ["calendar"]);
  h.controller.close();
  h.client.getSparkHomeCalibrationOptions.mockResolvedValueOnce({ calibration: { options: [
    { ...options[0]!, available: false, reason: "No longer available" },
    { ...options[1]!, available: true, reason: null },
  ] } });
  await h.controller.open();
  expect(h.query('input[value="calendar"]').disabled).toBe(false);
  expect((h.query('input[value="calendar"]') as any).checked).toBe(true);
  h.controller.change("widgetIds", ["calendar", "web_topics"]);
  expect(h.controller.snapshot().answers.widgetIds).toEqual(["calendar", "web_topics"]);
  expect(await h.controller.draft()).toBe(false);
  expect(h.client.draftSparkHomeInstructions).not.toHaveBeenCalled();
  h.controller.change("widgetIds", ["web_topics"]);
  expect(h.query('input[value="calendar"]').disabled).toBe(true);
  expect(await h.controller.draft()).toBe(true);
});

test("known calibration failures show a human-readable recovery while retaining answers", async () => {
  const h = await fixture(); await h.controller.open(); h.controller.change("topics", "Science");
  h.client.draftSparkHomeInstructions.mockRejectedValueOnce(Object.assign(new Error("spark_home_calibration_options_changed"), { code: "spark_home_calibration_options_changed" }));
  expect(await h.controller.draft()).toBe(false);
  expect(h.query("[data-calibration-status]").textContent).toContain("available HOME choices changed");
  expect(h.query("[data-calibration-status]").textContent).not.toContain("spark_home_");
  expect(h.controller.snapshot().answers.topics).toBe("Science");
});

test("new settings edits take precedence over a previously retained wizard preview", async () => {
  const h = await fixture("Existing direction"); await h.controller.open();
  h.controller.change("personalInstructions", "Retained wizard draft"); h.controller.close();
  await h.controller.open();
  expect(h.controller.snapshot().answers.personalInstructions).toBe("Retained wizard draft");
  h.controller.close(); h.settings.change("personalInstructions", "New settings edit");
  await h.controller.open();
  expect(h.controller.snapshot().answers.personalInstructions).toBe("New settings edit");
  expect(h.client.configureSparkHomeSettings).not.toHaveBeenCalled();
});
