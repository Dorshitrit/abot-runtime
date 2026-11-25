import { afterEach, expect, test, vi } from "vitest";
import { createAgentOrdinaryOwnerFixture } from "./support/agents-ordinary-owner-fixture.js";
import { resetDebugLoggerConfig } from "../observability/debug-logger.js";
const fixtures: Awaited<ReturnType<typeof createAgentOrdinaryOwnerFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0).reverse()) await fixture.dispose(); resetDebugLoggerConfig(); });

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)("%s uses the actual ordinary client and reads the unchanged loop result", async (policy) => {
  const f = await createAgentOrdinaryOwnerFixture(policy); fixtures.push(f);
  await f.port.createSession(f.request);
  const result = await f.port.run(f.request, new AbortController().signal);
  expect(result).toMatchObject({ status: "completed", output: "The scheduled answer preserves the earlier preference.", error: null });
  expect(result.usage).toEqual({ modelCalls: f.invoke.mock.calls.length, totalTokens: f.invoke.mock.calls.length * 30 });
  expect(result.receiptId).toEqual(expect.any(String));
  expect(f.call.mock.calls.filter(([method]) => method === "request.run")).toHaveLength(1);
  expect(await f.port.inspect(f.request)).toEqual(result);
  const saved = await f.sessions.getSessionById(f.request.sessionId);
  expect(saved?.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual([f.request.assignment]);
  expect(f.invoke.mock.calls.every(([input]) => input.modelPreference?.profileId === f.request.modelProfileId)).toBe(true);
}, 20000);

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)("%s approval stays owned by the existing runtime and resumes without Agent redispatch", async (policy) => {
  const f = await createAgentOrdinaryOwnerFixture(policy, true); fixtures.push(f);
  await f.port.createSession(f.request);
  expect((await f.port.run(f.request, new AbortController().signal)).status).toBe("awaiting_approval");
  expect(f.execute).not.toHaveBeenCalled();
  const [pending] = await f.port.listApprovals(f.request);
  expect(pending?.wait).toBeDefined();
  const decision = { approvalId: pending!.request.approvalId, ...pending!.wait!, approved: true, commandId: "agent-approval-a" };
  expect(await f.port.decideApproval(f.request, decision)).toEqual({ accepted: true });
  await vi.waitFor(async () => expect((await f.port.inspect(f.request)).status).toBe("completed"), { timeout: 5000 });
  expect(f.execute).toHaveBeenCalledOnce();
  expect(f.call.mock.calls.filter(([method]) => method === "request.run")).toHaveLength(1);
  expect((await f.port.inspect(f.request)).output).toBe("The requested fixture actions settled.");
  expect(await f.port.decideApproval(f.request, decision)).toMatchObject({ accepted: true, duplicate: true });
  expect(f.execute).toHaveBeenCalledOnce();
}, 20000);

test("cancels an existing durable approval wait through ordinary owner cancellation", async () => {
  const f = await createAgentOrdinaryOwnerFixture("execution-agent-v1", true); fixtures.push(f);
  await f.port.createSession(f.request);
  expect((await f.port.run(f.request, new AbortController().signal)).status).toBe("awaiting_approval");
  expect((await f.port.cancel!(f.request)).status).toBe("cancelled");
  expect(await f.port.listApprovals(f.request)).toEqual([]);
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.call.mock.calls.filter(([method]) => method === "request.run")).toHaveLength(1);
}, 20000);
