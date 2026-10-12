import { defineRuntimePlugin } from "../../../src/plugin-sdk/index.js";
import { createSystemHandlers, observeSystemTargets } from "../../../src/plugin-sdk/computer-access.js";
import { prepareSystemRequestModules } from "./request-system-modules.js";
import { createLocalSystemCommandOutput, systemCommandOutputRetentionMs } from "./local-command-output.js";
import { unboundComputerHandlers } from "./computer/request-modules.js";
import { systemResultProtection } from "./security/system-results.js";

export default defineRuntimePlugin((context) => {
  const output = createLocalSystemCommandOutput(context);
  return {
    handlers: { ...createSystemHandlers(undefined, undefined, output, systemResultProtection), ...unboundComputerHandlers() },
    prepareRequest: (modules, preparation) => prepareSystemRequestModules(context.rootDir, modules, {
      outputRetentionMs: systemCommandOutputRetentionMs(context),
      observeTargets: async () => systemResultProtection.protectTargets(await observeSystemTargets()),
      createNativeHandlers: (resolve) => createSystemHandlers(undefined, resolve, output, systemResultProtection),
    }, preparation),
  };
});
