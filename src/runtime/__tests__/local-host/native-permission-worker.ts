import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { LocalNativePermissions } from "../../local-host/app-native-permissions.js";
import { createLocalNativePermissionClient } from "../../local-host/client-native-permissions.js";
import { createLocalRuntimeConnection } from "../../local-host/transport.js";
import type { NativePermissionInput } from "../../../computer-access/native-permission-contract.js";

const [directory, identity] = process.argv.slice(2);
const connection = await createLocalRuntimeConnection({ directory, identity,
  createOwner: async () => {
    const permissions = new LocalNativePermissions({ platform: "darwin",
      resolveTarget: async () => ({ id: "macos", transport: "native", shell: "/bin/bash" }),
      prepare: async (action) => {
        await appendFile(join(directory, "permission-executor.jsonl"), JSON.stringify({ pid: process.pid, action }) + "\n");
        return { permissions: { screenRecording: "required", accessibility: "granted" }, executablePath: process.execPath, restartMayBeRequired: false };
      },
    });
    return { call: (method, args, peer) => permissions.call(method, args, peer),
      subscribe: () => () => {}, stop: async () => permissions.stop() };
  },
});
const permissions = createLocalNativePermissionClient((method, args) => connection.call(method, args));
function execute(method: string, args: unknown[]) {
  if (method === "status") return permissions.status();
  if (method === "prepare") return permissions.prepare(args[0] as NativePermissionInput);
  return connection.close();
}
process.on("message", (message: { id: string; method: string; args: unknown[] }) => {
  const operation = execute(message.method, message.args);
  void operation.then((result) => process.send?.({ kind: "response", id: message.id, result }, () => {
    if (message.method === "close") process.exit(0);
  }), (error) => process.send?.({ kind: "response", id: message.id, error: error.message }));
});
process.send?.({ kind: "ready", ownership: connection.ownership });
