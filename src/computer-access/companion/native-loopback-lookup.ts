import type { TcpNetConnectOpts } from "node:net";
import type { NativeAddress } from "./native-address.js";

function matchesLookupFamily(address: NativeAddress, family?: number | string): boolean {
  if (family === 4 || family === "IPv4") return address.family === 4;
  if (family === 6 || family === "IPv6") return address.family === 6;
  return family === undefined || family === 0;
}

/** Socket-family selection is restricted to the resolver's immutable, vetted set. */
export function nativeLoopbackSocketOptions(endpoint: Readonly<{
  url: string;
  addresses: readonly NativeAddress[];
}>): Pick<TcpNetConnectOpts, "family" | "autoSelectFamily" | "autoSelectFamilyAttemptTimeout" | "lookup"> {
  const expectedHostname = new URL(endpoint.url).hostname.toLowerCase();
  return {
    family: 0,
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: 250,
    lookup(hostname, options, callback) {
      const hasExpectedHostname = hostname.toLowerCase() === expectedHostname;
      if (!hasExpectedHostname) {
        callback(Object.assign(new Error("Unexpected Runtime lookup hostname."), { code: "ENOTFOUND" }), []);
        return;
      }
      const addresses = endpoint.addresses.filter((address) => matchesLookupFamily(address, options.family));
      if (addresses.length === 0) {
        callback(Object.assign(new Error("No validated Runtime address for this family."), { code: "ENOTFOUND" }), []);
        return;
      }
      if (options.all) {
        callback(null, addresses.map(({ address, family }) => ({ address, family })));
        return;
      }
      callback(null, addresses[0]!.address, addresses[0]!.family);
    },
  };
}
