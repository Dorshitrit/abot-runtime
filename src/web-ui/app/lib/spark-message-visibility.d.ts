type SparkMessageVisibilityInput = Readonly<{ role?: string; kind?: string }>;

export function isSparkConversationMessage(message: SparkMessageVisibilityInput): boolean;
export function isSparkAssistantMessage(message: SparkMessageVisibilityInput): boolean;
