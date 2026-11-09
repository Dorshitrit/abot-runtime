import type { RuntimeConfig, SessionStore, ModelGatewayClient, ToolRegistry } from "../ports.js";
import type { LongTermMemoryService } from "../long-term-memory/contracts.js";
import type { PassiveLearningService } from "../passive-learning/contracts.js";
import type { InformationBasketService } from "../information-basket/contracts.js";
import { readSparkToolPermissionMode } from "../passive-learning/spark-chat-preferences.js";
import { isSparkSession, SPARK_SESSION_ID } from "../../sessions/spark-session.js";
import type { SparkHomeAppearanceOptions } from "./application-contracts.js";
import { createSparkHomeService } from "./store.js";
import { createSparkHomeSettingsService } from "./settings/service.js";
import { createSparkHomePreferencesService } from "./preferences.js";
import { createSparkHomeAuthoringContextProvider } from "./authoring-context/index.js";
import { createSparkHomeGenerationService } from "./generation/service.js";

type SparkHomeRuntimeDependencies = SparkHomeAppearanceOptions & Readonly<{
  config: RuntimeConfig;
  sessions: SessionStore;
  models: ModelGatewayClient;
  tools: ToolRegistry;
  memory: LongTermMemoryService;
  passiveLearning: PassiveLearningService;
  resources?: InformationBasketService;
}>;

/** Lazy feature composition: construction performs no capture, model call or scheduler work. */
export function createSparkHomeRuntime(options: SparkHomeRuntimeDependencies) {
  const runtimeDirectory = options.config.paths.runtimeDir;
  const sparkHome = createSparkHomeService(runtimeDirectory);
  const getSparkModelProfileId = async () => {
    const { preferences } = await options.passiveLearning.status();
    return preferences.proactiveModelProfileId ?? preferences.modelProfileId ?? null;
  };
  const getToolPermissionMode = async () => {
    const { preferences } = await options.passiveLearning.status();
    return readSparkToolPermissionMode(preferences.sparkToolPermissionMode);
  };
  const sparkHomeSettings = createSparkHomeSettingsService({
    runtimeDirectory, config: options.config, getSparkModelProfileId,
    calibration: { tools: options.tools, models: options.models,
      getSparkToolPermissionMode: getToolPermissionMode },
  });
  const context = createSparkHomeAuthoringContextProvider({
    service: sparkHome, sessions: options.sessions, memory: options.memory, resources: options.resources,
  });
  const sparkHomeGeneration = createSparkHomeGenerationService({
    config: options.config, models: options.models, tools: options.tools,
    settings: sparkHomeSettings, screen: sparkHome, context, getToolPermissionMode,
    getAppearance: options.sparkHomeAppearance,
    async getSessionId() {
      const session = await options.sessions.getSessionById(SPARK_SESSION_ID);
      return session && isSparkSession(session) ? SPARK_SESSION_ID : undefined;
    },
  });
  return Object.freeze({ sparkHome, sparkHomeSettings, sparkHomeGeneration,
    sparkHomePreferences: createSparkHomePreferencesService(runtimeDirectory) });
}
