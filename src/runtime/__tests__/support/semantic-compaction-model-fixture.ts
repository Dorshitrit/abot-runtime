export function semanticCompactionDigestSlots(
  digests: readonly string[],
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    digests.map((digest, index) => [`source_${index}`, digest]),
  );
}

type TestModelMessage = Readonly<{ role: string; content: string }>;

export function readModelMessages(value: unknown): readonly TestModelMessage[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Expected model messages to be an array.");
  }
  const messages = value.filter(
    (message): message is TestModelMessage =>
      typeof message === "object" &&
      message !== null &&
      "role" in message &&
      typeof message.role === "string" &&
      "content" in message &&
      typeof message.content === "string",
  );
  if (messages.length !== value.length) {
    throw new TypeError(
      "Expected every model message to contain text content.",
    );
  }
  return messages;
}
