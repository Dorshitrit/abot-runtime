import type { ModelGatewayRequest, ResolvedModelInvocation } from "../types.js";
import {
  createProviderTraceContext,
  serializeProviderError,
  type ProviderTraceContext,
} from "./provider-trace-context.js";
import { isModelIoTraceEnabled, traceModelIo } from "./trace-store.js";

export type ProviderResponseDecoder = (
  body: ReadableStream<Uint8Array>,
) => Promise<{
  text: string;
  thinking: string;
  usage?: unknown;
}>;

type DecodedProviderResponse = Readonly<{
  text: string;
  thinking: string;
  usage?: unknown;
}>;

function sanitizeProviderHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const credentialHeaders = new Set([
    "authorization",
    "proxy-authorization",
    "x-api-key",
  ]);
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !credentialHeaders.has(name.toLowerCase()),
    ),
  );
}

async function decodeProviderResponse(
  response: Response,
  decodeResponse: ProviderResponseDecoder,
): Promise<
  | { decoded: DecodedProviderResponse }
  | { decodeError: { name: string; message: string } }
> {
  if (!response.body) {
    return { decoded: { text: "", thinking: "" } };
  }

  try {
    return { decoded: await decodeResponse(response.body) };
  } catch (error) {
    return { decodeError: serializeProviderError(error) };
  }
}

async function captureProviderResponse(
  context: ProviderTraceContext,
  response: Response,
  decodeResponse: ProviderResponseDecoder,
): Promise<void> {
  try {
    const rawResponse = response.clone();
    const decodedResponse = response.clone();
    const [body, decodedCapture] = await Promise.all([
      rawResponse.text(),
      decodeProviderResponse(decodedResponse, decodeResponse),
    ]);
    await traceModelIo({
      event: "provider.response",
      ...context,
      response: {
        status: response.status,
        statusText: response.statusText,
        ...decodedCapture,
        body,
      },
    });
  } catch (error) {
    await traceModelIo({
      event: "provider.failure",
      ...context,
      stage: "response.capture",
      error: serializeProviderError(error),
    });
  }
}

export async function fetchProviderWithTrace(params: {
  endpoint: "chat" | "raw";
  requestBody: ModelGatewayRequest;
  invocation: ResolvedModelInvocation;
  fetchImpl: typeof fetch;
  url: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
  decodeResponse: ProviderResponseDecoder;
}): Promise<{
  response: Response;
  responseTrace: Promise<void>;
}> {
  const traceEnabled = isModelIoTraceEnabled();
  const context = createProviderTraceContext(params);
  const serializedBody = JSON.stringify(params.payload);

  if (traceEnabled) {
    await traceModelIo({
      event: "provider.request",
      ...context,
      request: {
        url: params.url,
        method: "POST",
        headers: sanitizeProviderHeaders(params.headers),
        body: params.payload,
      },
    });
  }

  try {
    const response = await params.fetchImpl(params.url, {
      method: "POST",
      headers: params.headers,
      body: serializedBody,
    });
    return {
      response,
      responseTrace: traceEnabled
        ? captureProviderResponse(context, response, params.decodeResponse)
        : Promise.resolve(),
    };
  } catch (error) {
    if (traceEnabled) {
      await traceModelIo({
        event: "provider.failure",
        ...context,
        stage: "request.fetch",
        error: serializeProviderError(error),
      });
    }
    throw error;
  }
}
