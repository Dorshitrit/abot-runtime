import type { RuntimeApplication } from "../../runtime/composition.js";
import type { RequestSteeringInbox } from "../../runtime/request/request-steering.js";

export type JsonObject = Record<string, unknown>;

export type LocalRuntimeBackendOptions = {
  rootDir?: string;
  configPath?: string;
  defaultEnvironmentId: string;
};

export type RuntimeEnvironment = RuntimeApplication;

export type RuntimeSetupRequirement = {
  status: "setup_required";
  code: "runtime_configuration_required";
  message: string;
};

export type RuntimeAvailability =
  | {
      status: "ready";
    }
  | RuntimeSetupRequirement;

export type RuntimeModelCatalogState = {
  defaultProfileId: string;
  profiles: Record<string, unknown>[];
  availability: RuntimeAvailability;
};

export type ActiveRequest = {
  requestId: string;
  sessionId: string;
  environmentId: string;
  startedAt: number;
  lastEventAt: number;
  lastEventName: string;
  events: JsonObject[];
  finalState: JsonObject | null;
  requestSteering: RequestSteeringInbox;
};
