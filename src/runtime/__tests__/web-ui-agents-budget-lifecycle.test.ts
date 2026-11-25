import { previewAgentAuthoring } from "./support/agent-authoring-form-fixture.js";
import { agentBudgetPresets } from "../agents/authoring-budgets.js";
import { expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module.
import { chooseAgentBudget } from "../../web-ui/app/components/agents/agent-budgets.js";
// @ts-expect-error Browser-only module.
import { createAgentRecovery } from "../../web-ui/app/components/agents/recovery.js";
// @ts-expect-error Browser-only module.
import { createAgentSchedules } from "../../web-ui/app/components/agents/schedule-controller.js";
// @ts-expect-error Browser-only module.
import { createAgentDrafts } from "../../web-ui/app/components/agents/drafts.js";

const definition = { name: "Researcher", executionPolicy: "supervisor-worker-v1", onboarding: { role: "research" } };
const detail = { agent: { definition }, mission: { id: "task-a", revision: 3 }, recovery: { requiresNewBudget: true } };
const getScope = () => ({ environment: "dev", selected: "research" });
const legacyStandard = { maxAttempts: 6, maxModelCalls: 32, maxTotalTokens: 80_000, maxConsecutiveNoProgress: 2, maxClarificationRounds: 4 };
function standardLimits() {
  const form = { budget: "", limits: {} };
  chooseAgentBudget(form, "standard", agentBudgetPresets("research", "supervisor-worker-v1"));
  return form.limits;
}
function draftStore() {
  const values = new Map<string, string>();
  return createAgentDrafts({ getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) });
}
const scheduleFields = { id:"stable", title:"Research", text:"Check the sources", startAt:"2040-09-10T09:00", frequency:"once", maxOccurrences:1 };

test("schedule retry retains the concrete plan and ID, including a draft from before calibration", async () => {
  const drafts = draftStore();
  await drafts.write("dev","research:schedule", {onboarding:JSON.stringify({...scheduleFields, budget:"standard", limits:{}})});
  const client = { previewAgentAuthoring, listAgentSchedules: vi.fn(async () => ({schedules:[]})), createAgentSchedule: vi.fn(async () => ({})) };
  const schedules = createAgentSchedules({drafts, client, view:{schedules:vi.fn()}, getScope, viewport:{crypto:{randomUUID:() => "different"}}});
  await schedules.open(detail);
  await schedules.click({dataset:{scheduleAction:"new"}});
  client.createAgentSchedule.mockRejectedValueOnce(new Error("Missing receipt"));
  await schedules.save();
  schedules.close();
  await schedules.open(detail);
  await schedules.click({dataset:{scheduleAction:"new"}});
  await schedules.save();
  for (const call of client.createAgentSchedule.mock.calls) {
    expect(call).toEqual(["research",expect.objectContaining({id:"stable", limits:legacyStandard}),"dev"]);
  }
  expect(client.createAgentSchedule).toHaveBeenCalledTimes(2);
});

test("a new scheduled preset is calibrated from its Agent and can be precisely overridden", async () => {
  const drafts = draftStore();
  await drafts.write("dev","research:schedule", {onboarding:JSON.stringify({...scheduleFields, budget:"",limits:{}})});
  const client = { previewAgentAuthoring, listAgentSchedules: vi.fn(async () => ({schedules:[]})), createAgentSchedule: vi.fn(async () => ({})) };
  const schedules = createAgentSchedules({drafts, client, view:{schedules:vi.fn()}, getScope, viewport:{crypto:{randomUUID:() => "different"}}});
  await schedules.open(detail);
  await schedules.click({dataset:{scheduleAction:"new"}});
  await schedules.click({dataset:{scheduleBudget:"standard"}});
  expect(JSON.parse(drafts.read("dev","research:schedule").onboarding).limits).toEqual(standardLimits());
  await schedules.click({dataset:{scheduleBudget:"custom"}});
  await schedules.change({name:"limit:maxTotalTokens", value:"123456"});
  await schedules.save();
  expect(client.createAgentSchedule).toHaveBeenCalledWith("research",expect.objectContaining({
    limits:{...standardLimits(),maxTotalTokens:123456}, id:"stable"}),"dev");
});

test("saving a schedule edit without choosing a different budget preserves its stored values", async () => {
  const record = { ...scheduleFields, startAt:"2040-09-10T09:00:00.000Z", revision:3, status:"active", intervalMs:null, limits:legacyStandard, occurrences:[] };
  const client = { previewAgentAuthoring, listAgentSchedules: vi.fn(async () => ({schedules:[record]})), updateAgentSchedule: vi.fn(async () => ({})) };
  const schedules = createAgentSchedules({drafts:draftStore(), client, view:{schedules:vi.fn()}, getScope, viewport:{crypto:{randomUUID:() => "different"}}});
  await schedules.open(detail);
  await schedules.click({dataset:{scheduleEdit:"stable"}});
  await schedules.change({name:"schedule:title", value:"Edited title"});
  await schedules.save();
  expect(client.updateAgentSchedule).toHaveBeenCalledWith("research","stable",expect.objectContaining({
    expectedRevision:3,title:"Edited title",limits:legacyStandard}),"dev");
});

function recoveryHarness() {
  const drafts = draftStore();
  const panel = { hidden:false, innerHTML:"", focus:vi.fn() };
  const act = vi.fn(async () => true);
  const form = createAgentRecovery({ client: { previewAgentAuthoring }, getScope, drafts, act, view:{query:() => panel} });
  return { drafts, panel, act, form };
}

