import { lookup } from "node:dns/promises";
import { createConnection } from "node:net";

export function isLoopbackGateway(url: URL): boolean {
  if (url.protocol !== "http:") return false;
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

function probeGatewayAddress(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    const finish = (connected: boolean) => {
      socket.destroy();
      resolve(connected);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(750, () => finish(false));
  });
}

/** Probe all configured hostname addresses; net's ADDRCONFIG can hide IPv6 loopback. */
export async function hasGatewayListener(
  port: number,
  host: string,
  ownedHost?: string,
): Promise<boolean> {
  const resolved = await lookup(host, { all: true, verbatim: true });
  const addresses = [...new Set(resolved.map(({ address }) => address))].filter(
    (address) => address !== ownedHost,
  );
  const listeners = await Promise.all(
    addresses.map((address) => probeGatewayAddress(port, address)),
  );
  return listeners.some(Boolean);
}
