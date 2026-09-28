import { describe, expect, test, vi } from "vitest";
import { DEFAULT_LEARNING_PREFERENCES } from "../passive-learning/store.js";
// @ts-expect-error Browser-only component.
import { createLearningSettings } from "../../web-ui/app/components/passive-learning/settings.js";
// @ts-expect-error Browser-only view.
import { learningSettingsMarkup } from "../../web-ui/app/components/passive-learning/settings-view.js";
// @ts-expect-error Browser-only view.
import { learningUsageMarkup, renderResourceUsage } from "../../web-ui/app/components/passive-learning/usage-view.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

function fixture() {
  const document = {} as ConstructorParameters<typeof FakeElement>[1];
  document.createElement = (tag) => new FakeElement(tag, document);
  document.documentElement = document.createElement("html"); document.body = document.createElement("body");
  const root = document.createElement("section");
  root.innerHTML = learningSettingsMarkup("Asia/Jerusalem") + learningUsageMarkup();
  let snapshot: any = { environmentId: "dev", saving: false, models: [{ id: "local", label: "Local", provider: "ollama" },
    { id: "cloud", label: "Cloud", provider: "openai" }], candidates: [{ id: "candidate", content: "Knowledge" }],
    status: { preferences: { enabled: false, processingPaused: true, modelProfileId: "local", proactiveEnabled: false,
      proactiveModelProfileId: "cloud", analysisIntervalMinutes: 5, maxConcurrentBatches: 2,
      resourceLimits: { modelCallsPerDay: 34, embeddingCallsPerDay: 120, embeddingCharactersPerDay: 500000,
        maxConcurrentCalls: 2, timeZone: "Asia/Jerusalem" },
      maturation: { promotionScore: 95, retentionDays: 21, maxCandidates: 400, maxBytes: 1048576 } },
      pendingObservations: 12, retentionHours: 24 } };
  const configure = vi.fn(), openSettings = vi.fn();
  const settings = createLearningSettings({ root, actions: { snapshot: () => snapshot, configure }, openSettings });
  settings.render(snapshot);
  const field = (key: string) => root.querySelector(`[data-learning-setting="${key}"]`)!;
  const change = (key: string, value: string | boolean) => {
    const target = field(key);
    if (typeof value === "boolean") Object.assign(target, { checked: value }); else target.value = value;
    settings.handleChange({ target });
  };
  const save = () => settings.handleSubmit({ target: root.querySelector("[data-learning-settings]"), preventDefault: vi.fn() });
  return { root, settings, configure, openSettings, field, change, save,
    snapshot: () => snapshot, render: (next: any) => { snapshot = next; settings.render(next); } };
}