test("unknown recovery accepts the calibrated override on its original task revision only", async () => {
  const { form, act } = recoveryHarness();
  form.open(detail);
  await form.change({name:"recoveryText",value:"Continue with my decision."});
  await form.choose("standard");
  await form.choose("custom");
  await form.change({name:"limit:maxTotalTokens",value:"123456"});
  form.close(); form.open(detail);
  await form.submit();
  expect(act).toHaveBeenCalledExactlyOnceWith("resume","research",{ text:"Continue with my decision.", limits:{...standardLimits(),maxTotalTokens:123456} });

  form.open(detail);
  await form.choose("standard");
  await form.change({name:"recoveryText",value:"Previous decision."});
  form.close();
  for (const mission of [{id:"other",revision:3},{id:"task-a",revision:4}]) {
    form.open({...detail,mission});
    await form.change({name:"recoveryText",value:"New decision"});
    await form.submit();
    form.close();
  }
  expect(act).toHaveBeenCalledTimes(1);
});

test("a legacy recovery draft can restore text; a blank Custom field cannot authorize new spending", async () => {
  const { drafts, form, panel, act } = recoveryHarness();
  await drafts.write("dev","research:resume",{text:"Previous written decision",onboarding:JSON.stringify({budget:"short",limits:legacyStandard})});
  form.open(detail);
  expect(panel.innerHTML).toContain("Previous written decision");
  await form.submit(); expect(act).not.toHaveBeenCalled();
  await form.choose("standard");
  await form.choose("custom");
  await form.change({name:"limit:maxClarificationRounds",value:""});
  await form.submit(); expect(act).not.toHaveBeenCalled();
  await form.change({name:"limit:maxClarificationRounds",value:"0"});
  await form.submit(); expect(act).toHaveBeenCalledExactlyOnceWith("resume","research",{text:"Previous written decision",limits:{...standardLimits(),maxClarificationRounds:0}});
});

function deferredBudgetPreview() {
  type Page = Awaited<ReturnType<typeof previewAgentAuthoring>>;
  let resolve!: (page: Page) => void;
  let reject!: (reason: Error) => void;
  const request = new Promise<Page>((pass, fail) => { resolve = pass; reject = fail; });
  return { request, resolve, reject };
}

test("a schedule submit waits for the chosen allowance and preserves the exact cadence on a title-only edit", async () => {
  const initial = { ...scheduleFields, startAt: "2040-01-01T11:25:10.500Z", nextRunAt: "2040-01-02T11:25:10.500Z",
    revision: 5, status: "active", intervalMs: 7_200_000, maxOccurrences: 8, limits: standardLimits(), occurrences: [{}] };
  const deferred = deferredBudgetPreview();
  const client = { listAgentSchedules: async () => ({ schedules: [initial] }), updateAgentSchedule: vi.fn(),
    previewAgentAuthoring: vi.fn(() => deferred.request) };
  const view = { schedules: vi.fn() };
  const schedules = createAgentSchedules({ drafts: draftStore(), client, view, getScope, viewport: {crypto:{randomUUID:() => "unused"}} });
  await schedules.open(detail); await schedules.click({ dataset: { scheduleEdit: initial.id } });
  expect(view.schedules.mock.lastCall?.[0]).toContain('data-schedule-frequency="existing" aria-pressed="true">Every 2 hours');
  await schedules.change({ name: "schedule:title", value: "New title" });
  const choose = schedules.click({ dataset: { scheduleBudget: "short" } });
  const save = schedules.save();
  expect(client.updateAgentSchedule).not.toHaveBeenCalled();
  const page = await previewAgentAuthoring({ authoring: {}, targetAgentId: "research" });
  deferred.resolve(page); await Promise.all([choose, save]);
  expect(client.updateAgentSchedule).toHaveBeenCalledExactlyOnceWith("research", initial.id, expect.objectContaining({
    title: "New title", limits: page.preview.presets.short, intervalMs: 7_200_000, maxOccurrences: 8,
    startAt: initial.nextRunAt, expectedRevision: 5,
  }), "dev");
});

test("a failed or superseded recovery preview cannot authorize old limits or overwrite the durable choice", async () => {
  const drafts = draftStore();
  const original = { text: "Resume", onboarding: JSON.stringify({ missionId: "task-a", missionRevision: 3, budget: "standard",
    limits: standardLimits(), budgetPresetVersion: 2 }) };
  await drafts.write("dev", "research:resume", original);
  const one = deferredBudgetPreview(), two = deferredBudgetPreview();
  const client = { previewAgentAuthoring: vi.fn().mockReturnValueOnce(one.request).mockReturnValueOnce(two.request).mockImplementation(previewAgentAuthoring) };
  const panel = { hidden: false, innerHTML: "", focus() {} };
  const act = vi.fn(async () => true);
  const form = createAgentRecovery({ getScope, drafts, act, client, view:{query:() => panel} });
  form.open(detail);
  const first = form.choose("deep"), oldSubmit = form.submit();
  const current = form.choose("short"), currentSubmit = form.submit();
  two.reject(new Error("Owner unavailable")); await Promise.all([current, currentSubmit]);
  expect(panel.innerHTML).toContain("Owner unavailable");
  const page = await previewAgentAuthoring({ authoring: {}, targetAgentId: "research" });
  one.resolve(page); await Promise.all([first, oldSubmit]);
  await form.submit();
  expect(act).not.toHaveBeenCalled();
  expect(drafts.read("dev", "research:resume")).toMatchObject(original);
  const retry = form.choose("short"), send = form.submit();
  await Promise.all([retry, send]);
  expect(act).toHaveBeenCalledExactlyOnceWith("resume", "research", {text:"Resume", limits:page.preview.presets.short});
});
