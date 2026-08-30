import type { IncomingMessage, ServerResponse } from "node:http";

export async function withHttpRequestAbortSignal<T>(params: {
  request: IncomingMessage;
  response: ServerResponse;
  reason: string;
  run: (abortSignal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error(params.reason));
  const abortOnResponseClose = () => {
    if (!params.response.writableEnded) abort();
  };
  params.request.once("aborted", abort);
  params.response.once("close", abortOnResponseClose);
  if (params.request.aborted || params.response.destroyed) abort();
  try {
    return await params.run(controller.signal);
  } finally {
    params.request.removeListener("aborted", abort);
    params.response.removeListener("close", abortOnResponseClose);
  }
}
