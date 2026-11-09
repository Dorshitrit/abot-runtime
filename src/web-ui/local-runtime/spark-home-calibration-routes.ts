import type { IncomingMessage, ServerResponse } from "node:http";
import type { SparkHomeSettingsService } from "../../runtime/spark-home/settings/contracts.js";
import { parseSparkHomeCalibrationInput, parseSparkHomeCalibrationDraftInput } from "../../runtime/spark-home/calibration/contracts.js";
import { acceptConfigMutationRequest } from "./config-mutation-request.js";
import { sendJson } from "./http.js";

type CalibrationRouteInput = {
  method: string; route: string; body: unknown; environmentId: string;
  request: IncomingMessage; response: ServerResponse;
};
function calibrationFailure(error: unknown): { status: number; code: string } {
  const code = error instanceof Error ? error.message : "";
  if (["spark_home_calibration_invalid", "spark_home_calibration_empty"].includes(code)) return { status: 400, code };
  if (["spark_home_settings_conflict", "spark_home_calibration_busy", "spark_home_calibration_options_changed",
    "spark_chat_model_required", "spark_chat_model_unavailable", "spark_home_model_unavailable",
    "spark_home_model_required", "spark_home_execution_agent_required"].includes(code)) return { status: 409, code };
  if (["spark_home_calibration_timeout", "spark_home_calibration_output_invalid", "output_incomplete"].includes(code))
    return { status: 502, code };
  return { status: 503, code: "spark_home_calibration_unavailable" };
}

/** This form operation drafts instructions only; it never starts a HOME request. */
export class SparkHomeCalibrationRoutes {
  constructor(private readonly service: (environmentId: string) => Pick<SparkHomeSettingsService, "readCalibrationOptions" | "draftCalibration"> | undefined) {}
  async handle(input: CalibrationRouteInput): Promise<boolean> {
    if (!["runtime/spark-home/calibration/options", "runtime/spark-home/calibration/draft"].includes(input.route)) return false;
    input.response.setHeader("cache-control", "no-store");
    if (input.method !== "POST") {
      input.response.setHeader("allow", "POST");
      sendJson(input.response, 405, { ok: false, error: "method_not_allowed" });
      return true;
    }
    if (!acceptConfigMutationRequest(input.request, input.response)) return true;
    try {
      const service = this.service(input.environmentId);
      if (!service) throw new Error("spark_home_calibration_unavailable");
      if (input.route.endsWith("/options")) {
        const calibration = await service.readCalibrationOptions(parseSparkHomeCalibrationInput(input.body));
        sendJson(input.response, 200, { ok: true, calibration });
        return true;
      }
      const draft = await service.draftCalibration(parseSparkHomeCalibrationDraftInput(input.body));
      sendJson(input.response, 200, { ok: true, draft });
    } catch (error) {
      const failure = calibrationFailure(error);
      sendJson(input.response, failure.status, { ok: false, error: failure.code });
    }
    return true;
  }
}
