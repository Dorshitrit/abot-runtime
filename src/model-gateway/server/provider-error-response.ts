import { PROVIDER_CONTEXT_OVERFLOW_HEADER, readProviderContextOverflow } from "../protocol/provider-context-overflow.js";
import { permitsModelContentTrace } from "../observability/content-trace-policy.js";
import {
  encodeProviderUserError,
  PROVIDER_USER_ERROR_HEADER,
} from "../protocol/provider-user-error.js";
import type { ModelProviderInvocationError } from "../providers/contracts.js";
import type { ModelGatewayRequest } from "../types.js";
import type { GatewayResponse } from "./contracts.js";
import { sendText } from "./http-response.js";

/** Status and diagnostic bytes stay unchanged; presentation is gateway-owned metadata. */
export function sendProviderError(
  response: GatewayResponse,
  result: ModelProviderInvocationError,
  request: ModelGatewayRequest,
): void {
  if (result.presentation && permitsModelContentTrace(request.modelStep, request)) {
    const header = encodeProviderUserError(result.presentation);
    if (header) response.setHeader(PROVIDER_USER_ERROR_HEADER, header);
  }
  const contextOverflow = readProviderContextOverflow(result.contextOverflow);
  if (contextOverflow) response.setHeader(PROVIDER_CONTEXT_OVERFLOW_HEADER, contextOverflow);
  sendText(response, result.statusCode, result.message);
}