describe("Co-worker independent settings", () => {
  test.each([0, 1])("Save button %i uses the shared validation and save state", async (index) => {
    const f = fixture();
    const buttons = [...f.root.querySelectorAll("[data-learning-save]")];
    const form = f.root.querySelector("[data-learning-settings]")!;
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.attributes.get("type")).toBe("submit");
      expect(button.closest("[data-learning-settings]")).toBe(form);
      expect(button.disabled).toBe(true);
    }
    const submit = () => f.settings.handleSubmit({ target: form, submitter: buttons[index], preventDefault: vi.fn() });
    f.change("analysisIntervalMinutes", "0");
    submit();
    expect(f.configure).not.toHaveBeenCalled();
    expect(f.root.ownerDocument.activeElement).toBe(f.field("analysisIntervalMinutes"));
    f.change("analysisIntervalMinutes", "30");
    expect(buttons.every((button) => !button.disabled)).toBe(true);
    let finish!: (status: unknown) => void;
    f.configure.mockImplementation(() => {
      f.render({ ...f.snapshot(), saving: true });
      return new Promise((resolve) => { finish = resolve; });
    });
    submit();
    expect(f.configure).toHaveBeenCalledOnce();
    for (const button of buttons) expect(button).toMatchObject({ disabled: true, textContent: "Saving…" });
    submit();
    expect(f.configure).toHaveBeenCalledOnce();
    const status = { ...f.snapshot().status, preferences: { ...f.snapshot().status.preferences, ...f.configure.mock.calls[0]![0] } };
    f.render({ ...f.snapshot(), saving: false, status });
    finish(status); await Promise.resolve();
    for (const button of buttons) expect(button).toMatchObject({ disabled: true, textContent: "Save settings" });
  });

  test("saving a fresh activity permission never starts it", () => {
    const f = fixture();
    f.render({ ...f.snapshot(), environmentId: "fresh", status: { preferences: DEFAULT_LEARNING_PREFERENCES } });
    for (const field of ["collectionEnabled", "processingEnabled", "proactiveEnabled"])
      expect(f.field(field)).toMatchObject({ checked: false });
    f.change("modelProfileId", "local");
    f.change("processingEnabled", true);
    f.save();
    expect(f.configure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      activityPermissions: { collection: false, learning: true, proactive: false }, modelProfileId: "local",
    }));
    for (const key of ["enabled", "processingPaused", "proactiveEnabled"])
      expect(f.configure.mock.calls[0]![0]).not.toHaveProperty(key);
  });

  test.each(["collectionEnabled", "processingEnabled"])("requires an available model before allowing %s", (permission) => {
    const f = fixture();
    f.change("modelProfileId", "removed-model");
    f.change(permission, true); f.save();
    expect(f.configure).not.toHaveBeenCalled();
    expect(f.root.ownerDocument.activeElement).toBe(f.field("modelProfileId"));
    f.change("modelProfileId", "cloud"); f.save();
    expect(f.configure).toHaveBeenCalledOnce();
  });

  test("keeps saved approval after stopping and revokes it without writing active bits", () => {
    const f = fixture();
    const preferences = { ...f.snapshot().status.preferences,
      activityPermissions: { collection: true, learning: true, proactive: true } };
    f.render({ ...f.snapshot(), status: { preferences } });
    for (const key of ["collectionEnabled", "processingEnabled", "proactiveEnabled"])
      expect(f.field(key)).toMatchObject({ checked: true });
    f.change("processingEnabled", false); f.save();
    const patch = f.configure.mock.calls[0]![0];
    expect(patch.activityPermissions).toEqual({ collection: true, learning: false, proactive: true });
    for (const key of ["enabled", "processingPaused", "proactiveEnabled"])
      expect(patch).not.toHaveProperty(key);
  });

  test.each([
    ["observations", "analysisIntervalMinutes", "0", "5"],
    ["interval", "analysisObservationCount", "257", "100"],
  ])("resets an inactive draft only after a successful %s save", async (mode, field, edited, saved) => {
    const f = fixture();
    f.change(field!, edited!); f.change("analysisTrigger", mode!);
    f.configure.mockImplementation(async (preferences) => {
      const status = { ...f.snapshot().status, preferences: { ...f.snapshot().status.preferences, ...preferences } };
      f.render({ ...f.snapshot(), status });
      return status;
    });
    f.save();
    await vi.waitFor(() => expect(f.root.querySelector("[data-learning-save]")!.disabled).toBe(true));
    expect(f.field(field!).value).toBe(saved);
    expect(f.root.textContent).not.toContain("Unsaved changes");
  });

  test("keeps inactive drafts after a rejected save and after unrelated status refreshes", async () => {
    const f = fixture();
    f.change("analysisIntervalMinutes", "0"); f.change("analysisTrigger", "observations");
    f.configure.mockResolvedValue(undefined);
    f.save(); await Promise.resolve();
    f.render({ ...f.snapshot(), statusError: "Could not save settings" });
    expect(f.field("analysisIntervalMinutes").value).toBe("0");
    expect(f.root.textContent).toContain("Unsaved changes");
    expect(f.root.querySelector("[data-learning-save]")!.disabled).toBe(false);
  });

  test("does not apply a delayed save to drafts in a different environment", async () => {
    const f = fixture();
    let finish!: (status: unknown) => void;
    f.configure.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    f.change("analysisIntervalMinutes", "0"); f.change("analysisTrigger", "observations");
    f.save();
    const saved = { preferences: { ...f.snapshot().status.preferences, analysisTrigger: "observations" } };
    f.render({ ...f.snapshot(), environmentId: "prod" });
    f.change("analysisIntervalMinutes", "30");
    finish(saved); await Promise.resolve();
    expect(f.field("analysisIntervalMinutes").value).toBe("30");
  });

  test("selects count instead of time, keeps drafts across refresh and disables inactive validation", () => {
    const f = fixture();
    expect(f.field("analysisTrigger").value).toBe("interval");
    expect(f.field("analysisObservationCount").disabled).toBe(true);
    f.change("analysisIntervalMinutes", "0");
    f.change("analysisTrigger", "observations");
    f.change("analysisObservationCount", "120");
    f.render({ ...f.snapshot(), status: { ...f.snapshot().status, pendingObservations: 60 } });
    expect(f.field("analysisObservationCount").value).toBe("120");
    expect(f.field("analysisIntervalMinutes").disabled).toBe(true);
    expect(f.root.querySelector('[data-learning-trigger-for="interval"]')!.hidden).toBe(true);
    expect(f.root.querySelector('[data-learning-trigger-for="observations"]')!.hidden).toBe(false);
    f.save();
    expect(f.configure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ analysisTrigger: "observations", analysisObservationCount: 120 }));
    expect(f.configure.mock.calls[0]![0]).not.toHaveProperty("analysisIntervalMinutes");
    f.configure.mockClear(); f.change("analysisObservationCount", "257"); f.save();
    expect(f.configure).not.toHaveBeenCalled();
    f.change("analysisTrigger", "interval"); f.change("analysisIntervalMinutes", "30"); f.save();
    expect(f.configure.mock.calls[0]![0]).toMatchObject({ analysisTrigger: "interval", analysisIntervalMinutes: 30 });
    expect(f.configure.mock.calls[0]![0]).not.toHaveProperty("analysisObservationCount");
  });

  test("saves independent controls and complete nested settings without resetting legacy values", () => {
    const f = fixture();
    f.change("proactiveEnabled", true); f.save();
    expect(f.configure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ activityPermissions: { collection: false, learning: false, proactive: true },
      modelProfileId: "local", proactiveModelProfileId: "cloud", analysisIntervalMinutes: 5,
      resourceLimits: { modelCallsPerDay: 34, embeddingCallsPerDay: 120, embeddingCharactersPerDay: 500000,
        maxConcurrentCalls: 2, timeZone: "Asia/Jerusalem" },
      maturation: { promotionScore: 95, retentionDays: 21, maxCandidates: 400, maxBytes: 1048576 } }));
  });

  test.each([0, 42, 100])("saves promotion score %i without a hidden 90-point floor", (score) => {
    const f = fixture();
    expect(f.field("promotionScore").attributes.get("min")).toBe("0");
    f.change("promotionScore", String(score)); f.save();
    expect(f.configure).toHaveBeenCalledWith(expect.objectContaining({ maturation: expect.objectContaining({ promotionScore: score }) }));
  });

  test("retains dirty fields across live activity and unrelated settings updates", () => {
    const f = fixture(); f.change("analysisIntervalMinutes", "30");
    const prior = f.snapshot();
    f.render({ ...prior, status: { ...prior.status, pendingObservations: 20,
      preferences: { ...prior.status.preferences, proactiveEnabled: true, resourceLimits: { ...prior.status.preferences.resourceLimits, modelCallsPerDay: 50 } } } });
    expect(f.field("analysisIntervalMinutes").value).toBe("30");
    expect(f.field("modelCallsPerDay").value).toBe("50");
    expect(f.settings.draft()).toMatchObject({ analysisIntervalMinutes: 30, activityPermissions: { proactive: true } });
    f.save(); expect(f.configure.mock.calls[0]![0]).toMatchObject({ resourceLimits: { modelCallsPerDay: 50 } });
    const updated = f.snapshot();
    f.render({ ...updated, status: { ...updated.status, preferences: { ...updated.status.preferences, analysisIntervalMinutes: 30 } } });
    expect(f.root.querySelector("[data-learning-save]")!.disabled).toBe(true);
  });

  test("resets drafts and unavailable model choices on environment change", () => {
    const f = fixture(); f.change("promotionScore", "99"); f.change("modelProfileId", "removed-model");
    f.render({ ...f.snapshot(), models: [{ id: "cloud", label: "Cloud" }] });
    expect(f.field("modelProfileId").value).toBe("removed-model");
    expect(f.field("modelProfileId").textContent).toContain("removed-model · unavailable");
    f.render({ ...f.snapshot(), environmentId: "prod", status: { preferences: { enabled: false, processingPaused: true, modelProfileId: "cloud" } } });
    expect(f.field("modelProfileId").value).toBe("cloud"); expect(f.field("promotionScore").value).toBe("90");
    expect(f.root.querySelector("[data-learning-save]")!.disabled).toBe(true);
  });

  test("configures three separate windows and rejects an invalid time zone", () => {
    const f = fixture();
    for (const axis of ["collection", "processing", "proactive"]) {
      f.change(`${axis}Hours`, true); f.change(`${axis}TimeZone`, "UTC");
    }
    f.change("collectionStart", "22:00"); f.change("collectionEnd", "06:00");
    f.change("proactiveTimeZone", "invalid/zone"); f.save();
    expect(f.configure).not.toHaveBeenCalled(); expect(f.root.textContent).toContain("Enter a valid time zone");
    f.change("proactiveTimeZone", "Europe/London"); f.save();
    expect(f.configure.mock.calls[0]![0]).toMatchObject({ collectionWindow: { start: "22:00", end: "06:00", timeZone: "UTC" },
      analysisWindow: { start: "09:00", end: "17:00", timeZone: "UTC" },
      proactiveWindow: { start: "09:00", end: "17:00", timeZone: "Europe/London" } });
  });

  test("does not submit while another save is in flight and validates configured limits", () => {
    const f = fixture(); f.change("embeddingCallsPerDay", "0"); f.save(); expect(f.configure).not.toHaveBeenCalled();
    f.change("embeddingCallsPerDay", "200"); f.render({ ...f.snapshot(), saving: true }); f.save();
    expect(f.configure).not.toHaveBeenCalled(); expect(f.field("embeddingCallsPerDay").disabled).toBe(true);
    f.render({ ...f.snapshot(), saving: false }); f.change("candidateMiB", "0.5"); f.save();
    expect(f.configure.mock.calls[0]![0]).toMatchObject({ maturation: { maxBytes: 524288 }, resourceLimits: { embeddingCallsPerDay: 200 } });
  });

  test("saves budgets with all activities off without emitting empty model profiles", () => {
    const f = fixture();
    f.render({ ...f.snapshot(), environmentId: "fresh", status: { preferences: { enabled: false, processingPaused: true, proactiveEnabled: false } } });
    f.change("modelCallsPerDay", "30"); f.save();
    expect(f.configure).toHaveBeenCalledOnce();
    const saved = f.configure.mock.calls[0]![0];
    expect(saved).toMatchObject({ activityPermissions: { collection: false, learning: false, proactive: false }, resourceLimits: { modelCallsPerDay: 30 } });
    expect(saved).not.toHaveProperty("modelProfileId"); expect(saved.proactiveModelProfileId).toBeNull();
  });

  test("permits only proactive mode with its own profile when no learning model was selected", () => {
    const f = fixture();
    f.render({ ...f.snapshot(), environmentId: "fresh", status: { preferences: { enabled: false, processingPaused: true, proactiveEnabled: false } } });
    f.change("proactiveModelProfileId", "cloud"); f.change("proactiveEnabled", true); f.save();
    expect(f.configure).toHaveBeenCalledOnce();
    const saved = f.configure.mock.calls[0]![0];
    expect(saved).toMatchObject({ activityPermissions: { collection: false, learning: false, proactive: true }, proactiveModelProfileId: "cloud" });
    expect(saved).not.toHaveProperty("modelProfileId");
  });

  test("clears an explicit proactive profile and preserves inheritance after a model change", () => {
    const f = fixture(); f.change("proactiveModelProfileId", ""); f.change("modelProfileId", "cloud"); f.save();
    expect(f.configure.mock.calls[0]![0]).toMatchObject({ modelProfileId: "cloud", proactiveModelProfileId: null });
    const preferences = { ...f.snapshot().status.preferences, modelProfileId: "cloud", proactiveModelProfileId: undefined };
    f.render({ ...f.snapshot(), environmentId: "reloaded", status: { preferences } });
    expect(f.field("proactiveModelProfileId").value).toBe("");
    f.change("modelProfileId", "local"); f.save();
    expect(f.configure.mock.calls.at(-1)![0]).toMatchObject({ modelProfileId: "local", proactiveModelProfileId: null });
  });

});

