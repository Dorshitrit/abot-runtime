import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { acquireFileLock } from "../../adapters/long-term-memory/file-lock/acquisition.js";
import {
  ensurePrivateRuntimeDirectory,
  writeLocalRuntimeEndpoint,
} from "../../local-host/endpoint.js";

const [directory, mode] = process.argv.slice(2);
await ensurePrivateRuntimeDirectory(directory);
await acquireFileLock(join(directory, "owner"), { waitMs: 0 });
const server = createServer();
server.on("upgrade", (_request, socket) => {
  if (mode === "exit") {
    process.send?.({ kind: "handshake" }, () => process.exit(0));
    return;
  }
  process.send?.({ kind: "handshake" });
  if (mode === "reject") {
    socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  socket.destroy();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
await writeLocalRuntimeEndpoint(directory, {
  version: 1,
  identity: "test-environment",
  pid: process.pid,
  port: (server.address() as AddressInfo).port,
  token: randomBytes(32).toString("hex"),
});
process.send?.({ kind: "ready", ownership: "owner" });
