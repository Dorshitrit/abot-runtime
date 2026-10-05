import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { AutomationService } from "../automations/service.js";
import { AutomationRoutes } from "../../web-ui/local-runtime/automation-routes.js";

function responseFixture() {
  let status = 0;
  let body: Record<string, unknown> = {};
  const response = {
    writeHead(code: number) { status = code; },
    end(value: string) { body = JSON.parse(value) as Record<string, unknown>; },
    setHeader() {},
  } as unknown as ServerResponse;
  return { response, snapshot: () => ({ status, body }) };
}

describe("automation rerun route", () => {
  it("requires explicit confirmation and then forwards the key to the service", async () => {
    const rerun = vi.fn(async () => ({ id: "new-run", status: "pending" }));
    const routes = new AutomationRoutes(() => ({
      start: async () => undefined,
      services: { automations: { rerun } as unknown as AutomationService },
    }));
    const request = {
      headers: { "content-type": "application/json", host: "127.0.0.1:5177" },
      socket: {},
    } as unknown as IncomingMessage;
    const base = {
      method: "POST", segments: ["automation-runs", "old-run", "rerun"],
      url: new URL("http://127.0.0.1:5177/automation-runs/old-run/rerun?environment=dev"),
      environmentId: "dev", request,
    };
    const denied = responseFixture();
    expect(await routes.handle({ ...base,
      body: { idempotencyKey: "repeat-key" }, response: denied.response,
    })).toBe(true);
    expect(denied.snapshot()).toEqual({ status: 400, body: {
      ok: false, error: "automation_rerun_confirmation_required",
      message: "automation_rerun_confirmation_required",
    } });
    expect(rerun).not.toHaveBeenCalled();

    const accepted = responseFixture();
    expect(await routes.handle({ ...base,
      body: { idempotencyKey: "repeat-key", confirmed: true }, response: accepted.response,
    })).toBe(true);
    expect(rerun).toHaveBeenCalledExactlyOnceWith("old-run", "repeat-key", true);
    expect(accepted.snapshot()).toEqual({ status: 200, body: {
      ok: true, run: { id: "new-run", status: "pending" },
    } });
  });
});

describe("saved automation agent route", () => {
  it("requires draft revision and saves the selected node through the service", async () => {
    const saveAgentFromDraft = vi.fn(async () => ({ agentId: "agent-one", revision: 1 }));
    const routes = new AutomationRoutes(() => ({
      start: async () => undefined,
      services: { automations: { saveAgentFromDraft } as unknown as AutomationService },
    }));
    const request = {
      headers: { "content-type": "application/json", host: "127.0.0.1:5177" },
      socket: {},
    } as unknown as IncomingMessage;
    const base = {
      method: "POST", segments: ["automations", "automation-one", "agents"],
      url: new URL("http://127.0.0.1:5177/automations/automation-one/agents?environment=dev"),
      environmentId: "dev", request,
    };
    const denied = responseFixture();
    expect(await routes.handle({ ...base,
      body: { nodeId: "node-one" }, response: denied.response,
    })).toBe(true);
    expect(denied.snapshot().status).toBe(428);
    expect(saveAgentFromDraft).not.toHaveBeenCalled();

    const accepted = responseFixture();
    expect(await routes.handle({ ...base,
      body: { nodeId: "node-one", expectedRevision: 3 }, response: accepted.response,
    })).toBe(true);
    expect(saveAgentFromDraft).toHaveBeenCalledExactlyOnceWith({
      automationId: "automation-one", nodeId: "node-one", expectedDraftRevision: 3,
    });
    expect(accepted.snapshot()).toEqual({ status: 201, body: {
      ok: true, agent: { agentId: "agent-one", revision: 1 },
    } });
  });
});
