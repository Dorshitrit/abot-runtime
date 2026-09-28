import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import type { SchedulerRun } from "../scheduler/contracts.js";
import { LocalRequestExecution } from "../../web-ui/local-runtime/request-execution.js";
import { RealtimeClientHub } from "../../web-ui/local-runtime/realtime-hub.js";
import { LocalRuntimeApiRouter } from "../../web-ui/local-runtime/api-router.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture() {
  const requests = new LocalRequestExecution(new RealtimeClientHub());
  const router = new LocalRuntimeApiRouter(
    { defaultEnvironmentId: "prod", providerAdapters: {} as never },
    {
      get: (environmentId: string) => ({
        approvals: {
          list: async (sessionId?: string) =>
            requests.toolApprovals
              .list(environmentId)
              .filter((entry) => !sessionId || entry.sessionId === sessionId)
              .map((entry) => ({
                sessionId: entry.sessionId,
                run: {
                  requestId: entry.requestId,
                  sessionId: entry.sessionId,
                  environmentId,
                },
                request: {
                  requestId: entry.requestId,
                  approvalId: entry.approvalId,
                  call: { tool: entry.event.tool, params: {} },
                },
              })),
          decide: async (decision: Record<string, unknown>) => ({
            accepted: requests.toolApprovals.decide({
              ...decision,
              environmentId,
            } as never),
          }),
        },
        services: { sessions: { getRequestReplayById: async () => null } },
      }),
    } as never,
    requests,
  );
  const aborters: AbortController[] = [];
  const server = createServer((request, response) => {
    void router.handle(request, response).catch((error: Error) => {
      response.writeHead(500);
      response.end(error.message);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanup.push(async () => {
    for (const aborter of aborters) aborter.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  function pending(sessionId: string, environmentId = "prod") {
    const requestId = `${environmentId}-${sessionId}-request`;
    const approvalId = `${requestId}-approval`;
    const options = requests.scheduledRequestOptions({
      requestId,
      sessionId,
      environmentId,
    } as SchedulerRun);
    const aborter = new AbortController();
    aborters.push(aborter);
    requests.publishScheduled({
      type: "event",
      name: "tool.approval.required",
      requestId,
      sessionId,
      environment: environmentId,
      approvalId,
      tool: "system_command",
      meta: { command: "echo test-only", cwd: "/prepared" },
    });
    const decision = options.toolApprovalController!.requestToolApproval(
      {
        requestId,
        approvalId,
        call: { tool: "system_command", input: {} } as never,
      },
      { abortSignal: aborter.signal },
    );
    const scope = {
      approvalId,
      requestId,
      sessionId,
      environment: environmentId,
      approved: true,
    };
    return { scope, decision, cancel: () => aborter.abort() };
  }

  return {
    requests,
    pending,
    list: async (environment = "prod") => {
      const response = await fetch(
        `${origin}/web-api/chat/approvals?environment=${environment}`,
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.status).toBe(200);
      return response.json();
    },
    decide: (
      scope: Record<string, unknown>,
      headers = { "content-type": "application/json" },
    ) =>
      fetch(`${origin}/web-api/chat/approvals/${scope.approvalId}`, {
        method: "POST",
        headers,
        body: JSON.stringify(scope),
      }),
  };
}

describe("Home live approval HTTP authority", () => {
  test("discovers multiple unselected sessions through fresh HTTP reads and resolves only the chosen promise", async () => {
    const f = await fixture();
    const first = f.pending("first");
    const second = f.pending("second");
    f.pending("another-environment", "dev");
    const result = await f.list();
    expect(
      result.approvals.map((value: { sessionId: string }) => value.sessionId),
    ).toEqual(["first", "second"]);
    expect(result.approvals[0]).toMatchObject({
      environmentId: "prod",
      requestId: first.scope.requestId,
      approvalId: first.scope.approvalId,
      event: { meta: { command: "echo test-only", cwd: "/prepared" } },
    });
    expect((await f.list()).approvals).toEqual(result.approvals);
    expect((await f.decide({ ...second.scope, approved: false })).status).toBe(
      200,
    );
    expect(await second.decision).toEqual({ approved: false });
    expect(
      (await f.list()).approvals.map(
        (value: { sessionId: string }) => value.sessionId,
      ),
    ).toEqual(["first"]);
    expect((await f.decide(first.scope)).status).toBe(200);
    expect(await first.decision).toEqual({ approved: true });
    expect((await f.decide(first.scope)).status).toBe(409);
    expect((await f.list("dev")).approvals).toHaveLength(1);
  });

  test("rejects each stale or mismatched identity without consuming the live approval", async () => {
    const f = await fixture();
    const action = f.pending("chosen");
    for (const field of [
      "environment",
      "sessionId",
      "requestId",
      "approvalId",
    ]) {
      const response = await f.decide({
        ...action.scope,
        [field]: "different",
      });
      expect(response.status, field).toBe(409);
      expect((await f.list()).approvals).toHaveLength(1);
    }
    expect((await f.decide({ ...action.scope, approved: "true" })).status).toBe(
      400,
    );
    action.cancel();
    expect((await f.list()).approvals).toEqual([]);
    expect((await f.decide(action.scope)).status).toBe(409);
    expect(await action.decision).toMatchObject({ approved: false });
  });

  test("does not treat terminal or historical required events as pending authority", async () => {
    const f = await fixture();
    const action = f.pending("completed");
    f.requests.publishScheduled({
      type: "completed",
      requestId: action.scope.requestId,
      sessionId: action.scope.sessionId,
      environment: "prod",
      output: "fixture",
    });
    expect((await f.list()).approvals).toEqual([]);
    expect((await f.decide(action.scope)).status).toBe(409);
    f.requests.scheduledRequestOptions({
      requestId: "history",
      sessionId: "historical",
      environmentId: "prod",
    } as SchedulerRun);
    f.requests.publishScheduled({
      type: "event",
      name: "tool.approval.required",
      requestId: "history",
      sessionId: "historical",
      environment: "prod",
      approvalId: "past",
    });
    expect((await f.list()).approvals).toEqual([]);
  });

  test("requires same-origin JSON for a decision and preserves the legacy realtime promise", async () => {
    const f = await fixture();
    const action = f.pending("protected");
    const crossOrigin = await f.decide(action.scope, {
      "content-type": "application/json",
      origin: "https://other.example",
    } as never);
    expect(crossOrigin.status).toBe(403);
    expect(
      (await f.decide(action.scope, { "content-type": "text/plain" })).status,
    ).toBe(415);
    expect((await f.list()).approvals).toHaveLength(1);
    f.requests.resolveToolApproval({
      approvalId: action.scope.approvalId,
      approved: true,
    });
    expect(await action.decision).toEqual({
      approved: true,
      reason: undefined,
    });
    expect((await f.list()).approvals).toEqual([]);
  });
});
