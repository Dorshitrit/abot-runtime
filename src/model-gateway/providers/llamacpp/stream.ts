import { readSseDataFrames } from "../../protocol/sse-data.js";
import type { ModelGatewayEvent, ModelTokenUsage } from "../../types.js";
import type { ModelProviderEventSink } from "../contracts.js";
import { LlamaCppChatStreamNormalizer } from "./stream-normalizer.js";

export async function forwardLlamaCppChatStream(
  body: ReadableStream<Uint8Array>, writer: ModelProviderEventSink,
): Promise<void> {
  const normalizer = new LlamaCppChatStreamNormalizer();
  for await (const frame of readSseDataFrames(body)) {
    for (const event of normalizer.consume(frame)) writer.emit(event);
    if (normalizer.hasTerminated) return;
  }
  normalizer.finish();
}

export async function collectLlamaCppChatStream(body: ReadableStream<Uint8Array>): Promise<{
  text: string; thinking: string; usage?: ModelTokenUsage; doneReason?: string;
}> {
  let text = "";
  let thinking = "";
  let usage: ModelTokenUsage | undefined;
  let doneReason: string | undefined;
  await forwardLlamaCppChatStream(body, {
    emit(event: ModelGatewayEvent) {
      if (event.type === "content") text += event.text;
      else if (event.type === "thinking") thinking += event.text;
      else if (event.type === "error") throw new Error(event.error);
      else {
        usage = event.usage;
        doneReason = event.doneReason ?? undefined;
      }
    },
  });
  return { text, thinking, ...(usage ? { usage } : {}), ...(doneReason ? { doneReason } : {}) };
}
