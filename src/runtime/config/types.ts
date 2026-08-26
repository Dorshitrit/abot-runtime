export type RuntimeEnv = Record<string, string | undefined>;

export type RuntimeConfigFile = {
  agentBridgeUrl?: unknown;
  agentBridgeToken?: unknown;
  modelGatewayUrl?: unknown;
  environment?: unknown;
  webUi?: unknown;
  paths?: unknown;
  logging?: unknown;
  timeouts?: unknown;
  plugins?: unknown;
  models?: unknown;
  requestRunner?: unknown;
  features?: unknown;
  featureFlags?: unknown;
};

export type RuntimeConfigOptions = {
  env?: RuntimeEnv;
  rootDir?: string;
  envPath?: string;
  configPath?: string;
  defaultAgentBridgeUrl?: string;
  profileId?: string;
};

export type StringConfigField = {
  path: "agentBridgeUrl" | "agentBridgeToken" | "modelGatewayUrl";
  env: readonly string[];
  defaultValue?: string;
  description: string;
};

export type PathConfigField = {
  key:
    | "runtimeDir"
    | "agentWorkDir"
    | "sessionsDir"
    | "attachmentsDir"
    | "workspaceDir"
    | "sharedDir"
    | "compiledDir"
    | "traceFile";
  env: readonly string[];
  defaultValue: string;
  description: string;
};

export type TimeoutConfigField = {
  key:
    | "requestTimeoutMs"
    | "requestInactivityTimeoutMs"
    | "modelStepTimeoutMs"
    | "streamInactivityTimeoutMs";
  env: string;
  description: string;
};

export type RuntimeConfigSchemaField = {
  path: string;
  type:
    | "non-empty-string"
    | "positive-number"
    | "string-array"
    | "boolean"
    | "string-map"
    | "object-map"
    | "feature-flag-map";
  env?: readonly string[];
  defaultValue?: string;
  description: string;
};

export type RuntimeConfigJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema";
  $id: string;
  title: string;
  type: "object";
  required: string[];
  properties: Record<string, unknown>;
};
