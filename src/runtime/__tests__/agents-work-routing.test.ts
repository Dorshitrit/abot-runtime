import { afterEach, describe, expect, test } from "vitest";
import { join } from "node:path";
import type { ChatMessage } from "../../model-gateway/types.js";
import { validateJsonSchemaValue } from "../model/json-schema-value.js";
import type { ModelGatewayClient } from "../ports.js";
import { createAgentApplication } from "../agents/application-service.js";
import { FileAgentStateStore } from "../agents/file-store.js";
import type { AgentActionPlan } from "../agents/workspace-records.js";
import { agentApplicationFixture, applicationPlan, returnedWorkDecision, completedAgentWork, disposeAgentApplicationFixtures, trackAgentApplication } from "./support/agents-application-fixture.js";

afterEach(disposeAgentApplicationFixtures, 20_000);

type Context = {
  mission: { id: string; criteria: { id: string }[] };
  acceptedPlan?: AgentActionPlan;
  assessment?: { text: string };
};
type ReturnedWork = { attemptId: string; assignment: string; outcome: string; error: string | null; text: string; sessionId: string };
type History = { entries: { role: string; text: string }[] };

function records<T>(messages: ChatMessage[], kind: string): T[] {
  return messages.flatMap(({ role, content }) => {
    if (role !== "system" || !content.startsWith("{")) return [];
    const record = JSON.parse(content);
    return record.kind === kind ? [record as T] : [];
  });
}

const seedRequest = "Make a pantry list with fennel and oats.";
const reminder = "Which warehouse should receive this inventory update?";
const confirmation = "Saved the pantry list to the North warehouse.";
const alternateLookup = "Look up the warehouse from the authorized invoice.";
const bulletList = (items: string[]) => items.map(item => "- " + item).join("\n");
const seedList = bulletList(["fennel", "oats"]);
const revisedList = bulletList(["fennel", "oats", "lentils"]);

// This provider has access only to messages delivered across the model boundary.
const pantryModel: ModelGatewayClient["invoke"] = async input => {
  const messages = input.messages as ChatMessage[];
  const context = records<Context>(messages, "agent_context_v1")[0]!;
  const receipt = records<ReturnedWork>(messages, "agent_work_result_v1")[0];
  const users = messages.filter(message => message.role === "user").map(message => message.content);
  const request = users[0]!;
  const history = records<History>(messages, "agent_conversation_history_v1")[0]?.entries ?? [];
  const previous = history.filter(message => message.role === "assistant" && message.text.startsWith("- ")).at(-1);
  const lastRequest = history.filter(message => message.role === "user").at(-1);
  const referencedItem = request.match(/^"(.+)" too\.$/)?.[1];
  const addedItem = request.match(/^Add (\w+)/)?.[1] ??
    (lastRequest?.text === "Add lentils." ? referencedItem : undefined);
  const updated = previous && addedItem ? previous.text + "\n- " + addedItem : undefined;
  const external = request.includes("external inventory");
  function decide() {
    if (receipt) {
      if (receipt.error === "request_blocked" && request.includes("use my invoice as a fallback")) {
        return returnedWorkDecision("continue_session", alternateLookup);
      }
      return returnedWorkDecision("answer_user", "Report the recorded outcome.");
    }
    if (updated && !external) return applicationPlan("answer_user");
    return applicationPlan("start_session");
  }

  let text: string;
  if (input.format) text = JSON.stringify({ decision: decide() });
  else if (context.acceptedPlan) {
    switch (context.acceptedPlan.action) {
      case "answer_user": text = receipt ? "Inventory report: " + receipt.text : updated || "No list supplied."; break;
      case "start_session":
      case "continue_session": {
        const fallback = receipt?.error === "request_blocked" && context.acceptedPlan.reason === alternateLookup;
        text = [request, updated, fallback && alternateLookup].filter(Boolean).join("\n");
        break;
      }
      default: throw new Error("Unexpected authored action " + context.acceptedPlan.action);
    }
  } else if (request === seedRequest) {
    const items = request.match(/with (.+)\.$/)![1]!.split(" and ");
    text = bulletList(items);
  } else {
    const assessment = decide();
    text = assessment.reason;
  }
  return { text, meta: { usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 } } };
};

