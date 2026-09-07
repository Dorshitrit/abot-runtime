import { createPublicHttpClient as createSharedClient } from "../../../src/shared/public-http/public-http.js";
import { rethrowWebPluginError } from "./errors.js";
import type { PublicHttpClient } from "../../../src/shared/public-http/public-http.js";

export type {
  PublicHttpClient,
  PublicHttpRequest,
  PublicHttpResponse,
  HopRequester,
} from "../../../src/shared/public-http/public-http.js";
export { requestPinnedHop } from "./request-hop.js";

export function createPublicHttpClient(
  dependencies: Parameters<typeof createSharedClient>[0] = {},
): PublicHttpClient {
  const client = createSharedClient(dependencies);
  return Object.freeze({
    async get(request) {
      try {
        return await client.get(request);
      } catch (error) {
        return rethrowWebPluginError(error);
      }
    },
  });
}
