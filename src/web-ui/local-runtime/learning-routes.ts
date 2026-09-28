import type { IncomingMessage, ServerResponse } from "node:http";
import type { PassiveLearningManagement } from "../../runtime/local-host/client-learning.js";
import type { PassiveLearningPreferences } from "../../runtime/passive-learning/contracts.js";
import { acceptConfigMutationRequest } from "./config-mutation-request.js";
import { sendJson } from "./http.js";
import { readLearningPreferencesInput } from "../../runtime/local-host/learning-preferences-input.js";
import { isLearningEventId } from "../../runtime/local-host/learning-events.js";

type LearningRouteRequest = Readonly<{
  method: string;
  route: string;
  segments: readonly string[];
  url: URL;
  body: Record<string, unknown> | null;
  environmentId: string;
  request: IncomingMessage;
  response: ServerResponse;
}>;

export class PassiveLearningRoutes {
  constructor(
    private readonly resolveService: (
      environmentId: string,
    ) => PassiveLearningManagement,
  ) {}

  async handle(input: LearningRouteRequest): Promise<boolean> {
    if (!isLearningRoute(input.segments)) return false;
    input.response.setHeader("cache-control", "no-store");
    if (
      isLearningMutation(input.method, input.route) &&
      !acceptConfigMutationRequest(input.request, input.response)
    )
      return true;
    try {
      await this.dispatch(input, this.resolveService(input.environmentId));
    } catch (error) {
      const message = publicLearningFailure(error);
      sendJson(input.response, 409, {
        ok: false,
        error: "passive_learning_unavailable",
        message,
      });
    }
    return true;
  }

  private async dispatch(
    input: LearningRouteRequest,
    service: PassiveLearningManagement,
  ): Promise<void> {
    if (input.route === "runtime/learning") {
      if (input.method === "GET") {
        sendJson(input.response, 200, {
          ok: true,
          status: await service.status(),
        });
        return;
      }
      if (input.method === "PUT") {
        const preferences = readLearningPreferences(input.body);
        if (!preferences) {
          sendJson(input.response, 400, {
            ok: false,
            error: "passive_learning_preferences_invalid",
          });
          return;
        }
        sendJson(input.response, 200, {
          ok: true,
          status: await service.configure(preferences),
        });
        return;
      }
      sendLearningMethodNotAllowed(input.response, "GET, PUT");
      return;
    }
    if (input.route === "runtime/learning/collection/restart") {
      if (input.method !== "POST") {
        sendLearningMethodNotAllowed(input.response, "POST");
        return;
      }
      if (!service.restartCollection)
        throw new Error("passive_learning_unavailable");
      sendJson(input.response, 200, {
        ok: true,
        status: await service.restartCollection(),
      });
      return;
    }
    if (input.segments[2] === "proposals") {
      if (input.method !== "DELETE") {
        sendLearningMethodNotAllowed(input.response, "DELETE");
        return;
      }
      const id = input.segments[3];
      if (!isLearningEventId(id)) {
        sendJson(input.response, 400, {
          ok: false,
          error: "passive_learning_proposal_invalid",
        });
        return;
      }
      if (!service.dismissProposal)
        throw new Error("passive_learning_unavailable");
      await service.dismissProposal(id);
      sendJson(input.response, 200, { ok: true });
      return;
    }
    if (input.route === "runtime/learning/pending") {
      if (input.method !== "DELETE") {
        sendLearningMethodNotAllowed(input.response, "DELETE");
        return;
      }
      sendJson(input.response, 200, {
        ok: true,
        status: await service.clearPending(),
      });
      return;
    }
    if (input.method !== "GET") {
      sendLearningMethodNotAllowed(input.response, "GET");
      return;
    }
    if (input.route === "runtime/learning/candidates") {
      if (!service.candidates) throw new Error("passive_learning_unavailable");
      sendJson(input.response, 200, {
        ok: true,
        items: await service.candidates(),
      });
      return;
    }
    if (input.route === "runtime/learning/batches") {
      sendJson(input.response, 200, {
        ok: true,
        items: await service.batches({ limit: 20 }),
      });
      return;
    }
    const batch = await service.batch(input.segments[3]);
    if (!batch) {
      sendJson(input.response, 404, {
        ok: false,
        error: "passive_learning_batch_not_found",
      });
      return;
    }
    sendJson(input.response, 200, { ok: true, batch });
  }
}

function isLearningRoute(segments: readonly string[]): boolean {
  if (segments[0] !== "runtime" || segments[1] !== "learning") return false;
  if (segments.length === 2) return true;
  if (segments[2] === "collection")
    return segments.length === 4 && segments[3] === "restart";
  if (segments[2] === "pending") return segments.length === 3;
  if (segments[2] === "candidates") return segments.length === 3;
  if (segments[2] === "proposals") return segments.length === 4;
  if (segments[2] !== "batches") return false;
  return segments.length === 3 || segments.length === 4;
}

function isLearningMutation(method: string, route: string): boolean {
  if (method === "POST") return route === "runtime/learning/collection/restart";
  return method === "PUT" || method === "DELETE";
}

function readLearningPreferences(
  body: Record<string, unknown> | null,
): Partial<PassiveLearningPreferences> | undefined {
  if (!body) return undefined;
  const {
    environment: _environment,
    environmentId: _environmentId,
    ...preferences
  } = body;
  try {
    return readLearningPreferencesInput(preferences);
  } catch {
    return undefined;
  }
}

function publicLearningFailure(error: unknown): string {
  const actionableFailures = new Set([
    "learning_model_required",
    "proactive_model_required",
    "learning_activity_not_allowed",
    "learning_model_profile_unavailable",
    "learning_model_profile_overridden",
    "learning_memory_unavailable",
    "invalid_learning_preferences",
    "invalid_learning_model_profile",
    "invalid_learning_exclusions",
    "learning_storage_unavailable",
  ]);
  return error instanceof Error && actionableFailures.has(error.message)
    ? error.message
    : "passive_learning_unavailable";
}

function sendLearningMethodNotAllowed(
  response: ServerResponse,
  allow: string,
): void {
  response.setHeader("allow", allow);
  sendJson(response, 405, { ok: false, error: "method_not_allowed" });
}
