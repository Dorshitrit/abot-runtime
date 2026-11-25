import { previewAgentAuthoring, formDefinition } from "./support/agent-authoring-form-fixture.js";
import { agentBudgetPresets } from "../agents/authoring-budgets.js";
import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module.
import { createAgentWizard } from "../../web-ui/app/components/agents/wizard-controller.js";
// @ts-expect-error Browser-only module.
import { createAgentDrafts } from "../../web-ui/app/components/agents/drafts.js";
// @ts-expect-error Browser-only module.
import { createAgentSchedules, validateAgentScheduleForm } from "../../web-ui/app/components/agents/schedule-controller.js";
// @ts-expect-error Browser-only module.
import { emptyAgentDraft, agentDraftLimits } from "../../web-ui/app/components/agents/onboarding-options.js";
// @ts-expect-error Browser-only module.
import { renderAgentOnboarding } from "../../web-ui/app/components/agents/onboarding.js";
// @ts-expect-error Browser-only module.
import { chooseAgentBudget } from "../../web-ui/app/components/agents/agent-budgets.js";

function draft() {
  const form = { ...emptyAgentDraft(), role: "research", outputs: ["recommendations"], name: "Scout", modelProfileId: "local" };
  chooseAgentBudget(form, "short", agentBudgetPresets("research", "execution-agent-v1"));
  return form;
}
function storage() { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key), setItem: vi.fn(async (key: string, value: string) => { values.set(key, value); }) }; }

const budgetModels = [
  { id: "profile-a", executionPolicy: "execution-agent-v1" },
  { id: "profile-b", executionPolicy: "supervisor-worker-v1" },
  { id: "legacy-profile" },
  { id: "legacy-super" },
];

function budgetWizard(preview = previewAgentAuthoring) {
  const drafts = createAgentDrafts(storage());
  const client = { previewAgentAuthoring: preview,
    createAgent: vi.fn(async () => ({ id: "scout" })),
    updateAgent: vi.fn(async () => ({ id: "scout" })),
  };
  let markup = "";
  const onSaved = vi.fn();
  const wizard = createAgentWizard({
    client, drafts, view: { query: () => null, wizard: (state: unknown) => { markup = state ? renderAgentOnboarding(state) : ""; } },
    getScope: () => ({ environment: "dev" }), getModels: () => budgetModels, getRevision: () => 5, onSaved,
  });
  async function start(role = "research") {
    wizard.open();
    await wizard.choose("role", role); await wizard.submit();
    await wizard.choose("outputs", "comparisons"); await wizard.submit();
    await wizard.submit();
  }
  return { wizard, client, drafts, start, onSaved, markup: () => markup };
}

