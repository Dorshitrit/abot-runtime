import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ConfigFileConflictError } from "../adapters/config-file-transaction.js";
import { StepTimeoutRoutes } from "../../web-ui/local-runtime/step-timeout-routes.js";
import {
  StepTimeoutService,
  StepTimeoutSuggestionError,
} from "../../web-ui/local-runtime/step-timeout-service.js";

let origin: string;
let close: () => Promise<void>;
const inspect = vi.fn();
const increase = vi.fn();
const reference = {
  environment: "dev",
  sessionId: "session",
  requestId: "request",
  invocationId: "invocation",
};
const path = "/runtime/config/step-timeout";
const query = new URLSearchParams(reference);

beforeEach(async () => {
  inspect.mockReset().mockResolvedValue({ suggestion: { canIncrease: true } });
  increase
    .mockReset()
    .mockResolvedValue({
      status: "saved",
      timeoutMs: 180_000,
      restartRequired: true,
    });
  const routes = new StepTimeoutRoutes({
    inspect,
    increase,
  } as unknown as StepTimeoutService);
  const server = createServer((request, response) => {
    const url = new URL(request.url!, origin);
    void routes
      .handle({
        method: request.method!,
        route: url.pathname.slice(1),
        request,
        response,
        url,
      })
      .then((handled) => {
        if (handled) return;
        response.writeHead(404);
        response.end();
      });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = async () => {
    server.closeAllConnections();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
  };
});
afterEach(async () => close());

describe("passive timeout suggestion HTTP boundary", () => {
  test("GET reads the invocation tuple without modifying settings", async () => {
    const response = await fetch(`${origin}${path}?${query}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: true,
      suggestion: { canIncrease: true },
    });
    expect(inspect).toHaveBeenCalledExactlyOnceWith(reference);
    expect(increase).not.toHaveBeenCalled();
  });

  test("POST passes only explicit JSON to the save service", async () => {
    const input = { ...reference, expectedRevision: "current.replacement" };
    const response = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      status: "saved",
      timeoutMs: 180_000,
      restartRequired: true,
    });
    expect(increase).toHaveBeenCalledExactlyOnceWith(input);
    expect(inspect).not.toHaveBeenCalled();
  });

  test.each([
    [
      {
        "content-type": "application/json",
        origin: "https://untrusted.invalid",
      },
      403,
    ],
    [{ "content-type": "text/plain" }, 415],
  ])("rejects unsafe mutation headers %j", async (headers, status) => {
    const response = await fetch(`${origin}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(reference),
    });
    expect(response.status).toBe(status);
    expect(increase).not.toHaveBeenCalled();
  });

  test("returns configuration conflicts without exposing configuration contents", async () => {
    increase.mockRejectedValue(new ConfigFileConflictError());
    const response = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reference),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "config_changed",
    });
  });

  test("preserves receipt lookup failures and rejects unsupported methods", async () => {
    inspect.mockRejectedValue(
      new StepTimeoutSuggestionError(
        "timeout_not_found",
        "No matching timeout.",
        404,
      ),
    );
    const missing = await fetch(`${origin}${path}?${query}`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "timeout_not_found" });
    const unsupported = await fetch(`${origin}${path}`, { method: "DELETE" });
    expect(unsupported.status).toBe(405);
    expect(increase).not.toHaveBeenCalled();
  });
});
