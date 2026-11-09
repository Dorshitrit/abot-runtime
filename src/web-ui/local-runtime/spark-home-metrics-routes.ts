import type { ServerResponse } from "node:http";
import { createSystemMetricsSampler } from "../system-metrics/sampler.js";
import { sendJson } from "./http.js";

/** Host telemetry is read directly, independently of HOME generation and tool execution. */
export class SparkHomeMetricsRoutes {
  constructor(private readonly isEnvironmentAvailable: (environmentId: string) => boolean,
    private readonly sampler = createSystemMetricsSampler()) {}

  async handle(input: { method: string; route: string; environmentId: string; response: ServerResponse }): Promise<boolean> {
    if (input.route !== "runtime/spark-home/system-metrics") return false;
    const { response } = input;
    response.setHeader("cache-control", "private, no-store");
    response.setHeader("x-content-type-options", "nosniff");
    if (input.method !== "GET") {
      response.setHeader("allow", "GET");
      sendJson(response, 405, { ok: false, error: "method_not_allowed" });
      return true;
    }
    try {
      if (!this.isEnvironmentAvailable(input.environmentId)) throw new Error("unavailable");
      const metrics = await this.sampler.read();
      sendJson(response, 200, { ok: true, metrics });
    } catch {
      sendJson(response, 503, { ok: false, error: "system_metrics_unavailable" });
    }
    return true;
  }
}
