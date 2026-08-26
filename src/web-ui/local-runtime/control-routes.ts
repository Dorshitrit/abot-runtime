import type { IncomingMessage, ServerResponse } from "node:http";

import { resolveAgentMode } from "../../shared/agent.js";
import type { AgentMode } from "../../shared/types.js";
import { readBody, readJsonBody, sendJson } from "./http.js";
import { LocalRequestExecution } from "./request-execution.js";

export class LocalRuntimeControlRoutes {
  private agentMode: AgentMode = "reasoning";

  constructor(private readonly requests: LocalRequestExecution) {}

  health(res: ServerResponse): void {
    const details = this.requests.healthDetails();
    sendJson(res, 200, {
      ok: true,
      source: "local-runtime",
      agentMode: this.agentMode,
      activeStreamingRequests: details.length,
      activeStreamingRequestDetails: details,
    });
  }

  async agentModeRoute(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.method === "POST") {
      const body = readJsonBody(await readBody(req));
      this.agentMode = resolveAgentMode(body.mode);
    }
    sendJson(res, 200, {
      ok: true,
      mode: this.agentMode,
      supportedModes: ["fast", "reasoning", "deep", "auto"],
    });
  }

  assistantStatus(res: ServerResponse): void {
    sendJson(res, 200, {
      ok: true,
      source: "local-runtime",
      nextWake: {},
      nextGoal: {},
      totals: { goals: 0, enabledGoals: 0, pendingTasks: 0, disabledGoals: 0 },
      recentDeliveries: [],
      recentNotifications: [],
      recentDecisions: [],
      activeExperiments: [],
      disabledGoals: [],
      learning: { feedbackCount: 0, reflectionCount: 0, goalHealth: [] },
    });
  }

  assistantMutationFallback(res: ServerResponse): void {
    sendJson(res, 200, {
      ok: true,
      status: "skipped",
      reason: "assistant_host_not_configured",
    });
  }
}
