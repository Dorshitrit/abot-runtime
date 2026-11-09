import type { IncomingMessage, ServerResponse } from "node:http";
import { parseSparkHomePreferencesUpdate, type SparkHomePreferencesService } from "../../runtime/spark-home/preferences.js";
import { acceptConfigMutationRequest } from "./config-mutation-request.js";
import { sendJson } from "./http.js";

function preferencesFailure(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  if (code === "spark_home_preferences_conflict") return { status: 409, code };
  if (code === "spark_home_preferences_invalid") return { status: 400, code };
  return { status: 503, code: "spark_home_preferences_unavailable" };
}

export class SparkHomePreferencesRoutes {
  constructor(private readonly service: (environmentId: string) => SparkHomePreferencesService | undefined) {}
  async handle(input: { method: string; route: string; body: unknown; environmentId: string;
    request: IncomingMessage; response: ServerResponse }): Promise<boolean> {
    if (input.route !== "runtime/spark-home/preferences") return false;
    input.response.setHeader("cache-control", "no-store");
    if (!["GET", "PUT"].includes(input.method)) {
      input.response.setHeader("allow", "GET, PUT");
      sendJson(input.response, 405, { ok: false, error: "method_not_allowed" }); return true;
    }
    if (input.method === "PUT" && !acceptConfigMutationRequest(input.request, input.response)) return true;
    try {
      const service = this.service(input.environmentId);
      if (!service) throw new Error("spark_home_preferences_unavailable");
      const preferences = input.method === "GET" ? await service.read() : await service.update(parseSparkHomePreferencesUpdate(input.body));
      sendJson(input.response, 200, { ok: true, preferences });
    } catch (error) {
      const failure = preferencesFailure(error);
      sendJson(input.response, failure.status, { ok: false, error: failure.code });
    }
    return true;
  }
}
