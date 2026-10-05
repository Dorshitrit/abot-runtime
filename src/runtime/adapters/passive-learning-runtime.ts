import { createHash } from "node:crypto";
import { join } from "node:path";
import { connectHostObservations } from "../../computer-access/companion/observation-client.js";
import type { RuntimeConfig, ModelGatewayClient, SessionStore } from "../ports.js";
import type { LongTermMemoryService } from "../long-term-memory/contracts.js";
import { createPassiveLearningService } from "../passive-learning/service.js";
import { createRuntimePassiveLearningModel } from "../passive-learning/model.js";
import { createCoWorkerResourceDependencies } from "./co-worker-resources.js";
import type { SessionRequestAdmission } from "../request/session-admission.js";

/** The environment owns learning; the paired desktop owns native collection. */
export function createRuntimePassiveLearning(params: {
  config: RuntimeConfig;
  models: ModelGatewayClient;
  memory: LongTermMemoryService;
  sessions?: SessionStore;
  deliveryAdmission?: Pick<SessionRequestAdmission, "run">;
}) {
  const { config, models, memory } = params;
  const ownerId = createHash("sha256")
    .update(config.paths.runtimeDir)
    .digest("hex");
  return createPassiveLearningService({
    ownerId,
    directory: join(config.paths.runtimeDir, "passive-learning"),
    memory,
    model: createRuntimePassiveLearningModel({ config, models }),
    backgroundDependencies: (context) => createCoWorkerResourceDependencies({
      config, models, memory, context, ownerId, directory: join(config.paths.runtimeDir, "passive-learning"),
      sessions: params.sessions, deliveryAdmission: params.deliveryAdmission,
    }),
    connect: (input) =>
      connectHostObservations({
        ...input,
        ownerId,
        rootDir: config.paths.rootDir,
      }),
  });
}
