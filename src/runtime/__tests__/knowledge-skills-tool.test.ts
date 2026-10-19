import { describe, expect, test, vi } from "vitest";
import type { ToolModuleDeclaration } from "../../capabilities/tool-types.js";
import { createRegisteredToolNormalInvocationExecutor } from "../adapters/registered-tool-normal-invocations.js";
import type { RegisteredToolInvocationSnapshot } from "../adapters/registered-tool-normal-invocations/execution/prepared-snapshot.js";
import { resolveRegisteredToolCapabilityCatalog } from "../adapters/registered-tool-worker-capabilities/catalog.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { createKnowledgeSkillsToolModule } from "../capabilities/knowledge-skills/tool-module.js";
import { restrictToolRegistryToRequestMode } from "../capabilities/request-permission-tool-registry.js";
import { createDefaultToolRegistry } from "../default-adapters.js";
import { createKnowledgeSkillStore } from "../knowledge-skills/store.js";
import { projectWorkerCapabilityScope } from "../orchestration/worker-capabilities/scope.js";
import type { ToolApprovalController, ToolPermissionMode } from "../ports.js";
import { loadPublicRuntimeConfig } from "./public-runtime-config-fixture.js";

const document = {
  skillId: "fixture-reference",
  name: "Fixture knowledge reference",
  description: "Discover this fixture when inspecting the tool contract.",
  content: "PRIVATE_BODY_94c: Preserve the exact document, including\nline breaks.",
};

function fixture(
  mode: ToolPermissionMode = "full_access",
  approval?: ToolApprovalController,
  selectModules: (module: ToolModuleDeclaration) => readonly ToolModuleDeclaration[] = (module) => [module],
) {
  const source = createKnowledgeSkillStore([document]);
  const store = { list: vi.fn(source.list), read: vi.fn(source.read) };
  const module = createKnowledgeSkillsToolModule(store);
  const registry = createConfiguredToolRegistry(undefined, selectModules(module));
  const onEvent = vi.fn();
  const executor = createRegisteredToolNormalInvocationExecutor({
    registrations: registry.listNormalInvocations!(),
    toolRegistry: registry,
    requestId: "knowledge-skills-contract",
    abortSignal: new AbortController().signal,
    toolPermissionMode: mode,
    nextApprovalId: () => "knowledge-approval",
    onEvent,
    ...(approval ? { toolApprovalController: approval } : {}),
  });
  const prepare = (operationId: string, controls: Record<string, unknown>) => {
    const operation = executor.operations.find((entry) => entry.operation.operationId === operationId);
    if (!operation) throw new Error("fixture_operation_missing");
    return executor.prepare({ handle: operation.handle, controls });
  };
  const execute = async (operationId: string, controls: Record<string, unknown>) => {
    const prepared = prepare(operationId, controls);
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") throw new Error("fixture_preparation_rejected");
    return prepared.execute("knowledge-execution");
  };
  return { module, store, registry, executor, onEvent, prepare, execute };
}

const readSelections = [
  { operationId: "list_skills", controls: {} },
  { operationId: "read_skill", controls: { skillId: document.skillId } },
  { operationId: "read_skills", controls: { skillIds: [document.skillId] } },
];

function ordinaryReadModule(core: ToolModuleDeclaration): ToolModuleDeclaration {
  const read = core.normalInvocation.operations.find(({ operationId }) => operationId === "read_skill")!;
  return {
    ...core,
    definition: { ...core.definition, name: "ordinary_reference" },
    normalInvocation: {
      version: 1,
      operations: [{ ...read, operationId: "inspect_reference", fixedParams: { action: "inspect_reference" } }],
    },
  };
}

