import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { AgentStateCommitUnknownError, FileAgentStateStore } from "../agents/file-store.js";
import type { AgentDefinitionInput } from "../agents/management-contracts.js";
import { createAgentManagementService } from "../agents/management-service.js";
import type { AgentModelConfiguration } from "../agents/model-binding.js";
import { agentDefinition, startAgentMission } from "./support/agents-foundation-fixture.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

function modelConfig(): AgentModelConfiguration {
  return {
    models: {
      profiles: { "fixture-super": { model: "fictional-super" }, "fixture-ea": { model: "fictional-ea" } },
      invocationProfiles: { precise: { profileId: "fixture-ea", generation: { temperature: 0.2 } } },
      defaults: { profileId: "fixture-super" },
    },
    modelExecutionPolicies: { "fixture-ea": { policy: "execution-agent-v1" } },
  };
}

function definition(modelProfileId = "fixture-super"): AgentDefinitionInput {
  const { executionPolicy: _, ...input } = agentDefinition();
  return { ...input, modelProfileId };
}

async function fixture(config = modelConfig()) {
  const directory = await mkdtemp(join(tmpdir(), "abot-agent-management-"));
  directories.push(directory);
  const filename = join(directory, "agents", "state.json");
  const store = new FileAgentStateStore(filename);
  const service = createAgentManagementService(store, config);
  return { filename, store, service, config };
}

test.each([
  ["fixture-super", "fixture-super", "supervisor-worker-v1"],
  ["fixture-ea", "fixture-ea", "execution-agent-v1"],
  ["precise", "fixture-ea", "execution-agent-v1"],
])("persists explicit %s identity with canonical policy and reloads it", async (selected, base, policy) => {
  const f = await fixture();
  const catalog = await f.service.register(definition(` ${selected} `), 0);
  expect(catalog.revision).toBe(1);
  expect(catalog.agents[0]).toMatchObject({
    definition: { modelProfileId: selected, executionPolicy: policy, toolPermissionMode: "ask" },
    modelBinding: { status: "configured", baseProfileId: base, executionPolicy: policy },
  });
  const reloaded = createAgentManagementService(new FileAgentStateStore(f.filename), f.config);
  expect(await reloaded.read()).toEqual(catalog);
  (catalog.agents[0].definition as { name: string }).name = "caller mutation";
  expect((await f.service.read()).agents[0].definition.name).toBe("Research");
});

test("rejects an unknown explicit model instead of inheriting the default", async () => {
  const f = await fixture();
  await expect(f.service.register(definition("missing"), 0)).rejects.toMatchObject({ code: "agents_model_profile_missing" });
  expect(await f.service.read()).toEqual({ revision: 0, agents: [] });
});

test("rejects caller-supplied execution policy and unsupported permissions", async () => {
  const f = await fixture();
  await expect(f.service.register({ ...definition(), executionPolicy: "execution-agent-v1" } as AgentDefinitionInput, 0))
    .rejects.toMatchObject({ code: "agents_record_invalid" });
  await expect(f.service.register({ ...definition(), toolPermissionMode: "root" } as unknown as AgentDefinitionInput, 0))
    .rejects.toMatchObject({ code: "agents_record_invalid" });
  expect((await f.service.read()).revision).toBe(0);
});

test.each(["fixture-super", "fixture-ea"])("rejects override to %s, including losing an alias on the same base", async (defaultId) => {
  const config = modelConfig();
  config.models!.defaults = { profileId: defaultId, overrideClientPreference: true };
  const f = await fixture(config);
  await expect(f.service.register(definition("precise"), 0)).rejects.toMatchObject({ code: "agents_model_profile_overridden" });
  expect((await f.service.read()).revision).toBe(0);
});

test("accepts an override selecting the same invocation alias", async () => {
  const config = modelConfig();
  config.models!.defaults = { profileId: "precise", overrideClientPreference: true };
  const f = await fixture(config);
  expect((await f.service.register(definition("precise"), 0)).agents[0].definition.modelProfileId).toBe("precise");
});

