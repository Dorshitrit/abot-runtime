import type { IncomingMessage, ServerResponse } from "node:http";
import type { SparkHomeGenerationService } from "../../runtime/spark-home/generation/contracts.js";
import { parseSparkHomeStartInput, parseSparkHomeReadRunInput, parseSparkHomeCancelInput,
  parseSparkHomeApprovalDecisionInput } from "../../runtime/spark-home/generation/input.js";
import { acceptConfigMutationRequest } from "./config-mutation-request.js";
import { sendJson } from "./http.js";

export type SparkHomeGenerationClient = Pick<SparkHomeGenerationService, "start" | "readRun" | "cancel" | "decideApproval">;
type RouteInput = { method: string; route: string; body: unknown; environmentId: string;
  request: IncomingMessage; response: ServerResponse };

function generationFailure(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  if (code.endsWith("_invalid") && code.startsWith("spark_home_")) return { status: 400, code };
  if (["spark_home_run_not_found"].includes(code)) return { status: 404, code };
  if (["spark_home_run_busy", "spark_home_settings_stale", "spark_home_settings_conflict", "spark_home_model_required",
    "spark_home_model_unavailable", "spark_home_execution_agent_required", "spark_home_calibration_required",
    "spark_home_approval_not_pending", "spark_chat_model_required", "spark_chat_model_unavailable"].includes(code))
    return { status: 409, code };
  return { status: 503, code: "spark_home_generation_unavailable" };
}

/** Dedicated HOME lifecycle. No ordinary request handler or session event is created here. */
export class SparkHomeGenerationRoutes {
  constructor(private readonly service: (environmentId: string) => SparkHomeGenerationClient | undefined) {}
  async handle(input: RouteInput): Promise<boolean> {
    const runs = "runtime/spark-home/runs";
    if (![runs, `${runs}/cancel`, `${runs}/approval`].includes(input.route)) return false;
    input.response.setHeader("cache-control", "no-store");
    const read = input.route === runs && input.method === "GET";
    if (!read && input.method !== "POST") {
      input.response.setHeader("allow", input.route === runs ? "GET, POST" : "POST");
      sendJson(input.response, 405, { ok: false, error: "method_not_allowed" }); return true;
    }
    if (!read && !acceptConfigMutationRequest(input.request, input.response)) return true;
    try {
      const service = this.service(input.environmentId);
      if (!service) throw new Error("spark_home_generation_unavailable");
      if (read) {
        const runId = new URL(input.request.url ?? "/", "http://localhost").searchParams.get("runId");
        const run = await service.readRun(parseSparkHomeReadRunInput(runId === null ? {} : { runId }));
        sendJson(input.response, 200, { ok: true, run }); return true;
      }
      if (input.route.endsWith("/cancel")) {
        const run = await service.cancel(parseSparkHomeCancelInput(input.body));
        sendJson(input.response, 200, { ok: true, run }); return true;
      }
      if (input.route.endsWith("/approval")) {
        const run = await service.decideApproval(parseSparkHomeApprovalDecisionInput(input.body));
        sendJson(input.response, 200, { ok: true, run }); return true;
      }
      const run = await service.start(parseSparkHomeStartInput(input.body));
      sendJson(input.response, 202, { ok: true, run });
    } catch (error) {
      const failure = generationFailure(error);
      sendJson(input.response, failure.status, { ok: false, error: failure.code });
    }
    return true;
  }
}
