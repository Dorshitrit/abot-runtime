import { execFile } from "node:child_process";
import type { IncomingMessage } from "node:http";
import type { TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { localMacSetupRuntimeUrl } from "../../web-ui/system-host-setup/local-setup-availability.js";
import { nativeLoopbackCertificate } from "./support/native-loopback-certificate.js";
import { nativeLoopbackFixture } from "./support/native-loopback-fixture.js";

let certificate: Awaited<ReturnType<typeof nativeLoopbackCertificate>>;
const cleanups: (() => Promise<void>)[] = [];
beforeAll(async () => {
  certificate = await nativeLoopbackCertificate();
});
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
afterAll(async () => {
  await certificate?.cleanup();
});

async function connectWithTestCertificate(url: string) {
  const client = fileURLToPath(new URL("./support/native-loopback-tls-client.ts", import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", client, url], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: certificate.certPath, NODE_TLS_REJECT_UNAUTHORIZED: "1" },
    timeout: 15_000,
  });
  return JSON.parse(stdout) as { outcome: string; paired: { hostId: string; credential: string }[];
    lookups: number; ready: number };
}

test.each(["127.0.0.1", "::1"] as const)(
  "local HTTPS setup preserves the certificate hostname through a %s listener",
  async (address) => {
    const f = await nativeLoopbackFixture(address, "abot.localhost", certificate);
    cleanups.push(f.close);
    const request = { headers: { host: `abot.localhost:${f.port}` },
      socket: { localAddress: address, localPort: f.port, encrypted: true } } as unknown as IncomingMessage;
    const url = localMacSetupRuntimeUrl(request);
    expect(url).toBe(f.url);
    expect(await connectWithTestCertificate(url)).toEqual({ outcome: "stopped",
      paired: [{ hostId: f.hostId, credential: f.credential }], lookups: 0, ready: 0 });
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.headers.host).toBe(`abot.localhost:${f.port}`);
    expect((f.requests[0]!.socket as TLSSocket).servername).toBe("abot.localhost");
  },
);

test("rejects a trusted certificate for another hostname before sending pairing credentials", async () => {
  const f = await nativeLoopbackFixture("127.0.0.1", "wrong.localhost", certificate);
  cleanups.push(f.close);
  expect(await connectWithTestCertificate(f.url)).toEqual({ outcome: "disconnected",
    paired: [], lookups: 0, ready: 0 });
  expect(f.requests).toHaveLength(0);
  expect(f.onPaired).not.toHaveBeenCalled();
});