test.each(["profile_missing", "profile_overridden", "execution_policy_changed"] as const)(
  "shows %s after configuration change without rewriting saved intent", async (reason) => {
    const f = await fixture();
    const saved = await f.service.register(definition("fixture-ea"), 0);
    const bytes = await readFile(f.filename, "utf8");
    const config = modelConfig();
    if (reason === "profile_missing") delete config.models!.profiles!["fixture-ea"];
    if (reason === "profile_overridden") config.models!.defaults = { profileId: "fixture-super", overrideClientPreference: true };
    if (reason === "execution_policy_changed") config.modelExecutionPolicies = {};
    const changed = createAgentManagementService(new FileAgentStateStore(f.filename), config);
    expect((await changed.read()).agents[0]).toEqual({ ...saved.agents[0], modelBinding: { status: "unavailable", reason } });
    expect(await readFile(f.filename, "utf8")).toBe(bytes);
    expect((await changed.read()).revision).toBe(1);
    if (reason !== "execution_policy_changed") return;
    const updated = await changed.update(saved.agents[0].id, definition("fixture-ea"), 1);
    expect(updated.agents[0]).toMatchObject({ revision: 2, definition: { executionPolicy: "supervisor-worker-v1" }, modelBinding: { status: "configured" } });
  },
);

test("captures configuration at composition instead of following caller mutation", async () => {
  const f = await fixture();
  f.config.modelExecutionPolicies = { "fixture-ea": { policy: "supervisor-worker-v1" } };
  const catalog = await f.service.register(definition("fixture-ea"), 0);
  expect(catalog.agents[0].definition.executionPolicy).toBe("execution-agent-v1");
});

test("serializes concurrent management with CAS and never retries a stale mutation", async () => {
  const f = await fixture();
  const other = createAgentManagementService(new FileAgentStateStore(f.filename), f.config);
  const results = await Promise.allSettled([f.service.register(definition(), 0), other.register(definition("fixture-ea"), 0)]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "agents_state_revision_conflict" } });
  expect((await f.service.read()).agents).toHaveLength(1);
});

test("restore preserves history even if the configured model is missing", async () => {
  const f = await fixture();
  const initial = await f.service.register(definition(), 0);
  const id = initial.agents[0].id;
  await f.store.commit({ kind: "bind_session", agentId: id, sessionId: "owned-session", purpose: "Retained evidence" }, 1);
  await f.service.archive(id, 2);
  const unavailable = createAgentManagementService(new FileAgentStateStore(f.filename), {});
  expect((await unavailable.restore(id, 3)).agents[0]).toMatchObject({ status: "active", modelBinding: { status: "unavailable", reason: "profile_missing" } });
  const state = await f.store.read();
  expect(state.sessions[0]).toMatchObject({ agentId: id, sessionId: "owned-session" });
  expect(state.changes.map((change) => change.kind)).toEqual(["agent_registered", "session_bound", "agent_archived", "agent_restored"]);
});

test("management cannot archive an Agent that owns a waiting mission", async () => {
  const f = await fixture();
  const id = (await f.service.register(definition(), 0)).agents[0].id;
  await f.store.commit(startAgentMission(id), 1);
  await f.store.commit({ kind: "wait_for_user", agentId: id, missionId: "mission-a", reason: "Unknown prior outcome" }, 2);
  await expect(f.service.archive(id, 3)).rejects.toMatchObject({ code: "agents_agent_busy" });
  expect((await f.store.read()).missions[0].status).toBe("awaiting_user_decision");
});

test("propagates corrupt state without replacing it with an empty catalog", async () => {
  const f = await fixture();
  await f.service.register(definition(), 0);
  await writeFile(f.filename, "{broken");
  await expect(f.service.read()).rejects.toMatchObject({ code: "agents_state_invalid" });
  await expect(f.service.reconcile()).rejects.toMatchObject({ code: "agents_state_invalid" });
  expect(await readFile(f.filename, "utf8")).toBe("{broken");
});

