import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ModelGatewayAttachment } from "../../model-gateway/types.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createRequestExecutionScope } from "../request/execution-scope.js";
import { runRequestRunner } from "../request/runner.js";
import { buildSupervisorPreparationInput } from "../steps/supervisor-decision/preparation-input.js";
import { createSupervisorPresentationFormat } from "../steps/supervisor-decision/presentation.js";
import { createMemoryRecallHarness, FINAL_RESPONSE, modelMessages, type RecallModelInput } from "./support/memory-recall-runner.js";
import { defaultSupervisorPresentation } from "./support/supervisor-model-phases.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { resetDebugLoggerConfig(); vi.restoreAllMocks(); });

const attachments: ModelGatewayAttachment[] = [
  { id: "current-image", kind: "image", mimeType: "image/png", storageRef: "attachments/current.png", name: "diagram.png" },
  { id: "current-file", kind: "file", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", storageRef: "attachments/current.xlsx", name: "report.xlsx" },
];

test.each(attachments)("passes the current $kind attachment to presentation and Skill selection without history", async (attachment) => {
  const prompt = "Review this attachment.";
  function assertCurrentMessage(input: RecallModelInput) {
    const messages = modelMessages(input);
    expect(messages.filter(({ role, content }) => role === "user" && content === prompt)).toEqual([
      { role: "user", content: prompt, attachments: [attachment] },
    ]);
    expect(messages.flatMap((message) => message.attachments ?? [])).toEqual([attachment]);
    expect(JSON.stringify(messages)).not.toContain("OLD_HISTORY_ATTACHMENT_CONTEXT");
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
      historyMessages: [{ id: "previous-message", role: "user", content: "OLD_HISTORY_ATTACHMENT_CONTEXT", createdAt: "2026-10-01T00:00:00.000Z" }] },
    executionPolicy: harness.request.executionPolicy,
    knowledgeSkillStore: { list: () => [{ skillId: "attachment-guide", name: "Attachment guide", description: "Review an attachment." }], read: () => undefined },
    createWorkerCapabilities: () => harness.request.workerCapabilities.provider,
  });
  await expect(runRequestRunner(request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(present).toHaveBeenCalledOnce();
  expect(selectSkills).toHaveBeenCalledOnce();
});

test("preparation attachments use the existing context budget and leave an unattached request unchanged", () => {
  const harness = createMemoryRecallHarness({
    policy: "supervisor-worker-v1", enabled: false, decide: () => ({ action: "respond" }),
  });
  const options = {
    instructions: "A preparation contract.",
    format: createSupervisorPresentationFormat({ includeAcknowledgement: true, includeTitle: false }),
    diagnostic: { requestId: harness.request.requestId, modelStep: "supervisor.decision" as const, decisionPhase: "presentation" as const },
  };
  const withoutAttachments = buildSupervisorPreparationInput(harness.request, options);
  const request = createRequestExecutionScope({
    seed: { ...harness.request, attachments }, executionPolicy: harness.request.executionPolicy,
    createWorkerCapabilities: () => harness.request.workerCapabilities.provider,
  });
  const withAttachments = buildSupervisorPreparationInput(request, options);
  expect(withoutAttachments.context.messages.every((message) => message.attachments === undefined)).toBe(true);
  expect(withoutAttachments.context.budget.attachmentReserveTokens).toBe(0);
  expect(withAttachments.context.budget.attachmentReserveTokens).toBe(200);
  expect(withAttachments.context.budget.estimatedInputTokens - withoutAttachments.context.budget.estimatedInputTokens).toBe(200);
  expect(withAttachments.context.messages.map(({ role, content }) => ({ role, content })))
    .toEqual(withoutAttachments.context.messages);
});