test("usage shows reported counters and configured storage caps without fabricating byte or message totals", () => {
  const f = fixture();
  const snapshot = { ...f.snapshot(), status: { ...f.snapshot().status,
    resourceUsage: { modelCalls: 6, embeddingCalls: 3, embeddingCharacters: 150, activeCalls: 1,
      startedAt: 1, resetsAt: Date.parse("2026-09-26T00:00:00Z"), timeZone: "UTC" }, proactive: { proposals: [{ status: "delivered" }] } } };
  renderResourceUsage(f.root, snapshot);
  expect(f.root.querySelector('[data-learning-usage-value="model"]')!.textContent).toBe("6 / 34");
  expect(f.root.querySelector('[data-learning-usage-value="messages"]')!.textContent).toContain("Count unavailable");
  expect(f.root.querySelector('[data-learning-usage-value="candidates"]')!.textContent).toBe("1 / 400");
  expect(f.root.querySelector("[data-learning-usage-storage]")!.textContent).toBe("Up to 1 MiB");
  expect(f.root.querySelector("[data-learning-usage-reset]")!.textContent).toContain("UTC");
  renderResourceUsage(f.root, { ...snapshot, status: { ...snapshot.status, proactive: { deliveredToday: 1 } } });
  expect(f.root.querySelector('[data-learning-usage-value="messages"]')!.textContent).toBe("1 / 2");
});
