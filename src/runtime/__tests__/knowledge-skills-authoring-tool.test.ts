import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createRuntimeKnowledgeSkillStore } from "../knowledge-skills/personal-store.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { createKnowledgeSkillsToolModule } from "../capabilities/knowledge-skills/tool-module.js";
import { createRegisteredToolNormalInvocationExecutor } from "../adapters/registered-tool-normal-invocations.js";
import type { ToolPermissionMode } from "../ports.js";

const roots: string[] = [];
const controls = { name: "My Git workflow", description: "When working on Git changes." };
const body = "# Git\n\nPRIVATE_GUIDANCE: Inspect the working tree.";
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup(mode: ToolPermissionMode = "full_access") {
  const root = await mkdtemp(join(tmpdir(), "skill-authoring-"));
  roots.push(root);
  const source = createRuntimeKnowledgeSkillStore(root);
  const store = { ...source, create: vi.fn(source.create), update: vi.fn(source.update) };
  const registry = createConfiguredToolRegistry(undefined, [createKnowledgeSkillsToolModule(store)]);
  const onEvent = vi.fn();
  const requestToolApproval = vi.fn(async () => ({ approved: false, reason: "Denied." }));
  const executor = createRegisteredToolNormalInvocationExecutor({
    registrations: registry.listNormalInvocations!(), toolRegistry: registry, requestId: "skill-write",
    abortSignal: new AbortController().signal, toolPermissionMode: mode,
    nextApprovalId: () => "approval-1", toolApprovalController: { requestToolApproval }, onEvent,
  });
  const prepare = (id: string, selection: Record<string, unknown>, payload?: string) => {
    const operation = executor.operations.find(({ operation }) => operation.operationId === id)!;
    return executor.prepare({ handle: operation.handle, controls: selection, payload });
  };
  const execute = async (id: string, selection: Record<string, unknown>, payload?: string) => {
    const prepared = await prepare(id, selection, payload);
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") throw new Error("preparation_failed");
    return prepared.execute("execution-1");
  };
  return { source, store, registry, executor, onEvent, requestToolApproval, prepare, execute };
}

test("only authoring operations require RAW bodies; saved receipts and events expose identity without content", async () => {
  const f = await setup();
  for (const { operation } of f.executor.operations) {
    if (operation.effect === "mutating") expect(operation.payload).toMatchObject({ param: "content", kind: "raw_text" });
    else expect(operation).not.toHaveProperty("payload");
  }
  const created = await f.execute("create_skill", controls, body);
  expect(created).toMatchObject({ status: "executed", effect: "mutating",
    result: { ok: true, data: { mutationEvidence: true, skillTitle: controls.name } } });
  if (created.status !== "executed") throw new Error("create_failed");
  const receipt = JSON.parse(created.result.output);
  expect(receipt).toMatchObject({ ...controls, revision: 1, source: "personal" });
  expect(f.store.read(receipt.skillId)?.content).toBe(body);
  expect(f.onEvent.mock.calls.at(-1)).toMatchObject(["tool.completed", {
    ok: true, meta: { skillAction: "create_skill", skillTitle: controls.name, savedSkillId: receipt.skillId },
  }]);
  expect(JSON.stringify(f.onEvent.mock.calls)).not.toContain("PRIVATE_GUIDANCE");
  expect(created.result.output).not.toContain("PRIVATE_GUIDANCE");
  const read = await f.execute("read_skill", { skillId: receipt.skillId });
  if (read.status !== "executed") throw new Error("read_failed");
  expect(JSON.parse(read.result.output)).toMatchObject({ ...receipt, content: body });
  const updated = await f.execute("update_skill", { skillId: receipt.skillId, expectedRevision: 1 }, "Updated guidance.");
  expect(updated).toMatchObject({ status: "executed", result: { ok: true, data: { mutationEvidence: true } } });
  expect(f.store.read(receipt.skillId)).toMatchObject({ ...controls, revision: 2, content: "Updated guidance." });
  const stale = await f.execute("update_skill", { skillId: receipt.skillId, expectedRevision: 1 }, "Stale.");
  expect(stale).toMatchObject({ status: "executed", result: { ok: false, errorCode: "knowledge_skill_revision_conflict",
    data: { mutationEvidence: false } } });
});

test.each(["create_skill", "update_skill"])("ASK rejects %s before the Store is touched", async (operationId) => {
  const f = await setup("ask");
  const existing = await f.source.create({ ...controls, content: body });
  const selection = operationId === "create_skill"
    ? controls
    : { skillId: existing.skillId, expectedRevision: existing.revision };
  const before = f.store.read(existing.skillId);
  const metadataBefore = f.store.list();
  const prepared = await f.prepare(operationId, selection, "Replacement guidance.");
  if (prepared.status !== "prepared") throw new Error("preparation_failed");
  expect(prepared.approvalRequest).toBeDefined();
  const restored = await f.executor.restore(JSON.parse(JSON.stringify(prepared.snapshot)));
  if (restored.status !== "prepared") throw new Error("restore_failed");
  expect(restored.approvalRequest).toEqual(prepared.approvalRequest);
  const result = await restored.execute();
  expect(result).toMatchObject({ status: "rejected", code: "tool_approval_rejected" });
  expect(f.store.create).not.toHaveBeenCalled();
  expect(f.store.update).not.toHaveBeenCalled();
  expect(f.store.list()).toEqual(metadataBefore);
  expect(f.store.read(existing.skillId)).toEqual(before);
  expect(f.onEvent.mock.calls.some(([name]) => name === "tool.started")).toBe(false);
  expect(f.requestToolApproval).toHaveBeenCalledOnce();
});

test("invalid controls or a missing body fail preparation and packaged updates return read-only failure", async () => {
  const f = await setup();
  expect((await f.prepare("create_skill", controls)).status).toBe("rejected");
  expect((await f.prepare("create_skill", { name: "Name only" }, body)).status).toBe("rejected");
  expect((await f.prepare("update_skill", { skillId: "abot-studio" }, body)).status).toBe("rejected");
  expect(f.store.create).not.toHaveBeenCalled();
  expect(f.store.update).not.toHaveBeenCalled();
  expect(await f.execute("update_skill", { skillId: "abot-studio", expectedRevision: 1 }, body))
    .toMatchObject({ status: "executed", result: { ok: false, errorCode: "knowledge_skill_read_only",
      data: { mutationEvidence: false } } });
});
