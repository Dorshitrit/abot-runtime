import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ModelGatewayAttachment } from "../../model-gateway/types.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createRequestExecutionScope } from "../request/execution-scope.js";
import { runRequestRunner } from "../request/runner.js";
import { buildSupervisorProcedureGateInput } from "../steps/supervisor-decision/procedure-gate.js";
import { createMemoryRecallHarness, FINAL_RESPONSE, modelMessages, type RecallModelInput } from "./support/memory-recall-runner.js";
import { defaultSupervisorPresentation, supervisorFormatName } from "./support/supervisor-model-phases.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { resetDebugLoggerConfig(); vi.restoreAllMocks(); });

const attachments: ModelGatewayAttachment[] = [
  { id: "current-image", kind: "image", mimeType: "image/png", storageRef: "attachments/current.png", name: "diagram.png" },
  { id: "current-file", kind: "file", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", storageRef: "attachments/current.xlsx", name: "report.xlsx" },
];

test.each(attachments)("passes the current $kind attachment and only the latest settled turn to the fused entry", async (attachment) => {
  const prompt = "Review this attachment.";
  const latestTurn = [
    { role: "user", content: "LATEST_HISTORY_ATTACHMENT_REQUEST" },
    { role: "assistant", content: "LATEST_HISTORY_ATTACHMENT_RESPONSE" },
  ];
  function assertCurrentMessage(input: RecallModelInput) {
    expect(supervisorFormatName(input)).toBe("supervisor_fused_entry");
    const messages = modelMessages(input);
    expect(messages.filter(({ role, content }) => role === "user" && content === prompt)).toEqual([
      { role: "user", content: prompt, attachments: [attachment] },
    ]);
    expect(messages.flatMap((message) => message.attachments ?? [])).toEqual([attachment]);
    expect(JSON.stringify(messages)).not.toContain("OLD_HISTORY_ATTACHMENT_CONTEXT");
    expect(messages.filter(({ content }) => content.startsWith("LATEST_HISTORY_ATTACHMENT_")))
      .toEqual(latestTurn);
  }
  const present = vi.fn((input: RecallModelInput) => {
    assertCurrentMessage(input);
    return defaultSupervisorPresentation(input);
  });
  const selectSkills = vi.fn((input: RecallModelInput) => {
    assertCurrentMessage(input);
    return { action: "continue" };
  });
  const harness = createMemoryRecallHarness({
    policy: "supervisor-worker-v1", enabled: false, present, selectSkills,
    decide: () => ({ action: "respond" }),
  });
  const request = createRequestExecutionScope({
    seed: { ...harness.request, prompt, attachments: [attachment], shouldGenerateSessionTitle: true,
      historyMessages: [
        { id: "older-user", role: "user", content: "OLD_HISTORY_ATTACHMENT_CONTEXT", createdAt: "2026-10-01T00:00:00.000Z" },
        { id: "older-assistant", role: "assistant", content: "OLD_HISTORY_ATTACHMENT_CONTEXT_RESPONSE", createdAt: "2026-10-01T00:00:01.000Z" },
        { id: "latest-user", role: "user", content: latestTurn[0]!.content, createdAt: "2026-10-01T00:00:02.000Z" },
        { id: "latest-assistant", role: "assistant", content: latestTurn[1]!.content, createdAt: "2026-10-01T00:00:03.000Z" },
      ] },
    executionPolicy: harness.request.executionPolicy,
    knowledgeSkillStore: { list: () => [{ skillId: "attachment-guide", name: "Attachment guide", description: "Review an attachment." }], read: () => undefined },
    createWorkerCapabilities: () => harness.request.workerCapabilities.provider,
  });
  await expect(runRequestRunner(request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(present).toHaveBeenCalledOnce();
  expect(selectSkills).toHaveBeenCalledOnce();
  expect(selectSkills.mock.calls[0]![0]).toBe(present.mock.calls[0]![0]);
});

test("fused entry attachments use the existing context budget and leave an unattached request unchanged", () => {
  const harness = createMemoryRecallHarness({
    policy: "supervisor-worker-v1", enabled: false, decide: () => ({ action: "respond" }),
  });
  const options = {
    entryInstructions: "A fused entry contract.",
    diagnostic: { requestId: harness.request.requestId, modelStep: "supervisor.decision" as const, decisionPhase: "procedure_gate" as const },
  };
  const withoutAttachments = buildSupervisorProcedureGateInput(harness.request, options);
  const request = createRequestExecutionScope({
    seed: { ...harness.request, attachments }, executionPolicy: harness.request.executionPolicy,
    createWorkerCapabilities: () => harness.request.workerCapabilities.provider,
  });
  const withAttachments = buildSupervisorProcedureGateInput(request, options);
  expect(withoutAttachments.context.messages.every((message) => message.attachments === undefined)).toBe(true);
  expect(withoutAttachments.context.budget.attachmentReserveTokens).toBe(0);
  expect(withAttachments.context.budget.attachmentReserveTokens).toBe(200);
  expect(withAttachments.context.budget.estimatedInputTokens - withoutAttachments.context.budget.estimatedInputTokens).toBe(200);
  expect(withAttachments.context.messages.map(({ role, content }) => ({ role, content })))
    .toEqual(withoutAttachments.context.messages);
});