describe("Agent task budget in the configuration wizard", () => {
  test.each([
    ["research", "profile-a", "short", 300_000, 24],
    ["coding", "profile-b", "standard", 800_000, 128],
    ["research", "profile-b", "deep", 1_600_000, 256],
    ["everyday", "profile-b", "short", 120_000, 48],
    ["writing", "profile-a", "standard", 300_000, 64],
    ["planning", "profile-a", "deep", 900_000, 128],
    ["coding", "legacy-profile", "standard", 800_000, 64],
  ] as const)("%s, %s, %s displays and submits the same per-mission limits", async (role, profile, budget, tokens, calls) => {
    const h = budgetWizard();
    await h.start(role);
    await h.wizard.choose("modelProfileId", profile);
    await h.wizard.choose("budget", budget);
    expect(h.markup()).toContain(tokens.toLocaleString("en-US"));
    expect(h.markup()).toContain(`${calls} model calls`);
    if (profile === "legacy-profile") expect(h.markup()).not.toMatch(/\b(?:SUPER|EA)\b/);
    await h.wizard.submit();
    expect(h.client.createAgent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      authoring: expect.objectContaining({ modelProfileId: profile, onboarding: expect.objectContaining({ budget }) }),
    }), "dev");
  });

  test("a delayed preview from the previous model cannot replace the current allowance", async () => {
    let finish!: () => void;
    const hold = new Promise<void>(resolve => { finish = resolve; });
    const h = budgetWizard(async input => {
      if (input.authoring.modelProfileId === "profile-a") await hold;
      return previewAgentAuthoring(input);
    });
    await h.start();
    const old = h.wizard.choose("modelProfileId", "profile-a");
    await h.wizard.choose("modelProfileId", "profile-b");
    await h.wizard.choose("budget", "short");
    finish(); await old;
    expect(h.markup()).toContain("48 model calls");
    expect(h.markup()).toMatch(/data-value="profile-b" aria-pressed="true"/);
  });

  test("a committed creation receipt selects its durable agent ID once when a detail refetch is required", async () => {
    const h = budgetWizard();
    h.client.createAgent.mockResolvedValueOnce({ targetAgentId: "created", needsRefetch: true } as unknown as { id: string });
    await h.start(); await h.wizard.choose("modelProfileId", "profile-a"); await h.wizard.choose("budget", "short");
    await h.wizard.submit(); await h.wizard.submit();
    expect(h.client.createAgent).toHaveBeenCalledTimes(1);
    expect(h.onSaved).toHaveBeenCalledExactlyOnceWith("created");
    expect(h.drafts.read("dev", "$new").onboarding).toBeUndefined();
  });

  test("editing identity and budget on a long manually authored agent preserves its raw prompt and icon", async () => {
    const saved = { name: "Manual", icon: "original-custom-icon", basePrompt: "  Original instructions.\n".repeat(220),
      modelProfileId: "profile-b", toolPermissionMode: "ask" };
    const limits = agentBudgetPresets("custom", "supervisor-worker-v1").standard;
    const h = budgetWizard();
    await h.wizard.open({ agent: { id: "manual", definition: saved }, limits });
    await h.wizard.change({ name: "name", value: "Renamed" });
    await h.wizard.choose("budget", "short");
    await h.wizard.submit();
    expect(h.client.updateAgent).toHaveBeenCalledExactlyOnceWith("manual", {
      definition: { ...saved, name: "Renamed" }, expectedRevision: 5, limits: agentBudgetPresets("custom", "supervisor-worker-v1").short,
    }, "dev");
  });

  test("switching models updates a named preset, and Custom preserves edited limits through reload and a model change", async () => {
    const h = budgetWizard();
    await h.start();
    await h.wizard.choose("modelProfileId", "profile-a");
    await h.wizard.choose("budget", "deep");
    expect(h.markup()).toContain("128 model calls");
    await h.wizard.choose("modelProfileId", "profile-b");
    expect(h.markup()).toContain("256 model calls");
    await h.wizard.choose("budget", "custom");
    expect(h.markup()).toMatch(/name="limit:maxTotalTokens"[^>]*value="1600000"/);
    await h.wizard.change({ name: "limit:maxTotalTokens", value: "700001" });
    await h.wizard.change({ name: "limit:maxClarificationRounds", value: "0" });
    h.wizard.close();
    h.wizard.open();
    await h.wizard.choose("role", "writing");
    await h.wizard.submit(); await h.wizard.submit(); await h.wizard.submit();
    await h.wizard.choose("modelProfileId", "profile-a");
    expect(h.markup()).toMatch(/name="limit:maxTotalTokens"[^>]*value="700001"/);
    await h.wizard.submit();
    expect(h.client.createAgent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      authoring: expect.objectContaining({ limits: { maxAttempts: 12, maxTotalTokens: 700_001, maxModelCalls: 256, maxClarificationRounds: 0, maxConsecutiveNoProgress: 3 }, onboarding: expect.objectContaining({ budget: "custom" }) }),
    }), "dev");
  });

  test("Custom can be selected first and starts with a complete editable Standard allowance", async () => {
    const h = budgetWizard();
    await h.start("everyday");
    await h.wizard.choose("modelProfileId", "profile-b");
    await h.wizard.choose("budget", "custom");
    expect(h.markup()).toMatch(/name="limit:maxModelCalls"[^>]*value="128"/);
    await h.wizard.change({ name: "limit:maxClarificationRounds", value: "" });
    await h.wizard.submit();
    expect(h.client.createAgent).not.toHaveBeenCalled();
    await h.wizard.change({ name: "limit:maxClarificationRounds", value: "1" });
    await h.wizard.submit();
    expect(h.client.createAgent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      authoring: expect.objectContaining({ limits: { maxAttempts: 6, maxTotalTokens: 300_000, maxModelCalls: 128, maxClarificationRounds: 1, maxConsecutiveNoProgress: 2 } }),
    }), "dev");
  });

  test("editing an old Standard agent keeps its exact saved limits until a new preset is selected", async () => {
    const h = budgetWizard();
    const legacy = { maxAttempts: 6, maxModelCalls: 32, maxTotalTokens: 80_000, maxConsecutiveNoProgress: 2, maxClarificationRounds: 4 };
    const form = draft();
    const definition = { ...formDefinition(form), modelProfileId: "profile-b", executionPolicy: "supervisor-worker-v1", onboarding: { role: "research", outputs: ["comparisons"], budget: "standard" } };
    const detail = { agent: { id: "scout", definition }, limits: legacy };
    await h.wizard.open(detail);
    expect(h.markup()).toMatch(/data-agent-choice="budget" data-value="custom" aria-pressed="true"/);
    await h.wizard.change({ name: "name", value: "Renamed" });
    await h.wizard.submit();
    expect(h.client.updateAgent).toHaveBeenCalledWith("scout", expect.objectContaining({ authoring: expect.objectContaining({ limits: legacy }) }), "dev");
    await h.wizard.open(detail);
    await h.wizard.choose("budget", "standard"); await h.wizard.submit();
    expect(h.client.updateAgent).toHaveBeenLastCalledWith("scout", expect.objectContaining({
      authoring: expect.objectContaining({ onboarding: expect.objectContaining({ budget: "standard" }) }),
    }), "dev");
  });

  test("editing a saved Custom allowance keeps its override even when its values also match a preset", async () => {
    const h = budgetWizard();
    const limits = { maxAttempts: 6, maxModelCalls: 128, maxTotalTokens: 800_000, maxConsecutiveNoProgress: 2, maxClarificationRounds: 4 };
    const definition = {
      ...formDefinition(draft()), modelProfileId: "legacy-super", executionPolicy: "supervisor-worker-v1",
      defaultLimits: limits, onboarding: { role: "research", outputs: ["comparisons"], budget: "custom" },
    };
    await h.wizard.open({ agent: { id: "scout", definition } });
    expect(h.markup()).toMatch(/data-agent-choice="budget" data-value="custom" aria-pressed="true"/);
    await h.wizard.choose("modelProfileId", "profile-a");
    expect(h.markup()).toMatch(/name="limit:maxModelCalls"[^>]*value="128"/);
    await h.wizard.submit();
    expect(h.client.updateAgent).toHaveBeenCalledExactlyOnceWith("scout", expect.objectContaining({
      authoring: expect.objectContaining({ limits, onboarding: expect.objectContaining({ budget: "custom" }) }),
    }), "dev");

    await h.wizard.open({ agent: { id: "scout", definition } });
    await h.wizard.choose("budget", "standard");
    expect(h.markup()).toContain("128 model calls");
    expect(h.markup()).toContain("SUPER");
  });

  test("reopening a legacy unfinished wizard preserves the concrete allowance behind its saved chip", async () => {
    const h = budgetWizard();
    await h.drafts.write("dev", "$new", { onboarding: JSON.stringify({
      name: "Legacy agent", role: "coding", outputs: ["code"], modelProfileId: "profile-b", budget: "standard", limits: {},
    }) });
    h.wizard.open();
    await h.wizard.submit(); await h.wizard.submit(); await h.wizard.submit();
    expect(h.markup()).toMatch(/name="limit:maxTotalTokens"[^>]*value="80000"/);
    await h.wizard.submit();
    expect(h.client.createAgent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      authoring: expect.objectContaining({ limits: { maxAttempts: 6, maxModelCalls: 32, maxTotalTokens: 80_000, maxConsecutiveNoProgress: 2, maxClarificationRounds: 4 } }),
    }), "dev");
  });
});

