import type { ModelTokenUsage } from "../../types.js";
import type { ModelProviderEventSink } from "../contracts.js";
import { readOpenAIDataFrames } from "./sse-data.js";
import {
  OpenAIResponsesStreamNormalizer,
  writeNormalizedOpenAIEvents,
  type NormalizedOpenAIStreamEvent,
  type OpenAIResponsesStreamOptions,
} from "./stream-normalizer.js";

export async function forwardOpenAIResponsesStream(
  body: ReadableStream<Uint8Array>,
  sink: ModelProviderEventSink,
  options: OpenAIResponsesStreamOptions = {},
): Promise<void> {
  const normalizer = new OpenAIResponsesStreamNormalizer(options);
  for await (const dataLine of readOpenAIDataFrames(body)) {
    if (dataLine === "[DONE]") {
      writeNormalizedOpenAIEvents(normalizer.finish(), sink);
      break;
    }
    try {
      const event = JSON.parse(dataLine) as unknown;
      writeNormalizedOpenAIEvents(normalizer.consume(event), sink);
    } catch {
      // Keep gateway behavior: ignore malformed upstream stream chunks.
    }
    if (normalizer.hasTerminated) break;
  }
  writeNormalizedOpenAIEvents(normalizer.end(), sink);
}

type CollectedOpenAIResponse = {
  text: string;
  usage?: ModelTokenUsage;
  doneReason?: string;
};

function applyCollectedEvent(
  collected: CollectedOpenAIResponse,
  event: NormalizedOpenAIStreamEvent,
): void {
  switch (event.type) {
    case "content":
      collected.text += event.text;
      return;
    case "done":
      collected.usage = event.usage;
      collected.doneReason = event.doneReason;
      return;
    case "error":
      throw new Error(`openai_stream_error: ${event.error}`);
  }
}

export async function collectOpenAIResponsesStream(
  body: ReadableStream<Uint8Array>,
  options: OpenAIResponsesStreamOptions = {},
): Promise<{
  text: string;
  thinking: string;
  usage?: ModelTokenUsage;
  doneReason?: string;
}> {
  const normalizer = new OpenAIResponsesStreamNormalizer(options);
  const collected: CollectedOpenAIResponse = { text: "" };

  for await (const dataLine of readOpenAIDataFrames(body)) {
    if (dataLine === "[DONE]") {
      for (const event of normalizer.finish()) {
        applyCollectedEvent(collected, event);
      }
      break;
    }

    let event: unknown;
    try {
      event = JSON.parse(dataLine);
    } catch {
      // Keep gateway behavior: ignore malformed upstream stream chunks.
      continue;
    }
    for (const normalized of normalizer.consume(event)) {
      applyCollectedEvent(collected, normalized);
    }
    if (normalizer.hasTerminated) break;
  }

  for (const event of normalizer.end()) {
    applyCollectedEvent(collected, event);
  }
  return {
    text: collected.text,
    thinking: "",
    ...(collected.usage ? { usage: collected.usage } : {}),
    ...(collected.doneReason ? { doneReason: collected.doneReason } : {}),
  };
}
