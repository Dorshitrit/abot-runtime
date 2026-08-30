import type { IncomingMessage, ServerResponse } from "node:http";

import type { LongTermMemoryOnboardingService } from "../../runtime/long-term-memory/onboarding/contracts.js";
import { getString, sendJson } from "./http.js";
import { withHttpRequestAbortSignal } from "./request-abort.js";

type JsonBody = Record<string, unknown> | null;

export class LongTermMemoryOnboardingRoutes {
  constructor(private readonly service: LongTermMemoryOnboardingService) {}

  async handle(params: {
    method: string;
    route: string;
    url: URL;
    body: JsonBody;
    request: IncomingMessage;
    response: ServerResponse;
  }): Promise<boolean> {
    try {
      return await this.handleKnownRoute(params);
    } catch (error) {
      sendJson(params.response, readErrorStatus(error), {
        ok: false,
        error: "long_term_memory_onboarding_failed",
        message: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }

  private async handleKnownRoute(params: {
    method: string;
    route: string;
    url: URL;
    body: JsonBody;
    request: IncomingMessage;
    response: ServerResponse;
  }): Promise<boolean> {
    if (params.method === "GET" && params.route === "runtime/memory") {
      sendJson(params.response, 200, {
        ok: true,
        status: await this.service.status(),
      });
      return true;
    }
    if (
      params.method === "GET" &&
      params.route === "runtime/memory/models"
    ) {
      const providerId = params.url.searchParams.get("provider") ?? "";
      sendJson(params.response, 200, {
        ok: true,
        catalog: await withHttpRequestAbortSignal({
          request: params.request,
          response: params.response,
          reason: "memory_onboarding_discovery_request_aborted",
          run: (abortSignal) =>
            this.service.discover({ providerId, abortSignal }),
        }),
      });
      return true;
    }
    if (
      params.method === "POST" &&
      params.route === "runtime/memory/enable"
    ) {
      const result = await withHttpRequestAbortSignal({
        request: params.request,
        response: params.response,
        reason: "memory_onboarding_enable_request_aborted",
        run: (abortSignal) =>
          this.service.enable({
            providerId: getString(params.body?.providerId),
            model: getString(params.body?.model),
            ...(getString(params.body?.profileId)
              ? { profileId: getString(params.body?.profileId) }
              : {}),
            emitClientEvents: params.body?.emitClientEvents === true,
            abortSignal,
          }),
      });
      sendJson(params.response, 200, { ok: true, ...result });
      return true;
    }
    if (
      params.method === "POST" &&
      params.route === "runtime/memory/disable"
    ) {
      sendJson(params.response, 200, {
        ok: true,
        ...(await this.service.disable()),
      });
      return true;
    }
    return false;
  }
}

function readErrorStatus(error: unknown): number {
  if (!error || typeof error !== "object" || !("statusCode" in error)) {
    return 400;
  }
  const statusCode = Number(error.statusCode);
  return Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599
    ? statusCode
    : 400;
}
