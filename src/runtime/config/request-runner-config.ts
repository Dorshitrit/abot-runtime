import { dirname, isAbsolute, resolve } from "node:path";

import type { RuntimeRequestRunnerConfig } from "../ports.js";
import type { RuntimeConfigFile } from "./types.js";
import { isRecord, readNestedConfigString } from "./utils.js";

export function resolveRequestRunnerConfigReference(params: {
  fileConfig: RuntimeConfigFile;
  mainConfigPath: string;
}): RuntimeRequestRunnerConfig | undefined {
  const requestRunner = isRecord(params.fileConfig.requestRunner)
    ? params.fileConfig.requestRunner
    : undefined;
  const configRef = readNestedConfigString(requestRunner, "configRef");
  if (!configRef) {
    return undefined;
  }
  return {
    configPath: isAbsolute(configRef)
      ? resolve(configRef)
      : resolve(dirname(params.mainConfigPath), configRef),
  };
}