describe("Agent configuration and scheduled work", () => {
  test("editing onboarding never overwrites a saved or uncertain chat submission", async () => {
    const saved = storage(), drafts = createAgentDrafts(saved), form = draft();
    await drafts.write("dev", "a", { text: "Pending task", pendingId: "pending-1", intent: "task" });
    const client = { previewAgentAuthoring, updateAgent: vi.fn(async () => ({ agent: { id: "a" } })) };
    const wizard = createAgentWizard({ client, drafts, view: { wizard: vi.fn(), query: () => ({ focus: vi.fn() }) }, getScope: () => ({ environment: "dev" }), getModels: () => [{ id: "local" }], getRevision: () => 4, onSaved: vi.fn() });
    wizard.open({ agent: { id: "a", definition: { ...formDefinition(form), onboarding: form } }, limits: agentDraftLimits(form) });
    await wizard.change({ name: "name", value: "Scout Two" });
    expect(drafts.read("dev", "a")).toMatchObject({ text: "Pending task", pendingId: "pending-1", intent: "task" });
    expect(drafts.read("dev", "a:onboarding").onboarding).toContain("Scout Two");
    await wizard.submit();
    expect(client.updateAgent).toHaveBeenCalledTimes(1);
    expect(drafts.read("dev", "a").pendingId).toBe("pending-1");
    expect(drafts.read("dev", "a:onboarding").onboarding).toBeUndefined();
  });
  test("provider groups distinguish duplicate models on create and retain the exact saved profile on edit", async () => {
    const models = [
      { id: "local-ea", label: "Qwen", provider: "llamacpp", providerId: "studio" },
      { id: "cloud", label: "Qwen", provider: "openai", providerId: "api" },
      { id: "local-super", label: "Qwen", provider: "llamacpp", providerId: "studio" },
      { id: "remote", label: "Qwen", provider: "llamacpp", providerId: "server" },
      { id: "old", name: "Older catalog name" },
    ];
    const form = draft();
    const client = { previewAgentAuthoring,
      createAgent: vi.fn(async () => ({ id: "scout" })),
      updateAgent: vi.fn(async () => ({ id: "scout" })),
    };
    let markup = "";
    const view = { query: () => null, wizard: (state: unknown) => { markup = state ? renderAgentOnboarding(state) : ""; } };
    const wizard = createAgentWizard({
      client, view, drafts: createAgentDrafts(storage()), getModels: () => models,
      getScope: () => ({ environment: "dev" }), getRevision: () => 5, onSaved: vi.fn(),
    });
    wizard.open();
    await wizard.choose("role", form.role); await wizard.submit();
    await wizard.choose("outputs", form.outputs[0]); await wizard.submit();
    await wizard.submit();

    const groups = Array.from(markup.matchAll(/<fieldset[^>]*><legend>([^<]*)<\/legend>(.*?)<\/fieldset>/gs), (match) => ({
      provider: match[1], options: Array.from(match[2]!.matchAll(/data-value="([^"]*)" aria-pressed="(true|false)">([^<]*)<\/button>/g), (option) => [option[1], option[3]]),
    }));
    expect(groups).toEqual([
      { provider: "llama.cpp · studio", options: [["local-ea", "Qwen · local-ea"], ["local-super", "Qwen · local-super"]] },
      { provider: "OpenAI", options: [["cloud", "Qwen"]] },
      { provider: "llama.cpp · server", options: [["remote", "Qwen"]] },
      { provider: "Other models", options: [["old", "Older catalog name"]] },
    ]);
    expect(markup).not.toMatch(/data-agent-choice="modelProfileId"[^>]*aria-pressed="true"/);
    await wizard.choose("modelProfileId", "local-super"); await wizard.choose("budget", form.budget); await wizard.submit();
    expect(client.createAgent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ authoring: expect.objectContaining({ modelProfileId: "local-super" }) }), "dev");

    const definition = { ...formDefinition(form), modelProfileId: "local-super" };
    const detail = { agent: { id: "scout", definition }, limits: agentDraftLimits(form) };
    wizard.open(detail);
    expect(markup).toContain('data-value="local-super" aria-pressed="true">Qwen · local-super');
    await wizard.submit();
    expect(client.updateAgent).toHaveBeenLastCalledWith("scout", expect.objectContaining({ authoring: expect.objectContaining({ name: definition.name, modelProfileId: definition.modelProfileId }) }), "dev");
    wizard.open(detail);
    await wizard.choose("modelProfileId", "cloud"); await wizard.submit();
    expect(client.updateAgent).toHaveBeenLastCalledWith("scout", expect.objectContaining({ authoring: expect.objectContaining({ name: definition.name, modelProfileId: "cloud" }) }), "dev");
  });
  test("scheduled work requires future timing, a finite count, and explicit full limits", () => {
    const form = { title: "Watch prices", text: "Find current monitor deals", startAt: "2030-01-02T10:00", frequency: "daily", maxOccurrences: 4, budget: "short", limits: {} };
    chooseAgentBudget(form, "short", agentBudgetPresets());
    const now = Date.parse("2030-01-01T00:00Z");
    expect(validateAgentScheduleForm(form, now)).toBe("");
    expect(validateAgentScheduleForm({ ...form, budget: "" }, now)).toMatch(/budget/);
    expect(validateAgentScheduleForm({ ...form, startAt: "2020-01-01" }, now)).toMatch(/future/);
    expect(validateAgentScheduleForm({ ...form, maxOccurrences: Infinity }, now)).toMatch(/occurrences/);
    expect(validateAgentScheduleForm({ ...form, budget: "custom", limits: {} }, now)).toMatch(/five/);
  });
  test("uncertain schedule creation retains its draft and stable id before explicit retry", async () => {
    const saved = storage(), drafts = createAgentDrafts(saved), create = vi.fn(async (_agent: string, _input: any, _environment: string): Promise<any> => ({}));
    create.mockRejectedValueOnce(new Error("Connection lost"));
    const controller = createAgentSchedules({ client: { previewAgentAuthoring, listAgentSchedules: vi.fn(async () => ({ schedules: [] })), createAgentSchedule: create }, drafts, view: { schedules: vi.fn() }, getScope: () => ({ environment: "dev", selected: "a" }), viewport: { crypto: { randomUUID: () => "schedule-id" } } });
    await controller.open({ agent: { definition: { name: "Scout" } } });
    await controller.click({ dataset: { scheduleAction: "new" } });
    for (const [name, value] of Object.entries({ title: "Watch prices", text: "Compare monitors", startAt: "2035-01-01T10:00" })) await controller.change({ name: `schedule:${name}`, value });
    await controller.click({ dataset: { scheduleBudget: "short" } });
    await controller.save();
    expect(drafts.read("dev", "a:schedule").onboarding).toContain("schedule-id");
    await controller.save();
    expect(create.mock.calls.map((call) => call[1].id)).toEqual(["schedule-id", "schedule-id"]);
    expect(create.mock.calls[0]?.[1]).toMatchObject({ intervalMs: null, maxOccurrences: 1, limits: { maxAttempts: 3, maxModelCalls: 24, maxTotalTokens: 120_000, maxConsecutiveNoProgress: 2, maxClarificationRounds: 2 } });
    expect(create.mock.calls[0]?.[1]).not.toHaveProperty("agentId");
    expect(drafts.read("dev", "a:schedule").onboarding).toBeUndefined();
  });
});
