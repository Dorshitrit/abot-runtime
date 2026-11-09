import type { IncomingMessage, ServerResponse } from "node:http";
import type { SparkHomeReader } from "../../runtime/spark-home/contracts.js";
import type { SparkHomePreferencesService } from "../../runtime/spark-home/preferences.js";
import { SparkHomeRoutes } from "./spark-home-routes.js";
import { SparkHomeSettingsRoutes, type SparkHomeSettingsClient } from "./spark-home-settings-routes.js";
import { SparkHomePreferencesRoutes } from "./spark-home-preferences-routes.js";
import { SparkHomeGenerationRoutes, type SparkHomeGenerationClient } from "./spark-home-generation-routes.js";
import { SparkHomeMetricsRoutes } from "./spark-home-metrics-routes.js";

type SparkHomeServices = { sparkHome?: SparkHomeReader; sparkHomeSettings?: SparkHomeSettingsClient;
  sparkHomePreferences?: SparkHomePreferencesService; sparkHomeGeneration?: SparkHomeGenerationClient };

/** One registration seam for the HOME-owned HTTP projections. */
export function createSparkHomeApi(services: (environmentId: string) => SparkHomeServices) {
  const routes = [
    new SparkHomeMetricsRoutes(id => Boolean(services(id).sparkHome)),
    new SparkHomeSettingsRoutes(id => services(id).sparkHomeSettings),
    new SparkHomePreferencesRoutes(id => services(id).sparkHomePreferences),
    new SparkHomeGenerationRoutes(id => services(id).sparkHomeGeneration),
    new SparkHomeRoutes(id => services(id).sparkHome),
  ];
  return {
    async handle(input: { method: string; route: string; body: unknown; environmentId: string;
      request: IncomingMessage; response: ServerResponse }): Promise<boolean> {
      if (!input.route.startsWith("runtime/spark-home")) return false;
      for (const route of routes) if (await route.handle(input)) return true;
      return false;
    },
  };
}
