import { SparkHomeCalibrationRoutes } from "./spark-home-calibration-routes.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SparkHomeSettingsService } from "../../runtime/spark-home/settings/contracts.js";
import { parseSparkHomeSettingsUpdate } from "../../runtime/spark-home/settings/contracts.js";
import { acceptConfigMutationRequest } from "./config-mutation-request.js";
import { sendJson } from "./http.js";

type SettingsRouteInput = {
  method: string; route: string; body: unknown; environmentId: string;
  request: IncomingMessage; response: ServerResponse;
};
export type SparkHomeSettingsClient = Pick<SparkHomeSettingsService, "read" | "update" | "readCalibrationOptions" | "draftCalibration">;

function settingsFailure(error: unknown): { status: number; code: string } {
  const code = error instanceof Error ? error.message : "";
  if (code === "spark_home_settings_invalid") return { status: 400, code };
  if (["spark_home_settings_conflict", "spark_home_full_access_required",
    "spark_chat_model_required", "spark_chat_model_unavailable", "spark_home_model_unavailable",
    "spark_home_schedule_inactive", "spark_home_calibration_required", "spark_home_model_required",
    "spark_home_execution_agent_required"].includes(code)) return { status: 409, code };
  return { status: 503, code: "spark_home_settings_unavailable" };
}

/** Configuration is independent of the sandboxed screen's read-only content route. */
export class SparkHomeSettingsRoutes {
  private readonly calibration: SparkHomeCalibrationRoutes;
  constructor(private readonly service: (environmentId: string) => SparkHomeSettingsClient | undefined) {
    this.calibration = new SparkHomeCalibrationRoutes(service);
  }

  async handle(input: SettingsRouteInput): Promise<boolean> {
    if (await this.calibration.handle(input)) return true;
    if (input.route !== "runtime/spark-home/settings") return false;
    input.response.setHeader("cache-control", "no-store");
    if (!["GET", "PUT"].includes(input.method)) {
      input.response.setHeader("allow", "GET, PUT");
      sendJson(input.response, 405, { ok: false, error: "method_not_allowed" });
      return true;
    }
    if (input.method === "PUT" && !acceptConfigMutationRequest(input.request, input.response)) return true;
    try {
      const update = input.method === "PUT" ? parseSparkHomeSettingsUpdate(input.body) : undefined;
      const service = this.service(input.environmentId);
      if (!service) throw new Error("spark_home_settings_unavailable");
      const settings = update ? await service.update(update) : await service.read();
      sendJson(input.response, 200, { ok: true, settings });
    } catch (error) {
      const failure = settingsFailure(error);
      sendJson(input.response, failure.status, { ok: false, error: failure.code });
    }
    return true;
  }
}
