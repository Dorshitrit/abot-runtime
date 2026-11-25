import { afterEach, expect, test } from "vitest";
import { createReasoningSummaryUiHarness, type ReasoningSummaryUiHarness } from "./support/config-reasoning-summary-ui-harness.js";

const fixtures: ReasoningSummaryUiHarness[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

async function harness(seed: Record<string, unknown> = {}) {
  const fixture = await createReasoningSummaryUiHarness(seed);
  fixtures.push(fixture);
  return fixture;
}

function summarySelect(markup: string): string {
  const select = markup.match(/<select\b[^>]*data-value-type="reasoning-summary"[^>]*>[\s\S]*?<\/select>/u)?.[0];
  expect(select).toBeDefined();
  return select!;
}

test.each([undefined, null, "auto", "concise", "detailed"])(
  "hydrates saved %s through the root model editor without writes or calibration duplicates",
  async (value) => {
    const options = { preservedOption: "keep", ...(value === undefined ? {} : { reasoningSummary: value }) };
    const h = await harness({ options });
    const markup = h.render();
    const select = summarySelect(markup);
    expect(markup.match(/data-value-type="reasoning-summary"/gu)).toHaveLength(1);
    expect(markup).toContain("config-calibration-card");
    expect(select).toContain('data-path="[&quot;options&quot;,&quot;reasoningSummary&quot;]"');
    expect(select).toContain(`<option value="${value ?? ""}" selected>`);
    expect((await h.readSaved()).options).toEqual(options);
    expect(h.model.hasUnsavedChanges()).toBe(false);
    expect(h.saveFile).not.toHaveBeenCalled();
  },
);

test.each(["auto", "concise", "detailed", ""])(
  "selecting %s saves once, reloads its canonical value, and resets to that baseline",
  async (selected) => {
    const h = await harness();
    const beforeRevision = h.file().revision;
    h.select(selected);
    const expected = selected || null;
    expect(h.file().config.options).toEqual({ preservedOption: "keep", reasoningSummary: expected });
    expect((await h.readSaved()).options).toEqual({ preservedOption: "keep" });
    expect(h.model.hasUnsavedChanges()).toBe(true);
    expect(h.saveFile).not.toHaveBeenCalled();
    await h.save();
    expect(h.saveFile).toHaveBeenCalledTimes(1);
    expect(h.saveFile.mock.calls[0]?.[0]).toMatchObject({ expectedRevision: beforeRevision });
    expect((await h.readSaved()).options).toEqual({ preservedOption: "keep", reasoningSummary: expected });
    expect(h.model.hasUnsavedChanges()).toBe(false);
    expect(await h.reload()).toBe(true);
    expect(summarySelect(h.render())).toContain(`<option value="${selected}" selected>`);
    h.select(selected === "detailed" ? "auto" : "detailed");
    h.reset();
    expect(h.file().config.options.reasoningSummary).toBe(expected);
    expect(h.model.hasUnsavedChanges()).toBe(false);
    expect(h.saveFile).toHaveBeenCalledTimes(1);
  },
);

test("a burst of draft edits performs no save until the final explicit Save", async () => {
  const h = await harness();
  const savedBefore = await h.readSaved();
  const choices = ["auto", "concise", "detailed", ""];
  h.renderConfigDashboard.mockClear();
  h.syncDirtyPresentation.mockClear();
  for (let index = 0; index < 128; index += 1) h.select(choices[index % choices.length]!);
  expect(h.syncDirtyPresentation).toHaveBeenCalledTimes(128);
  expect(h.renderConfigDashboard).not.toHaveBeenCalled();
  expect(h.saveFile).not.toHaveBeenCalled();
  expect(await h.readSaved()).toEqual(savedBefore);
  expect(h.file().config.options.reasoningSummary).toBeNull();
  await h.save();
  expect(h.saveFile).toHaveBeenCalledTimes(1);
  expect((await h.readSaved()).options).toEqual({ preservedOption: "keep", reasoningSummary: null });
});

test("the provider's exact type owns visibility and switching preserves dormant summary options", async () => {
  const h = await harness({ options: { preservedOption: "keep", reasoningSummary: "concise" } });
  expect(summarySelect(h.render())).toContain('value="concise" selected');
  for (const provider of ["signedIn", "localNative", "openai", "missing-provider"]) {
    h.field(["provider"], provider);
    expect(h.render()).not.toContain('data-value-type="reasoning-summary"');
    expect(h.file().config.options).toEqual({ preservedOption: "keep", reasoningSummary: "concise" });
  }
  h.field(["provider"], "signedIn");
  await h.save();
  expect(await h.reload()).toBe(true);
  expect(h.render()).not.toContain('data-value-type="reasoning-summary"');
  expect((await h.readSaved()).options.reasoningSummary).toBe("concise");
  h.field(["provider"], "cloudApi");
  expect(summarySelect(h.render())).toContain('value="concise" selected');
  expect(h.file().config.options.preservedOption).toBe("keep");
});

test("thinking support and effective Off do not hide or clear the saved summary preference", async () => {
  const h = await harness({ supportsThinking: false,
    options: { preservedOption: "keep", reasoningSummary: "detailed" } });
  expect(summarySelect(h.render())).toContain('value="detailed" selected');
  h.field(["generation", "reasoningEffort"], "none");
  await h.save();
  await h.reload();
  expect(h.file().config.generation.reasoningEffort).toBe("none");
  expect(h.file().config.supportsThinking).toBe(false);
  expect(h.file().config.options.reasoningSummary).toBe("detailed");
  expect(summarySelect(h.render())).toContain('value="detailed" selected');
});

test.each(["", false, { invalid: true }, "unsupported-legacy"])("unsupported saved %j remains visible until the user selects a replacement", async (unsupported) => {
  const h = await harness({ options: { preservedOption: "keep", reasoningSummary: unsupported } });
  const select = summarySelect(h.render());
  expect(select).toContain('<option value="unsupported" selected disabled>Unsupported saved value</option>');
  expect(select).not.toContain('<option value="" selected>');
  expect(h.file().config.options.reasoningSummary).toEqual(unsupported);
  expect(h.model.hasUnsavedChanges()).toBe(false);
  h.select("auto");
  h.reset();
  expect(h.file().config.options.reasoningSummary).toEqual(unsupported);
  expect(h.saveFile).not.toHaveBeenCalled();
  h.select("");
  await h.save();
  expect((await h.readSaved()).options).toEqual({ preservedOption: "keep", reasoningSummary: null });
});