describe("knowledge Skills as an ordinary core tool", () => {
  test("registers observation operations with complete mechanical controls and no payload stage", () => {
    const f = fixture();
    expect(f.registry.getDefinition("abot_skills")).toMatchObject({
      controlsRefinement: "mechanical_when_complete",
      catalogGroups: ["knowledge"],
    });
    expect(f.executor.operations.map(({ operation }) => ({
      operationId: operation.operationId,
      effect: operation.effect,
      approval: operation.approval,
    }))).toEqual([
      { operationId: "list_skills", effect: "read_only", approval: "request_policy" },
      { operationId: "read_skill", effect: "read_only", approval: "request_policy" },
      { operationId: "read_skills", effect: "read_only", approval: "request_policy" },
    ]);
    const read = f.executor.operations.find(({ operation }) => operation.operationId === "read_skill")!;
    expect(read.operation.selectionControlIds).toEqual(["skillId"]);
    for (const operation of f.executor.operations) {
      expect(operation).not.toHaveProperty("stagedPayloadPlan");
      expect(operation).not.toHaveProperty("payloadContextPlan");
      expect(operation.operation).not.toHaveProperty("payload");
    }
    expect(f.store.list).not.toHaveBeenCalled();
    expect(f.store.read).not.toHaveBeenCalled();
  });

  test("LIST returns only catalog metadata through the standard ToolExecutionResult", async () => {
    const f = fixture();
    const result = await f.execute("list_skills", {});
    expect(result).toMatchObject({
      status: "executed", effect: "read_only",
      result: { ok: true, tool: "abot_skills", producedNewInformation: true },
    });
    if (result.status !== "executed") throw new Error("fixture_execution_rejected");
    expect(JSON.parse(result.result.output)).toEqual({
      skills: [{ skillId: document.skillId, name: document.name, description: document.description }],
    });
    expect(f.store.list).toHaveBeenCalledOnce();
    expect(f.store.read).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("PRIVATE_BODY_94c");
  });

  test("READ preserves the body in the result while lifecycle metadata exposes only its identity and name", async () => {
    const f = fixture();
    const result = await f.execute("read_skill", { skillId: document.skillId });
    expect(result).toMatchObject({
      status: "executed", effect: "read_only",
      result: { ok: true, tool: "abot_skills", data: { mutationEvidence: false } },
    });
    if (result.status !== "executed") throw new Error("fixture_execution_rejected");
    expect(JSON.parse(result.result.output)).toEqual({
      skillId: document.skillId, name: document.name, content: document.content,
    });
    expect(f.store.read).toHaveBeenCalledExactlyOnceWith(document.skillId);
    expect(f.onEvent.mock.calls.map(([name]) => name)).toEqual(["tool.started", "tool.completed"]);
    expect(f.onEvent.mock.calls[1]![1]).toMatchObject({
      tool: "abot_skills", executionId: "knowledge-execution", ok: true,
      meta: { skillAction: "read_skill", skillId: document.skillId, skillTitle: document.name },
    });
    expect(JSON.stringify(f.onEvent.mock.calls)).not.toContain("PRIVATE_BODY_94c");
  });

  test("missing or malformed read controls fail before Store access", () => {
    const f = fixture();
    for (const controls of [{}, { skillId: "" }, { skillId: 42 }]) {
      expect(f.prepare("read_skill", controls)).toMatchObject({
        status: "rejected", code: "normal_invocation_input_invalid",
      });
    }
    expect(f.store.read).not.toHaveBeenCalled();
    expect(f.onEvent).not.toHaveBeenCalled();
  });

  test.each([
    ["absent-reference", "knowledge_skill_not_found"],
    [" fixture-reference ", "knowledge_skill_id_invalid"],
  ])("READ reports %s as an ordinary failed result without substituting another document", async (skillId, errorCode) => {
    const f = fixture();
    const result = await f.execute("read_skill", { skillId });
    expect(result).toMatchObject({
      status: "executed",
      result: { ok: false, errorCode, producedNewInformation: false },
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_BODY_94c");
    expect(f.onEvent.mock.calls.at(-1)).toMatchObject([
      "tool.completed", { tool: "abot_skills", ok: false },
    ]);
  });

  test("core registration remains available with plugins disabled and honors model deny selectors", async () => {
    const config = loadPublicRuntimeConfig([]);
    const registry = createDefaultToolRegistry({ ...config, plugins: { enabled: false } });
    expect(registry.getDefinition("abot_skills")).toBeDefined();
    const registrations = registry.listNormalInvocations!()
      .filter(({ toolName }) => toolName === "abot_skills");
    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.contract.operations.map(({ operationId }) => operationId))
      .toEqual(["list_skills", "read_skill", "read_skills", "create_skill", "update_skill"]);
    const blocked = restrictToolRegistryToRequestMode(registry, "full_access", {
      deny: ["abot_skills"],
    });
    expect(blocked.getDefinition("abot_skills")).toBeUndefined();
    expect(blocked.listNormalInvocations!().some(({ toolName }) => toolName === "abot_skills")).toBe(false);
    expect(await blocked.execute({ tool: "abot_skills", params: { action: "list_skills" } }))
      .toMatchObject({ ok: false, errorCode: "tool_model_policy_denied" });
    expect(registry.getDefinition("abot_skills")).toBeDefined();
  });

  test("ordinary role catalog scopes can include or exclude knowledge operations", () => {
    const f = fixture();
    const knowledge = resolveRegisteredToolCapabilityCatalog(f.registry, false).descriptors;
    const unrelated = { ...knowledge[0]!, capabilityId: "inspect_fixture", catalogGroups: ["inspection"] };
    const entries = [...knowledge, unrelated];
    const project = (group: string) => projectWorkerCapabilityScope({
      entries, scope: { catalogGroupIds: [group] }, descriptorOf: (entry) => entry,
    }).filteredCapabilityIds;
    expect(project("knowledge")).toEqual(["list_skills", "read_skill", "read_skills"]);
    expect(project("inspection")).toEqual(["inspect_fixture"]);
    expect(f.store.list).not.toHaveBeenCalled();
    expect(f.store.read).not.toHaveBeenCalled();
  });

  test.each(readSelections.flatMap((selection) => [true, false].map((withController) => ({
    ...selection, withController,
  }))))("ASK $operationId needs no approval (controller: $withController)", async ({ operationId, controls, withController }) => {
    const requestToolApproval = vi.fn<ToolApprovalController["requestToolApproval"]>(
      async () => ({ approved: false, reason: "Denied by the user." }),
    );
    const f = fixture("ask", withController ? { requestToolApproval } : undefined);
    const prepared = f.prepare(operationId, controls);
    if (prepared.status !== "prepared") throw new Error("fixture_preparation_rejected");
    expect(prepared.approvalRequest).toBeUndefined();
    expect(await prepared.execute()).toMatchObject({ status: "executed", result: { ok: true } });
    expect(requestToolApproval).not.toHaveBeenCalled();
    expect(f.onEvent.mock.calls.map(([name]) => name)).toEqual(["tool.started", "tool.completed"]);
    expect(operationId === "list_skills" ? f.store.list : f.store.read).toHaveBeenCalledOnce();
  });

  test.each(readSelections)("ASK $operationId snapshot restores without approval", async ({ operationId, controls }) => {
    const f = fixture("ask");
    const prepared = f.prepare(operationId, controls);
    if (prepared.status !== "prepared") throw new Error("fixture_preparation_rejected");
    const restored = f.executor.restore(JSON.parse(JSON.stringify(prepared.snapshot)));
    if (restored.status !== "prepared") throw new Error("fixture_restore_rejected");
    expect(restored.approvalRequest).toBeUndefined();
    expect(restored.actionFingerprint).toBe(prepared.actionFingerprint);
    expect(f.store.list).not.toHaveBeenCalled();
    expect(f.store.read).not.toHaveBeenCalled();
    expect(await restored.execute()).toMatchObject({ status: "executed", result: { ok: true } });
    expect(f.onEvent.mock.calls.map(([name]) => name)).toEqual(["tool.started", "tool.completed"]);
  });

  test.each([false, true])("an older pending Skill read keeps its exact approval (approved: %s)", async (approved) => {
    const requestToolApproval = vi.fn<ToolApprovalController["requestToolApproval"]>(
      async () => ({ approved, reason: "Saved request decision." }),
    );
    const f = fixture("ask", { requestToolApproval });
    const prepared = f.prepare("read_skill", { skillId: document.skillId });
    if (prepared.status !== "prepared") throw new Error("fixture_preparation_rejected");
    const snapshot = structuredClone(prepared.snapshot) as RegisteredToolInvocationSnapshot;
    const approvalRequest = {
      requestId: "knowledge-skills-contract", approvalId: "previous-version-approval", call: snapshot.call,
    };
    const saved = JSON.parse(JSON.stringify({ ...snapshot, approvalRequest }));
    const restored = f.executor.restore(saved);
    if (restored.status !== "prepared") throw new Error("fixture_restore_rejected");
    expect(restored.approvalRequest).toEqual(approvalRequest);
    expect(f.store.read).not.toHaveBeenCalled();
    const result = await restored.execute();
    expect(requestToolApproval).toHaveBeenCalledOnce();
    expect(requestToolApproval.mock.calls[0]![0]).toEqual(approvalRequest);
    if (approved) {
      expect(result).toMatchObject({ status: "executed", result: { ok: true } });
      expect(f.store.read).toHaveBeenCalledExactlyOnceWith(document.skillId);
      return;
    }
    expect(result).toMatchObject({ status: "rejected", code: "tool_approval_rejected" });
    expect(f.store.read).not.toHaveBeenCalled();
    expect(f.onEvent.mock.calls.some(([name]) => name === "tool.started")).toBe(false);
  });

  test.each(["ordinary", "ordinary_to_core", "core_to_ordinary"])("ASK still approves %s read-only invocations", async (route) => {
    const requestToolApproval = vi.fn<ToolApprovalController["requestToolApproval"]>(
      async () => ({ approved: false, reason: "Denied by the user." }),
    );
    const f = fixture("ask", { requestToolApproval }, (core) => {
      const ordinary = ordinaryReadModule(core);
      if (route === "ordinary_to_core") {
        ordinary.adapter = { normalizeCall: (call) => ({
          tool: "abot_skills", params: { action: "read_skill", skillId: call.params.skillId },
        }) };
      }
      if (route === "core_to_ordinary") {
        core.adapter = { normalizeCall: (call) => ({
          tool: "ordinary_reference", params: { action: "inspect_reference", skillId: call.params.skillId },
        }) };
      }
      return [core, ordinary];
    });
    const selected = route === "core_to_ordinary" ? "read_skill" : "inspect_reference";
    const prepared = f.prepare(selected, { skillId: document.skillId });
    if (prepared.status !== "prepared") throw new Error("fixture_preparation_rejected");
    expect(prepared.approvalRequest).toBeDefined();
    const restored = f.executor.restore(JSON.parse(JSON.stringify(prepared.snapshot)));
    if (restored.status !== "prepared") throw new Error("fixture_restore_rejected");
    expect(restored.approvalRequest).toEqual(prepared.approvalRequest);
    expect(await restored.execute()).toMatchObject({ status: "rejected", code: "tool_approval_rejected" });
    expect(requestToolApproval).toHaveBeenCalledOnce();
    expect(f.store.read).not.toHaveBeenCalled();
    expect(f.onEvent.mock.calls.some(([name]) => name === "tool.started")).toBe(false);
  });

  test.each(["ask", "full_access"] as const)("forced approval still governs a changed core contract in %s", async (mode) => {
    const requestToolApproval = vi.fn<ToolApprovalController["requestToolApproval"]>(
      async () => ({ approved: false, reason: "Denied by the user." }),
    );
    const f = fixture(mode, { requestToolApproval }, (core) => [{
      ...core,
      normalInvocation: { ...core.normalInvocation,
        operations: core.normalInvocation.operations.map((operation) => ({ ...operation, approval: "always" })),
      },
    }]);
    const prepared = f.prepare("read_skill", { skillId: document.skillId });
    if (prepared.status !== "prepared") throw new Error("fixture_preparation_rejected");
    expect(prepared.approvalRequest).toBeDefined();
    expect(await prepared.execute()).toMatchObject({ status: "rejected", code: "tool_approval_rejected" });
    expect(requestToolApproval).toHaveBeenCalledOnce();
    expect(f.store.read).not.toHaveBeenCalled();
    expect(f.onEvent.mock.calls.some(([name]) => name === "tool.started")).toBe(false);
  });

  test("a legacy Skill approval with substituted controls is rejected before Store access", () => {
    const f = fixture("ask");
    const prepared = f.prepare("read_skill", { skillId: document.skillId });
    if (prepared.status !== "prepared") throw new Error("fixture_preparation_rejected");
    const snapshot = structuredClone(prepared.snapshot) as RegisteredToolInvocationSnapshot;
    expect(() => f.executor.restore({ ...snapshot, approvalRequest: {
      requestId: "knowledge-skills-contract", approvalId: "previous-version-approval",
      call: { ...snapshot.call, params: { action: "read_skill", skillId: "another-skill" } },
    } })).toThrow("registered_tool_snapshot_incompatible");
    expect(f.store.read).not.toHaveBeenCalled();
  });
});
