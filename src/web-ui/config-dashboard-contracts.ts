import type { ConfigFileSnapshot } from "../runtime/adapters/config-file-transaction.js";
import type { ModelParameterPresentation } from "../shared/model-parameters.js";

export type ConfigFileKind = "runtime" | "requestRunner" | "model";
export type ConfigFileDescriptor = {
  kind: ConfigFileKind;
  id: string;
  label: string;
  path: string;
  exists: boolean;
  revision: string;
  config: Record<string, unknown>;
  registered?: boolean;
  invalidJson?: ConfigFileSnapshot["invalidJson"];
  source?: {
    type: "inlineModelProfile";
    runtimeConfigPath: string;
    profileId: string;
  };
};

export type ConfigParameterPresentation = Omit<ModelParameterPresentation, "parameters"> & {
  nativeOptionKeys?: readonly string[];
  parameters: readonly (ModelParameterPresentation["parameters"][number] & {
    legacyKeys?: readonly string[];
    configuredValue?: number | string | boolean;
  })[];
};
export type ConfigModelParameterPresentation = {
  model: ConfigParameterPresentation;
  calibration: Record<string, ConfigParameterPresentation>;
};

export type ConfigDashboardSnapshot = {
  rootDir: string;
  configDir: string;
  modelSteps: string[];
  files: {
    runtime: ConfigFileDescriptor;
    requestRunner: ConfigFileDescriptor | null;
    models: ConfigFileDescriptor[];
  };
  modelParameters?: Record<string, ConfigModelParameterPresentation>;
};
