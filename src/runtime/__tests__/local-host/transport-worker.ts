import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { createLocalRuntimeConnection } from "../../local-host/transport.js";

const [directory, identity] = process.argv.slice(2);
const events = new Set<(event: unknown) => void>();
const connection = await createLocalRuntimeConnection({
  directory,
  identity,
  createOwner: async () => {
    await appendFile(join(directory, "created.jsonl"), `${process.pid}\n`);
    return {
      call: async (method, args, peer) => {
        if (method === "echo") return args[0];
        if (method === "ownerPid") return process.pid;
        if (method === "callback") return peer.callClient("double", args);
        if (method === "emit") {
          for (const listener of events) listener(args[0]);
          return true;
        }
        if (method === "hold") {
          process.send?.({ kind: "invoked", marker: args[0] });
          return new Promise(() => {});
        }
        throw new Error("fixture_method_unknown");
      },
      subscribe: (listener) => {
        events.add(listener);
        return () => {
          events.delete(listener);
        };
      },
      stop: async () => {
        await appendFile(join(directory, "stopped.jsonl"), `${process.pid}\n`);
      },
    };
  },
});
connection.setClientHandler(async (method, args) => {
  if (method === "double") return Number(args[0]) * 2;
  throw new Error("fixture_client_method_unknown");
});
connection.subscribe((event) => process.send?.({ kind: "event", event }));
process.on(
  "message",
  (raw: { id: string; method: string; args: unknown[] }) => {
    void respond(raw);
  },
);
process.send?.({ kind: "ready", ownership: connection.ownership });

async function respond(message: {
  id: string;
  method: string;
  args: unknown[];
}): Promise<void> {
  try {
    const result =
      message.method === "close"
        ? await connection.close()
        : await connection.call(message.method, message.args);
    process.send?.({ kind: "response", id: message.id, result }, () => {
      if (message.method === "close") process.exit(0);
    });
  } catch (error) {
    process.send?.({
      kind: "response",
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
