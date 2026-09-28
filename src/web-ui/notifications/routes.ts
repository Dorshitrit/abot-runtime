import type { IncomingMessage, ServerResponse } from "node:http";
import { acceptConfigMutationRequest } from "../local-runtime/config-mutation-request.js";
import { readBody, readJsonBody, sendJson } from "../local-runtime/http.js";
import {
  NotificationInputError,
  type NotificationDesktopState,
  type NotificationListQuery,
  type NotificationPage,
  type NotificationPreferences,
  type NotificationReadChange,
  type NotificationReadResult,
} from "./contracts.js";
import { parseNotificationListQuery } from "./query.js";
import {
  parseNotificationEnvironment,
  parseNotificationPreferencesBody,
  parseNotificationReadBody,
} from "./request-input.js";

export type WebNotificationAccess = {
  hasEnvironment(id: string): boolean;
  list(id: string, query: NotificationListQuery): Promise<NotificationPage>;
  desktop(
    id: string,
  ): NotificationDesktopState | Promise<NotificationDesktopState>;
  markRead(
    id: string,
    change: NotificationReadChange,
  ): Promise<NotificationReadResult>;
  setPreferences(
    id: string,
    preferences: NotificationPreferences,
  ): Promise<NotificationPreferences>;
};

const notificationPaths = [
  "/web-api/notifications",
  "/web-api/notifications/read",
  "/web-api/notifications/preferences",
];

function isNotificationListRequest(
  path: string,
  method: string | undefined,
): boolean {
  if (path !== "/web-api/notifications") return false;
  return method === "GET";
}

function isNotificationReadRequest(
  path: string,
  method: string | undefined,
): boolean {
  if (path !== "/web-api/notifications/read") return false;
  return method === "POST";
}

function isNotificationPreferencesRequest(
  path: string,
  method: string | undefined,
): boolean {
  if (path !== "/web-api/notifications/preferences") return false;
  return method === "PUT";
}

function assertNotificationMutationHasNoQuery(url: URL): void {
  if (!url.search) return;
  throw new NotificationInputError(
    "Notification mutations accept their environment in the JSON body.",
  );
}

function rejectUnknownNotificationEnvironment(
  access: WebNotificationAccess,
  id: string,
  response: ServerResponse,
): boolean {
  if (access.hasEnvironment(id)) return false;
  sendJson(response, 404, {
    ok: false,
    error: "notification_environment_not_found",
    message: "Notification environment not found.",
  });
  return true;
}

async function readNotificationMutationBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  try {
    return readJsonBody(await readBody(request, { maxBytes: 64 * 1024 }));
  } catch (error) {
    if (error instanceof Error && error.message === "request_body_too_large")
      throw new NotificationInputError("Notification request is too large.");
    throw new NotificationInputError("A JSON object body is required.");
  }
}

export class WebNotificationRoutes {
  constructor(private readonly access: WebNotificationAccess) {}

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    pathname?: string,
  ): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://notification.local");
    const path = pathname ?? url.pathname;
    if (!notificationPaths.includes(path)) return false;
    response.setHeader("cache-control", "private, no-store");
    try {
      await this.dispatch(request, response, url, path);
    } catch (error) {
      if (error instanceof NotificationInputError) {
        sendJson(response, 400, {
          ok: false,
          error: "invalid_notification_request",
          message: error.message,
        });
        return true;
      }
      sendJson(response, 503, {
        ok: false,
        error: "notification_storage_unavailable",
        message:
          "Notification history is unavailable. Stored history has been preserved.",
      });
    }
    return true;
  }

  private async dispatch(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    path: string,
  ): Promise<void> {
    if (isNotificationListRequest(path, request.method)) {
      const query = parseNotificationListQuery(url.searchParams);
      const environmentId = parseNotificationEnvironment(
        url.searchParams.get("environment"),
      );
      if (
        rejectUnknownNotificationEnvironment(
          this.access,
          environmentId,
          response,
        )
      )
        return;
      const page = await this.access.list(environmentId, query);
      const desktop = await this.access.desktop(environmentId);
      sendJson(response, 200, { ok: true, ...page, desktop });
      return;
    }
    if (isNotificationReadRequest(path, request.method)) {
      if (!acceptConfigMutationRequest(request, response)) return;
      assertNotificationMutationHasNoQuery(url);
      const { environmentId, change } = parseNotificationReadBody(
        await readNotificationMutationBody(request),
      );
      if (
        rejectUnknownNotificationEnvironment(
          this.access,
          environmentId,
          response,
        )
      )
        return;
      sendJson(response, 200, {
        ok: true,
        ...(await this.access.markRead(environmentId, change)),
      });
      return;
    }
    if (isNotificationPreferencesRequest(path, request.method)) {
      if (!acceptConfigMutationRequest(request, response)) return;
      assertNotificationMutationHasNoQuery(url);
      const { environmentId, preferences } = parseNotificationPreferencesBody(
        await readNotificationMutationBody(request),
      );
      if (
        rejectUnknownNotificationEnvironment(
          this.access,
          environmentId,
          response,
        )
      )
        return;
      sendJson(response, 200, {
        ok: true,
        preferences: await this.access.setPreferences(
          environmentId,
          preferences,
        ),
      });
      return;
    }
    sendJson(response, 405, {
      ok: false,
      error: "notification_method_not_allowed",
      message: "Notification method not allowed.",
    });
  }
}
