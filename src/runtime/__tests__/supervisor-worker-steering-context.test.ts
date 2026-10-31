import { afterEach, beforeEach, expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { projectRoleChildReturnContext } from "../orchestration/role-calls/child-return.js";
import type { SupervisorResumeContext } from "../steps/supervisor-decision/contracts.js";
import {
  buildSupervisorContinuationPart, hasSupervisorWorkerSteeringHandoff,
} from "../steps/supervisor-decision/resume.js";
import { buildSupervisorResponseInput } from "../steps/supervisor-response/input.js";
import {
  activeCoreSkillCall, commitSkillFixture, createCoreSkillContextFixture,
} from "./support/core-skill-read-context-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

async function fixture() {
  const f = await createCoreSkillContextFixture();
  const worker = await f.open("worker");
  const committed = await commitSkillFixture(f.ledger, {
    authority: "runtime", type: "return_child", callerCallId: worker.parentCallId,
    childCallId: worker.callId, outcome: "yielded", steeringVersion: 1,
    summary: "Control returned after an accepted user update.",
  });
  return { ...f, resume: projectRoleChildReturnContext(f.ledger, committed) };
}

function continuation(resume: SupervisorResumeContext) {
  return {
    resume, currentCallId: resume.callerCallId,
    currentInvocationAttempt: resume.invocationAttempt,
  };
}

function instructions(input: { context: { messages: readonly ChatMessage[] } }) {
  return input.context.messages.find(({ role }) => role === "system")!.content;
}

function childResults(messages: readonly ChatMessage[]) {
  return messages.flatMap(({ content }) => {
    try {
      const parsed = JSON.parse(content);
      return parsed.kind === "runtime_child_result" ? [parsed] : [];
    } catch { return []; }
  });
}

test("steering handoff requires the exact current Worker return and caller activation", async () => {
  const { resume } = await fixture();
  expect(hasSupervisorWorkerSteeringHandoff(continuation(resume))).toBe(true);
  for (const changed of [
    { currentCallId: "different-caller" },
    { currentInvocationAttempt: resume.invocationAttempt + 1 },
    { resume: { ...resume, returnedChildCallId: "different-child" } },
    { resume: { ...resume, returnedResultRef: "different-result" } },
    { resume: { ...resume, completedChildren: resume.completedChildren.map((child) => ({
      ...child, callerCallId: "different-caller",
    })) } },
    { resume: { ...resume, completedChildren: resume.completedChildren.map((child) => ({
      ...child, steeringVersion: 0,
    })) } },
  ]) {
    expect(() => hasSupervisorWorkerSteeringHandoff({ ...continuation(resume), ...changed }))
      .toThrow(/supervisor_resume_/);
  }
});

test("full and compact continuations retain the bound handoff without changing its authority", async () => {
  const { resume } = await fixture();
  const part = buildSupervisorContinuationPart(continuation(resume));
  for (const messages of [part.messages, part.compactMessages!]) {
    expect(childResults(messages)).toEqual([expect.objectContaining({
      callerCallId: resume.callerCallId, childCallId: resume.returnedChildCallId,
      resultRef: resume.returnedResultRef, roleId: "worker", outcome: "yielded", steeringVersion: 1,
    })]);
    expect(messages.filter(({ role }) => role === "system")).toEqual([]);
  }
});

test("the decision handoff and its evidence survive a Skill-read continuation", async () => {
  const f = await fixture();
  const initial = f.input({ resume: f.resume });
  await f.read();
  const call = activeCoreSkillCall(f.ledger);
  const resume = { ...f.resume, invocationAttempt: call.activationCount };
  const afterRead = f.input({ resume });
  expect(hasSupervisorWorkerSteeringHandoff(continuation(resume))).toBe(true);
  expect(instructions(afterRead)).toEqual(instructions(initial));
  expect(childResults(afterRead.context.messages)).toEqual(childResults(initial.context.messages));
  expect(JSON.stringify(afterRead.context.messages)).toContain("runtime_core_skill_read_v1");
});

test("only the current yielded result changes decision and response instructions", async () => {
  const f = await fixture();
  const yieldedDecision = f.input({ resume: f.resume });
  const response = (resume: SupervisorResumeContext) => buildSupervisorResponseInput(f.request, {
    call: {
      rootCallId: resume.callerCallId, callId: resume.callerCallId, parentCallId: null,
      depth: 0, invocationAttempt: resume.invocationAttempt,
    },
    resume, toolResults: f.toolResults(),
  });
  const yieldedResponse = response(f.resume);
  expect(childResults(yieldedResponse.context.messages)).toEqual([expect.objectContaining({
    outcome: "yielded", steeringVersion: 1, childCallId: f.resume.returnedChildCallId,
  })]);

  await f.open("worker");
  const completed = await f.finish();
  const currentOnly = { ...completed, completedChildren: completed.completedChildren.slice(-1) };
  expect(hasSupervisorWorkerSteeringHandoff(continuation(completed))).toBe(false);
  expect(instructions(f.input({ resume: completed })))
    .toEqual(instructions(f.input({ resume: currentOnly })));
  expect(instructions(response(completed))).toEqual(instructions(response(currentOnly)));
  expect(instructions(yieldedDecision)).not.toEqual(instructions(f.input({ resume: completed })));
  expect(instructions(yieldedResponse)).not.toEqual(instructions(response(completed)));

  const summaryOnly = { ...currentOnly, completedChildren: currentOnly.completedChildren.map((child) => ({
    ...child, summary: "Worker yielded; please confirm whether to continue.",
  })) };
  expect(instructions(f.input({ resume: summaryOnly })))
    .toEqual(instructions(f.input({ resume: currentOnly })));
  expect(instructions(response(summaryOnly))).toEqual(instructions(response(currentOnly)));
});
