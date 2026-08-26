import type {
  ChatMessage,
  ModelTokenEstimationConfig,
} from "../../model-gateway/types.js";

const DEFAULT_ASCII_CHARACTERS_PER_TOKEN = 2;
const DEFAULT_NON_ASCII_BYTES_PER_TOKEN = 2;
const DEFAULT_MESSAGE_OVERHEAD_TOKENS = 6;

export function estimateTextTokens(
  text: string,
  config: ModelTokenEstimationConfig = {},
): number {
  let asciiCharacters = 0;
  let nonAsciiBytes = 0;

  for (const character of text) {
    if (character.codePointAt(0)! <= 0x7f) {
      asciiCharacters += 1;
    } else {
      nonAsciiBytes += Buffer.byteLength(character, "utf8");
    }
  }

  return (
    estimateAsciiCharacterTokens(asciiCharacters, config) +
    estimateNonAsciiByteTokens(nonAsciiBytes, config)
  );
}

export function estimateAsciiCharacterTokens(
  characterCount: number,
  config: ModelTokenEstimationConfig = {},
): number {
  return Math.ceil(
    nonNegativeFiniteOrZero(characterCount) /
      positiveOrDefault(
        config.asciiCharactersPerToken,
        DEFAULT_ASCII_CHARACTERS_PER_TOKEN,
      ),
  );
}

export function estimateNonAsciiByteTokens(
  byteCount: number,
  config: ModelTokenEstimationConfig = {},
): number {
  return Math.ceil(
    nonNegativeFiniteOrZero(byteCount) /
      positiveOrDefault(
        config.nonAsciiBytesPerToken,
        DEFAULT_NON_ASCII_BYTES_PER_TOKEN,
      ),
  );
}

export function estimateMessageTokens(
  message: ChatMessage,
  config: ModelTokenEstimationConfig = {},
): number {
  const messageOverheadTokens = positiveOrDefault(
    config.messageOverheadTokens,
    DEFAULT_MESSAGE_OVERHEAD_TOKENS,
  );
  if (message.toolCalls !== undefined) {
    return message.toolCalls.reduce(
      (total, call) =>
        total +
        messageOverheadTokens +
        estimateTextTokens(call.callId, config) +
        estimateTextTokens(call.name, config) +
        estimateTextTokens(call.arguments, config),
      0,
    );
  }
  if (message.role === "tool") {
    return (
      messageOverheadTokens +
      estimateTextTokens(message.toolCallId, config) +
      estimateTextTokens(message.toolName, config) +
      estimateTextTokens(message.content, config)
    );
  }
  return messageOverheadTokens + estimateTextTokens(message.content, config);
}

export function estimateMessagesTokens(
  messages: readonly ChatMessage[],
  config: ModelTokenEstimationConfig = {},
): number {
  return messages.reduce(
    (total, message) => total + estimateMessageTokens(message, config),
    0,
  );
}

function positiveOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function nonNegativeFiniteOrZero(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
