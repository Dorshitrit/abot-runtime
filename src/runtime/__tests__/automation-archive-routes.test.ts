import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { AutomationService } from "../automations/service.js";
import { AutomationRoutes } from "../../web-ui/local-runtime/automation-routes.js";
import { createLocalServiceClients } from "../local-host/client-services.js";
import { dispatchLocalServiceCall } from "../local-host/app-service-dispatch.js";
import type { RuntimeEnvironmentServices } from "../composition.js";

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
const request = {
  headers: { "content-type": "application/json", host: "127.0.0.1:5177" },
  socket: {},
} as unknown as IncomingMessage;

describe("automation archive routes and local facade", () => {
  it.each(["archive", "restore"] as const)("requires a revision and forwards %s to the owner", async (action) => {
    const draft = { automationId: "auto-one", revision: 4, archivedAt: "2026-09-29T12:00:00Z" };
    const operation = vi.fn(async () => draft);
    const service = { [action]: operation } as unknown as AutomationService;
    const routes = new AutomationRoutes(() => ({
      start: async () => undefined, services: { automations: service },
    }));
    const base = {
      method: "POST", segments: ["automations", "auto-one", action],
      url: new URL(`http://127.0.0.1:5177/automations/auto-one/${action}`),
      environmentId: "dev", request,
    };
    const missing = responseFixture();
    await routes.handle({ ...base, body: {}, response: missing.response });
    expect(missing.snapshot().status).toBe(428);
    expect(operation).not.toHaveBeenCalled();
    const accepted = responseFixture();
    await routes.handle({ ...base, body: { expectedRevision: 4 }, response: accepted.response });
    expect(operation).toHaveBeenCalledExactlyOnceWith("auto-one", 4);
    expect(accepted.snapshot()).toEqual({ status: 200, body: { ok: true, draft } });

    const services = { automations: service } as unknown as RuntimeEnvironmentServices;
    const clients = createLocalServiceClients((method, args) =>
      dispatchLocalServiceCall(services, method, args));
    await expect(clients.automations[action]("auto-one", 4)).resolves.toEqual(draft);
  });

  it.each(["automation_revision_conflict", "automation_run_active", "automation_not_published", "automation_archived"])(
    "returns a conflict for %s", async (code) => {
      const routes = new AutomationRoutes(() => ({
        start: async () => undefined,
        services: { automations: { archive: async () => { throw new Error(code); } } as unknown as AutomationService },
      }));
      const result = responseFixture();
      await routes.handle({
        method: "POST", segments: ["automations", "auto-one", "archive"],
        url: new URL("http://127.0.0.1:5177/automations/auto-one/archive"),
        body: { expectedRevision: 4 }, environmentId: "dev", request, response: result.response,
      });
      expect(result.snapshot()).toEqual({ status: 409, body: { ok: false, error: code, message: code } });
    },
  );
});
