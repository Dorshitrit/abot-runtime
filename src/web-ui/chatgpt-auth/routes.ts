import type { ChatGptCallbackFactory } from "../../provider-auth/chatgpt/callback.js";
import { ChatGptWebAttemptOwner } from "./attempt-owner.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  getChatGptAuthService,
  type ChatGptAuthService,
} from "../../provider-auth/chatgpt/service.js";
import {
  ChatGptAuthError,
  authFailure,
  type ChatGptPurpose,
} from "../../provider-auth/chatgpt/contracts.js";
import { isLocalNativeFileRequest } from "../local-runtime/conversation-file-native-request.js";
import {
  assertConfigMutationRequest,
  ConfigMutationRequestError,
} from "../local-runtime/config-mutation-request.js";
import { readBody, sendJson } from "../local-runtime/http.js";
async function attemptOptions(
  request: IncomingMessage,
): Promise<{ accountRef?: string; purpose?: ChatGptPurpose }> {
  const text = (await readBody(request, { maxBytes: 2048 })).toString("utf8");
  let value: unknown;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    throw new ChatGptAuthError(
      "chatgpt_request_invalid",
      "Send a valid sign-in request.",
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ChatGptAuthError(
      "chatgpt_request_invalid",
      "Send a valid sign-in request.",
    );
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => key !== "accountRef" && key !== "purpose"))
    throw new ChatGptAuthError(
      "chatgpt_request_invalid",
      "Unsupported sign-in field.",
    );
  if (row.accountRef !== undefined && typeof row.accountRef !== "string")
    throw new ChatGptAuthError(
      "chatgpt_request_invalid",
      "Choose a saved account.",
    );
  if (
    row.purpose !== undefined &&
    row.purpose !== "sign_in" &&
    row.purpose !== "enable_plan_usage"
  )
    throw new ChatGptAuthError(
      "chatgpt_request_invalid",
      "Choose a supported sign-in action.",
    );
  return {
    ...(row.accountRef !== undefined ? { accountRef: row.accountRef } : {}),
    ...(row.purpose !== undefined ? { purpose: row.purpose } : {}),
  };
}
type ChatGptAuthRouteOptions = {
  isLocalRequest?: (request: IncomingMessage) => boolean;
  callbackFactory?: (request: IncomingMessage) => ChatGptCallbackFactory | undefined;
};
export class ChatGptAuthRoutes {
  private readonly attempts: ChatGptWebAttemptOwner;
  constructor(
    private readonly service: ChatGptAuthService = getChatGptAuthService(),
    private readonly options: ChatGptAuthRouteOptions = {},
  ) { this.attempts = new ChatGptWebAttemptOwner(service); }
  close(): void { this.attempts.close(); }
  async handle(
    route: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> {
    if (!route.startsWith("runtime/chatgpt/")) return false;
    response.setHeader("cache-control", "private, no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("cross-origin-resource-policy", "same-origin");
    const abort = new AbortController();
    const cancel = () => abort.abort();
    response.once("close", cancel);
    try {
      if (!(this.options.isLocalRequest ?? isLocalNativeFileRequest)(request))
        throw new ChatGptAuthError(
          "chatgpt_local_only",
          "Manage ChatGPT accounts from ABot on this computer.",
          403,
        );
      if (request.method !== "GET") assertConfigMutationRequest(request);
      const parts = route.split("/").slice(2);
      const method = request.method;
      if (parts.length === 1 && parts[0] === "accounts" && method === "GET") {
        sendJson(response, 200, {
          ok: true,
          accounts: await this.service.listAccounts(),
        });
        return true;
      }
      if (parts.length === 1 && parts[0] === "attempts" && method === "POST") {
        const options = await attemptOptions(request);
        const callbackFactory = this.options.callbackFactory?.(request);
        sendJson(response, 200, {
          ok: true,
          attempt: await this.attempts.start(() => this.service.beginAttempt(options, callbackFactory)),
        });
        return true;
      }
      if (
        parts.length === 3 &&
        parts[0] === "attempts" &&
        parts[2] === "retry" &&
        method === "POST"
      ) {
        sendJson(response, 200, {
          ok: true,
          attempt: await this.attempts.start(() => this.service.retryAttempt(parts[1]!, this.options.callbackFactory?.(request))),
        });
        return true;
      }
      if (parts.length === 2 && parts[0] === "attempts" && method === "GET") {
        sendJson(response, 200, {
          ok: true,
          attempt: this.service.getAttempt(parts[1]!),
        });
        return true;
      }
      if (
        parts.length === 2 &&
        parts[0] === "attempts" &&
        method === "DELETE"
      ) {
        sendJson(response, 200, {
          ok: true,
          attempt: this.service.cancelAttempt(parts[1]!),
        });
        return true;
      }
      if (
        parts.length === 3 &&
        parts[0] === "accounts" &&
        parts[2] === "disconnect" &&
        method === "POST"
      ) {
        sendJson(response, 200, {
          ok: true,
          result: await this.service.disconnect(parts[1]!),
        });
        return true;
      }
      if (
        parts.length === 3 &&
        parts[0] === "accounts" &&
        parts[2] === "acknowledge-plan" &&
        method === "POST"
      ) {
        sendJson(response, 200, {
          ok: true,
          account: await this.service.acknowledgePlan(parts[1]!),
        });
        return true;
      }
      if (
        parts.length === 3 &&
        parts[0] === "accounts" &&
        parts[2] === "models" &&
        method === "GET"
      ) {
        sendJson(response, 200, {
          ok: true,
          models: await this.service.listModels(parts[1]!, abort.signal),
        });
        return true;
      }
      throw new ChatGptAuthError(
        "chatgpt_route_not_found",
        "This ChatGPT account action is unavailable.",
        404,
      );
    } catch (error) {
      const failure =
        error instanceof ConfigMutationRequestError
          ? new ChatGptAuthError(
              "chatgpt_request_rejected",
              error.message,
              error.statusCode,
            )
          : authFailure(error);
      sendJson(response, failure.statusCode, {
        ok: false,
        error: failure.code,
        message: failure.message,
      });
    } finally {
      response.removeListener("close", cancel);
    }
    return true;
  }
}