for (const policy of ["execution-agent-v1", "supervisor-worker-v1"] as const) {
  describe(policy, () => {
    async function pantry() {
      const fixture = await agentApplicationFixture({ policy });
      fixture.invoke.mockImplementation(pantryModel);
      await fixture.app.send("agent-a", { messageId: "pantry", text: seedRequest, intent: "message" });
      await fixture.app.whenIdle();
      expect((await fixture.app.detail("agent-a")).messages.at(-1)?.text).toBe(seedList);
      return fixture;
    }

    test("edits a list in the conversation and reopens the full amended list without a work session", async () => {
      const f = await pantry();
      await f.app.send("agent-a", { messageId: "edit", text: "Add lentils.", intent: "auto" });
      await f.app.whenIdle();
      const detail = await f.app.detail("agent-a");
      expect(detail.responsibility.map(trace => trace.plan.action)).toEqual(["answer_user"]);
      expect(detail.messages.at(-1)).toMatchObject({ role: "assistant", text: revisedList });
      expect(detail.mission?.status).toBe("completed");
      await f.app.shutdown();
      const reopened = trackAgentApplication(createAgentApplication({ ...f.dependencies,
        store: new FileAgentStateStore(join(f.dependencies.config.paths.runtimeDir, "agents", "state.json")) }));
      await reopened.recover();
      expect((await reopened.detail("agent-a")).messages.at(-1)?.text).toBe(revisedList);
      await reopened.send("agent-a", { messageId: "more", text: "Add basil.", intent: "auto" });
      await reopened.whenIdle();
      expect((await reopened.detail("agent-a")).messages.at(-1)?.text).toBe(revisedList + "\n- basil");
      expect(f.createSession).not.toHaveBeenCalled();
      expect(f.run).not.toHaveBeenCalled();
    }, 20_000);

    test.each([
      { request: '"Check emergency stock" too.', executes: false },
      { request: "Now please check emergency stock in the warehouse.", executes: true },
    ])("carries the prior edit into a follow-up while honoring a new operation: $request", async ({ request, executes }) => {
      const f = await pantry();
      await f.app.send("agent-a", { messageId: "edit", text: "Add lentils.", intent: "auto" });
      await f.app.whenIdle();
      f.invoke.mockClear();
      await f.app.send("agent-a", { messageId: "follow-up", text: request, intent: "auto" });
      await f.app.whenIdle();

      const calls = f.invoke.mock.calls.map(([input]) => input.messages as ChatMessage[]);
      const requestCalls = calls.filter(messages => records(messages, "agent_work_result_v1").length === 0);
      expect(requestCalls).toHaveLength(policy === "supervisor-worker-v1" ? 3 : 2);
      for (const messages of requestCalls) {
        expect(messages.filter(message => message.role === "user").map(message => message.content)).toEqual([request]);
        const history = records<History>(messages, "agent_conversation_history_v1")[0]!;
        expect(history.entries.slice(-2)).toMatchObject([
          { role: "user", text: "Add lentils." }, { role: "assistant", text: revisedList },
        ]);
      }
      const detail = await f.app.detail("agent-a");
      const actions = detail.responsibility.filter(trace => trace.missionId === detail.mission!.id).map(trace => trace.plan.action);
      if (executes) {
        expect(actions).toEqual(["start_session", "answer_user"]);
        expect(f.run).toHaveBeenCalledOnce();
        expect(f.run.mock.calls[0]![0].assignment.startsWith(request + "\n\n")).toBe(true);
        expect(detail.messages.at(-1)?.text).toBe("Inventory report: " + completedAgentWork.output);
      } else {
        expect(actions).toEqual(["answer_user"]);
        expect(f.createSession).not.toHaveBeenCalled();
        expect(f.run).not.toHaveBeenCalled();
        expect(detail.messages.at(-1)?.text).toBe(revisedList + "\n- Check emergency stock");
      }
    }, 20_000);

    test("continues a blocked session when the user already authorized a different way to obtain the prerequisite", async () => {
      const f = await pantry();
      const receipt = confirmation + " https://inventory.example.test/receipts/from-invoice";
      f.run.mockImplementation(async request => request.assignment.includes(alternateLookup)
        ? { ...completedAgentWork, output: receipt, receiptId: "inventory-write" }
        : { ...completedAgentWork, status: "failed", error: "request_blocked", output: reminder, receiptId: "needs-warehouse" });
      await f.app.send("agent-a", { messageId: "fallback", intent: "auto",
        text: "Add lentils to the external inventory. If the warehouse is missing, use my invoice as a fallback." });
      await f.app.whenIdle();
      const detail = await f.app.detail("agent-a");
      expect(detail.responsibility.map(trace => trace.plan.action)).toEqual(["start_session", "continue_session", "answer_user"]);
      expect(detail.responsibility[1]?.plan.reason).toBe(alternateLookup);
      expect(detail.mission?.status).toBe("completed");
      expect(detail.messages.at(-1)?.text).toBe("Inventory report: " + receipt);
      expect(f.createSession).toHaveBeenCalledOnce();
      expect(f.run).toHaveBeenCalledTimes(2);
      const [initial, fallback] = f.run.mock.calls.map(([request]) => request);
      expect(fallback!.sessionId).toBe(initial!.sessionId);
      expect(initial!.assignment).not.toContain(alternateLookup);
      expect(fallback!.assignment).toContain(alternateLookup);
    }, 20_000);

    test.each([
      { status: "completed", error: null, output: "One candidate found; shipping could not be verified." },
      { status: "failed", error: "request_blocked", output: reminder },
      { status: "cancelled", error: "request_cancelled", output: "Cancelled after reading the source." },
    ] as const)("returns the authored $status outcome once without asking for a decision", async result => {
      const f = await pantry();
      f.run.mockResolvedValue({ ...completedAgentWork, ...result });
      await f.app.send("agent-a", { messageId: "publish", text: "Add lentils to the external inventory.", intent: "auto" });
      await f.app.whenIdle();
      const done = await f.app.detail("agent-a");
      const attempt = done.attempts[0]!;
      expect(done.responsibility.map(trace => trace.plan.action)).toEqual(["start_session", "answer_user"]);
      expect(done.responsibility.at(-1)?.plan).toMatchObject({ evidenceIds: [attempt.id], metCriteriaIds: [] });
      expect(done.mission).toMatchObject({ status: "completed", waitingReason: null, usage: { attempts: 1, clarificationRounds: 0 } });
      expect(done.messages.filter(message => message.missionId === done.mission!.id && message.role === "assistant"))
        .toMatchObject([{ purpose: "reply", text: "Inventory report: " + result.output }]);

      const selection = f.invoke.mock.calls.map(([input]) => input).filter(input => typeof input.format === "object" && input.format.name === "persistent_agent_work_result_v1");
      expect(selection).toHaveLength(1);
      const format = selection[0]!.format;
      if (typeof format !== "object") throw new Error("Missing work-result schema");
      const schema = format.schema as Record<string, unknown>;
      for (const action of ["answer_user", "continue_session"] as const) {
        expect(validateJsonSchemaValue(schema, { decision: returnedWorkDecision(action) })).toBeUndefined();
      }
      for (const action of ["complete", "ask_user", "wait", "start_session", "delegate_agent", "read_evidence"]) {
        expect(validateJsonSchemaValue(schema, { decision: { action, reason: "Change direction" } })).toBeDefined();
      }
      expect(validateJsonSchemaValue(schema, { decision: { ...returnedWorkDecision("continue_session"), sessionId: "other-session" } })).toBeDefined();
      const returnedCalls = f.invoke.mock.calls.map(([input]) => input.messages as ChatMessage[])
        .filter(messages => records<ReturnedWork>(messages, "agent_work_result_v1").length > 0);
      expect(returnedCalls).toHaveLength(policy === "execution-agent-v1" ? 2 : 3);
      for (const messages of returnedCalls) {
        expect(records<ReturnedWork>(messages, "agent_work_result_v1")).toMatchObject([{
          attemptId: attempt.id, assignment: f.run.mock.calls[0]![0].assignment, text: result.output, outcome: result.status,
        }]);
      }
      await f.app.shutdown();
      const reopened = trackAgentApplication(createAgentApplication({ ...f.dependencies }));
      await reopened.recover(); await reopened.refresh("agent-a"); await reopened.whenIdle();
      expect((await reopened.detail("agent-a")).messages).toEqual(done.messages);
      expect(f.createSession).toHaveBeenCalledOnce();
      expect(f.run).toHaveBeenCalledOnce();
    }, 20_000);
  });
}
