import type { ModelTokenUsage } from "../../types.js";
import type { ModelProviderEventSink } from "../contracts.js";
import {
  OpenAIResponsesStreamNormalizer,
  writeNormalizedOpenAIEvents,
  type NormalizedOpenAIStreamEvent,
  type OpenAIResponsesStreamOptions,
} from "./stream-normalizer.js";

function parseSseEvents(buffer: string): { events: string[]; rest: string } {
  const events: string[] = [];
  let remaining = buffer;
  let boundaryIndex: number;
  while ((boundaryIndex = remaining.indexOf("\n\n")) !== -1) {
    events.push(remaining.slice(0, boundaryIndex));
    remaining = remaining.slice(boundaryIndex + 2);
  }
  return { events, rest: remaining };
}

function readSseData(eventBlock: string): string[] {
  return eventBlock
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter(Boolean);
}

async function* readOpenAIDataLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    const parsed = parseSseEvents(buffer);
    buffer = parsed.rest;

    for (const eventBlock of parsed.events) {
      for (const dataLine of readSseData(eventBlock)) {
        yield dataLine;
      }
    }
    if (done) {
      break;
    }
  }
}

export async function forwardOpenAIResponsesStream(
  body: ReadableStream<Uint8Array>,
  sink: ModelProviderEventSink,
  options: OpenAIResponsesStreamOptions = {},
): Promise<void> {
  const normalizer = new OpenAIResponsesStreamNormalizer(options);
  for await (const dataLine of readOpenAIDataLines(body)) {
    if (dataLine === "[DONE]") {
      writeNormalizedOpenAIEvents(normalizer.finish(), sink);
      continue;
    }
    try {
      const event = JSON.parse(dataLine) as unknown;
      writeNormalizedOpenAIEvents(normalizer.consume(event), sink);
    } catch {
      // Keep gateway behavior: ignore malformed upstream stream chunks.
    }
  }
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

  for await (const dataLine of readOpenAIDataLines(body)) {
    if (dataLine === "[DONE]") {
      for (const event of normalizer.finish()) {
        applyCollectedEvent(collected, event);
      }
      continue;
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
  }

  return {
    text: collected.text,
    thinking: "",
    ...(collected.usage ? { usage: collected.usage } : {}),
    ...(collected.doneReason ? { doneReason: collected.doneReason } : {}),
  };
}
