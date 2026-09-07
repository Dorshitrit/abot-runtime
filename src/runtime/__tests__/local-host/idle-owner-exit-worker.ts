import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeConfig } from "../../ports.js";
import { createLocalRuntimeOwner } from "../../local-host/app-owner.js";
import { resolveLocalRuntimeIdentity } from "../../local-host/client-identity.js";
import { createLocalRuntimeConnection } from "../../local-host/transport.js";

const [configPath] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configPath, "utf8")) as RuntimeConfig;
const connection = await createLocalRuntimeConnection({
  directory: join(config.paths.runtimeDir, "local-host"),
  identity: resolveLocalRuntimeIdentity(config),
  createOwner: () =>
    createLocalRuntimeOwner(config, {
      models: {
        invoke: async () => {
          throw new Error("unexpected_model_invocation");
        },
        invokeRaw: async () => {
          throw new Error("unexpected_raw_model_invocation");
        },
      },
    }),
});
await connection.close();
process.exit(0);
