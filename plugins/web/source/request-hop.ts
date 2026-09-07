import { requestPinnedHop as requestSharedHop } from "../../../src/shared/public-http/request-hop.js";
import type { HopRequester } from "../../../src/shared/public-http/request-hop.js";
import { rethrowWebPluginError } from "./errors.js";

export type {
  HopRequester,
  HopResponse,
} from "../../../src/shared/public-http/request-hop.js";

export const requestPinnedHop: HopRequester = async (params) => {
  try {
    return await requestSharedHop(params);
  } catch (error) {
    return rethrowWebPluginError(error);
  }
};
