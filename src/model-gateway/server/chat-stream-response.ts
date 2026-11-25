import type { ModelProviderChatInvocation } from "../providers/contracts.js";
import type { GatewayResponse } from "./contracts.js";
import type { GatewayModelIssues } from "./model-issues.js";

export async function writeChatStreamResponse(params: {
  invocation: ModelProviderChatInvocation;
  response: GatewayResponse;
  abortSignal: AbortSignal;
  issues?: GatewayModelIssues;
}): Promise<void> {
  const { invocation, response, abortSignal } = params;
  let hasEmittedEvent = false;
  response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache");
  try {
    await invocation.stream({
      emit(event) {
        response.write(`${JSON.stringify(event)}\n`);
        hasEmittedEvent = true;
      },
    });
  } catch (error) {
    if (abortSignal.aborted) return;
    // Before the first write, the handler can still send its normal HTTP error.
    if (!hasEmittedEvent) throw error;
    params.issues?.writeStreamOutcomes(response);
    console.error(error);
    response.end(
      `${JSON.stringify({ type: "error", error: "server error" })}\n`,
    );
    return;
  }
  params.issues?.writeStreamOutcomes(response);
  response.end();
}
