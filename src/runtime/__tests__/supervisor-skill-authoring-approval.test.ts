import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createLocalRuntimeOwner } from "../local-host/app-owner.js";
import type { LocalPendingToolApproval } from "../local-host/request-approval-contracts.js";
import { SKILL_CREATOR } from "../knowledge-skills/builtins/skill-creator.js";
import { createRuntimeKnowledgeSkillStore } from "../knowledge-skills/personal-store.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { capabilityResults, capsules, decision, messages } from "./support/knowledge-skills-request-fixture.js";
import { makeOwnerControlPeer } from "./support/local-runtime-owner-peer.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";
import { defaultSupervisorPresentation, supervisorFormatName } from "./support/supervisor-model-phases.js";

const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release();
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

const scenarios = [
  { label: "create approved", action: "create_skill", approved: true, concurrentEdit: false },
  { label: "create denied", action: "create_skill", approved: false, concurrentEdit: false },
  { label: "update approved", action: "update_skill", approved: true, concurrentEdit: false },
  { label: "update conflicts with a newer revision", action: "update_skill", approved: true, concurrentEdit: true },
] as const;

test.each(scenarios)("SUPER restores $label without selection, reads or reauthoring", async (scenario) => {
  const base = await createSchedulerRuntimeFixture("supervisor-worker-v1");
  await base.application.stop();
  cleanup.push(() => base.dispose());
  const name = "Review conventions";
  const description = "For reviewing code changes.";
  const originalContent = "# Review conventions\n\nRead the diff before reviewing.";
  const content = "# Review conventions\n\nRead the diff and report only material issues.";
  const concurrentContent = "# Review conventions\n\nPreserve this independently saved change.";
  const store = () => createRuntimeKnowledgeSkillStore(base.config.paths.runtimeDir);
  const original = scenario.action === "update_skill"
    ? await store().create({ name, description, content: originalContent }) : undefined;
  const controls = original
    ? { skillId: original.skillId, expectedRevision: original.revision }
    : { name, description };
  const succeeded = scenario.approved && !scenario.concurrentEdit;
  const answer = succeeded ? "The Skill was saved." : "The Skill was not saved.";
  let selectionCalls = 0;
  let rawCalls = 0;
  let authoringCalls = 0;
  let routeCalls = 0;
  let assertion: unknown;
  base.invoke.mockImplementation(async (input) => {
    try {
      if (input.modelStep === "tool_payload.raw") {
        expect(++rawCalls).toBe(1);
        const prefix = "Canonical runtime context:\n";
        const context = messages(input).find(({ content }) => content.startsWith(prefix));
        expect(context).toBeDefined();
        const canonical = JSON.parse(context!.content.slice(prefix.length));
        expect(canonical.acceptedCapability).toMatchObject({
          capabilityId: scenario.action, controls,
          authoringObjective: expect.any(String),
        });
        expect(canonical.acceptedCapability.authoringObjective.trim()).not.toBe("");
        expect(canonical.acceptedCapability.controls).not.toHaveProperty("authoringObjective");
        expect(capsules(input, "runtime_core_skill_read_v1")).toContainEqual(
          expect.objectContaining({ document: expect.objectContaining({
            skillId: SKILL_CREATOR.skillId, content: SKILL_CREATOR.content,
          }) }),
        );
        if (original) {
          expect(canonical.payloadStage).toEqual({ index: 1, count: 1, outputParam: "content" });
          expect(canonical.targetContext).toMatchObject({
            targetParam: "skillId", targetPath: original.skillId, presentation: "full",
          });
          const target = messages(input).find(({ content }) =>
            content.startsWith('{"kind":"runtime_payload_target_content_v1"'));
          expect(target).toBeDefined();
          expect(target!.content.slice(target!.content.indexOf("\n") + 1)).toBe(originalContent);
        }
        return { text: content, meta: {} };
      }
      if (input.modelStep === "supervisor.response") {
        const result = capabilityResults(input).find(({ capabilityId }) => capabilityId === scenario.action);
        expect(result).toMatchObject({ capabilityId: scenario.action, outcome: succeeded ? "succeeded" : "failed" });
        if (scenario.concurrentEdit)
          expect(JSON.stringify(result)).toContain("knowledge_skill_revision_conflict");
        return { text: answer, meta: {} };
      }
      if (input.modelStep === "worker.decision")
        return { text: decision({ action: "return_result" }), meta: {} };
      if (input.modelStep === "worker.result")
        return { text: "The personal Skill request is ready for the root's authoring operation.", meta: {} };
      expect(input.modelStep).toBe("supervisor.decision");
      const phase = supervisorFormatName(input);
      if (phase === "supervisor_presentation")
        return { text: decision(defaultSupervisorPresentation(input)), meta: {} };
      if (phase === "supervisor_procedure_gate")
        return { text: decision({ requiresProcedure: true }), meta: {} };
      if (phase === "supervisor_delegation") {
        expect(JSON.stringify(input.format)).not.toContain('"author_skill"');
        return { text: decision({ action: "invoke_role", roleId: "worker", objective: "Prepare the requested personal Skill change." }), meta: {} };
      }
      if (phase === "supervisor_working_directory")
        return { text: JSON.stringify({ workingDirectory: "." }), meta: {} };
      if (phase === "supervisor_decision") {
        expect(++routeCalls).toBe(1);
        expect(capsules(input, "runtime_child_result")).toContainEqual(expect.objectContaining({ roleId: "worker" }));
        expect(capsules(input, "runtime_core_skill_read_v1")).toContainEqual(expect.objectContaining({
          document: expect.objectContaining({ skillId: SKILL_CREATOR.skillId, content: SKILL_CREATOR.content }),
        }));
        return { text: decision({ action: "author_skill" }), meta: {} };
      }
      if (phase === "supervisor_skill_authoring") {
        expect(++authoringCalls).toBe(1);
        expect(JSON.stringify(input.format)).not.toContain('"expectedRevision"');
        expect(JSON.stringify(input.format)).not.toContain('"authoringObjective"');
        return { text: decision(original
          ? { action: "update_skill", skillId: original.skillId }
          : { action: "create_skill", name, description }), meta: {} };
      }
      expect(phase).toBe("supervisor_skill_selection");
      selectionCalls += 1;
      if (selectionCalls === 2) return { text: decision({ action: "continue" }), meta: {} };
      expect(selectionCalls).toBe(1);
      expect(JSON.stringify(input.format)).not.toContain('"create_skill"');
      return { text: decision({ action: "read_skills", skillIds: [SKILL_CREATOR.skillId] }), meta: {} };
    } catch (error) { assertion ??= error; throw error; }
  });
  const events: Record<string, unknown>[] = [];
  const startOwner = async () => {
    const owner = await createLocalRuntimeOwner(base.config, {
      models: { invoke: base.invoke, invokeRaw: base.invokeRaw },
    });
    cleanup.push(async () => { await owner.stop(); await owner.whenIdle?.(); });
    owner.subscribe((event) => {
      const envelope = event as { type: string; event?: Record<string, unknown> };
      if (envelope.type === "request.event" && envelope.event) events.push(envelope.event);
    });
    return owner;
  };
  const owner = await startOwner();
  const { peer, callClient } = makeOwnerControlPeer("skill-authoring-view");
  callClient.mockImplementation(async (method, args) => {
    if (method === "request.event") events.push(args[1] as Record<string, unknown>);
    return { approved: true };
  });
  const outcome = await owner.call("request.run", [{
    type: "run_request", requestId: "saved-skill", sessionId: "session",
    text: original
      ? "Edit my Review conventions Skill to report only material issues after reading the diff."
      : "Create a personal review Skill: read the diff and report only material issues.",
    toolPermissionMode: "ask", agentMode: "reasoning",
    modelPreference: { profileId: "scheduled-model", scope: "all" },
  }, { durableApprovals: true, approvalAvailable: true }], peer);
  if (assertion) throw assertion;
  expect(outcome).toMatchObject({ kind: "awaiting_approval" });
  const pending = await owner.call("request.approvals", ["session"], peer) as LocalPendingToolApproval[];
  expect(pending).toHaveLength(1);
  expect(pending[0]!.request.call).toMatchObject({
    tool: "abot_skills", params: { action: scenario.action, ...controls, content },
  });
  const readEvents = () => events.filter(({ stage, phase }) =>
    stage === "supervisor" && phase === "skills");
  expect(readEvents()).toHaveLength(original ? 2 : 1);
  if (original) expect(store().read(original.skillId)).toEqual(original);
  else expect(store().list().filter((entry) => entry.name === name)).toEqual([]);
  const beforeRestart = base.invoke.mock.calls.length;
  const beforeRestartEvents = events.length;
  await owner.stop();
  await owner.whenIdle?.();
  if (scenario.concurrentEdit)
    await store().update(original!.skillId, original!.revision, { content: concurrentContent });
  const restored = await startOwner();
  expect(await restored.call("request.approvals", ["session"], peer)).toEqual(pending);
  expect(base.invoke).toHaveBeenCalledTimes(beforeRestart);
  const approval = pending[0]!;
  const command = {
    sessionId: "session", requestId: "saved-skill", approvalId: approval.request.approvalId,
    ...approval.wait!, commandId: "skill-decision", approved: scenario.approved,
  };
  expect(await restored.call("request.approval.decide", [command], peer)).toEqual({ accepted: true });
  await restored.whenIdle?.();
  if (assertion) throw assertion;
  expect(await restored.call("request.approval.decide", [command], peer))
    .toEqual({ accepted: true, duplicate: true });
  expect(await restored.call("request.approvals", ["session"], peer)).toEqual([]);
  expect(rawCalls).toBe(1);
  expect(selectionCalls).toBe(2);
  expect(authoringCalls).toBe(1);
  expect(routeCalls).toBe(1);
  expect(base.invoke.mock.calls.slice(beforeRestart).map(([input]) => input.modelStep))
    .toEqual(["supervisor.response"]);
  expect(base.invokeRaw).not.toHaveBeenCalled();
  expect(readEvents()).toHaveLength(original ? 2 : 1);
  const resumedEvents = events.slice(beforeRestartEvents);
  expect(resumedEvents).toContainEqual(expect.objectContaining({ type: "completed", output: answer }));
  expect(resumedEvents.filter(({ name }) => name === "tool.started")).toHaveLength(scenario.approved ? 1 : 0);
  const saved = store().list().filter((entry) => entry.name === name);
  expect(saved).toHaveLength(original || scenario.approved ? 1 : 0);
  if (saved.length)
    expect(store().read(saved[0]!.skillId)).toMatchObject({
      name, description, source: "personal", revision: original ? 2 : 1,
      content: scenario.concurrentEdit ? concurrentContent : content,
    });
});
