import {
  parsePublicHttpUrl as parseSharedUrl,
  resolvePublicTarget as resolveSharedTarget,
  resolveHostAddresses as resolveSharedAddresses,
  type HostResolver,
} from "../../../src/shared/public-http/network-policy.js";
import { rethrowWebPluginError } from "./errors.js";

export {
  isPublicAddress,
  isPublicIpv4,
  isPublicIpv6,
} from "../../../src/shared/public-http/network-policy.js";
export type {
  PublicAddress,
  HostResolver,
} from "../../../src/shared/public-http/network-policy.js";

export function parsePublicHttpUrl(rawUrl: string): URL {
  try {
    return parseSharedUrl(rawUrl);
  } catch (error) {
    return rethrowWebPluginError(error);
  }
}

export const resolveHostAddresses: HostResolver = async (hostname) => {
  try {
    return await resolveSharedAddresses(hostname);
  } catch (error) {
    return rethrowWebPluginError(error);
  }
};

export async function resolvePublicTarget(
  url: URL,
  resolver: HostResolver = resolveHostAddresses,
) {
  try {
    return await resolveSharedTarget(url, resolver);
  } catch (error) {
    return rethrowWebPluginError(error);
  }
}