test("propagates unknown publication without retry and reconciles only on explicit request", async () => {
  const f = await fixture();
  const unknown = new AgentStateCommitUnknownError(1, new Error("injected uncertainty"));
  const commit = vi.spyOn(f.store, "commit").mockRejectedValueOnce(unknown);
  const reconcile = vi.spyOn(f.store, "reconcile");
  await expect(f.service.register(definition(), 0)).rejects.toBe(unknown);
  expect(commit).toHaveBeenCalledTimes(1);
  expect(reconcile).not.toHaveBeenCalled();
  expect(await f.service.reconcile()).toEqual({ revision: 0, agents: [] });
  expect(reconcile).toHaveBeenCalledTimes(1);
});

test("authoring previews are read-only and commit exactly the model-specific prompt and allowance across restart", async () => {
  const f = await fixture();
  const onboarding = { role: "research", outputs: ["recommendations"], style: "concise", asks: ["unclear"],
    updates: "needed", custom: "", notes: 'A user preference: "quoted".', color: "blue", budget: "short" } as const;
  const draft = { name: "Researcher", modelProfileId: "fixture-super", icon: "pebbles-blue", toolPermissionMode: "ask", onboarding } as const;
  const preview = await f.service.previewAuthoring(draft);
  expect(preview.basePrompt).toContain(JSON.stringify(onboarding.notes));
  expect(preview.limits).toMatchObject({ maxModelCalls: 48, maxTotalTokens: 300_000 });
  expect((await f.service.read()).revision).toBe(0);
  const created = await f.service.register({ authoring: draft }, 0);
  const agent = created.agents[0]!;
  const reloaded = createAgentManagementService(new FileAgentStateStore(f.filename), f.config);
  expect((await reloaded.read()).agents[0]?.definition).toMatchObject({ basePrompt: preview.basePrompt, defaultLimits: preview.limits, onboarding });
  const choosing = await reloaded.previewAuthoring({}, agent.id);
  expect(choosing.presets).toEqual(preview.presets);
  const edit = { ...draft, modelProfileId: "precise" };
  const changed = await reloaded.previewAuthoring(edit, agent.id);
  expect(changed.basePrompt).toEqual(preview.basePrompt);
  expect(changed.limits?.maxModelCalls).toBe(24);
  expect((await reloaded.update(agent.id, { authoring: edit }, 1)).agents[0]?.definition.defaultLimits).toEqual(changed.limits);
  await expect(reloaded.register({ authoring: { ...edit, modelProfileId: "missing" } }, 2)).rejects.toThrow("agents_model_profile_missing");
  expect((await reloaded.read()).revision).toBe(2);
});

test("legacy raw instructions and explicit custom limits survive a structured edit", async () => {
  const f = await fixture();
  const legacy = definition();
  const created = (await f.service.register(legacy, 0)).agents[0]!;
  const customLimits = { maxAttempts: 3, maxModelCalls: 7, maxTotalTokens: 54321, maxConsecutiveNoProgress: 1, maxClarificationRounds: 0 };
  const authoring = { name: "Renamed", icon: created.definition.icon, modelProfileId: created.definition.modelProfileId, toolPermissionMode: "ask",
    onboarding: { role: "custom", outputs: ["summaries"], style: "concise", asks: [], updates: "needed", custom: legacy.basePrompt, notes: "", color: "blue", budget: "custom" },
    limits: customLimits } as const;
  expect(await f.service.previewAuthoring(authoring, created.id)).toMatchObject({ basePrompt: legacy.basePrompt, limits: customLimits });
  expect((await f.service.update(created.id, { authoring }, 1)).agents[0]?.definition).toMatchObject({ basePrompt: legacy.basePrompt, defaultLimits: customLimits });
  const invalid = [
    { ...authoring, limits: { ...customLimits, maxAttempts: 0 } },
    { ...authoring, onboarding: { ...authoring.onboarding, outputs: [] } },
    { ...authoring, onboarding: { ...authoring.onboarding, custom: " " } },
    { ...authoring, onboarding: { ...authoring.onboarding, budget: "short" } },
    { ...authoring, basePrompt: "unsolicited" },
    { ...authoring, executionPolicy: "execution-agent-v1" },
  ];
  for (const value of invalid) await expect(f.service.update(created.id, { authoring: value as typeof authoring }, 2)).rejects.toThrow();
  expect((await f.service.read()).revision).toBe(2);
});
