import type { ModelTokenUsage } from "../types.js";
import type { ModelMetricMessage } from "./contracts.js";

function countMessageChars(
  messages: ModelMetricMessage[] | undefined,
  role?: string,
): number {
  return (messages ?? [])
    .filter((message) => !role || message.role === role)
    .reduce((sum, message) => sum + message.content.length, 0);
}

function countMessages(
  messages: ModelMetricMessage[] | undefined,
  role?: string,
): number {
  return (messages ?? []).filter((message) => !role || message.role === role)
    .length;
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function getSystemMessageMetricCategory(message: ModelMetricMessage): string {
  if (message.systemMessageKind) {
    return message.systemMessageKind;
  }
  if (message.contextMessageKind) {
    return message.contextMessageKind;
  }

  const normalized = message.content.trim();
  const firstLine = normalized.split("\n")[0]?.trim() || "unknown_system";
  return `system:${firstLine.slice(0, 80)}`;
}

function buildSystemMessageBreakdown(
  messages: ModelMetricMessage[] | undefined,
): Array<{
  category: string;
  count: number;
  chars: number;
  estimatedTokens: number;
}> {
  const byCategory = new Map<string, { count: number; chars: number }>();

  for (const message of messages ?? []) {
    if (message.role !== "system") {
      continue;
    }

    const category = getSystemMessageMetricCategory(message);
    const current = byCategory.get(category) ?? { count: 0, chars: 0 };
    current.count += 1;
    current.chars += message.content.length;
    byCategory.set(category, current);
  }

  return [...byCategory.entries()]
    .map(([category, value]) => ({
      category,
      count: value.count,
      chars: value.chars,
      estimatedTokens: estimateTokens(value.chars),
    }))
    .sort((left, right) => right.chars - left.chars);
}

export function buildModelInvocationMetrics(params: {
  requestId?: string;
  modelStep?: string;
  taskType?: string;
  agentMode?: string;
  text?: string;
  messages?: ModelMetricMessage[];
  outputText?: string;
  providerUsage?: ModelTokenUsage;
  terminalEventCount?: number;
  providerCompletionReason?: string | null;
  durationMs: number;
  status: "success" | "error";
  error?: string;
}): Record<string, unknown> {
  const textChars = params.text?.length ?? 0;
  const messagesChars = countMessageChars(params.messages);
  const toolCallCount = (params.messages ?? []).reduce(
    (total, message) => total + (message.toolCallCount ?? 0),
    0,
  );
  const toolResultCount = (params.messages ?? []).reduce(
    (total, message) => total + (message.toolResultCount ?? 0),
    0,
  );
  const systemChars = countMessageChars(params.messages, "system");
  const nonSystemChars = messagesChars - systemChars;
  const totalInputChars = messagesChars > 0 ? messagesChars : textChars;
  const outputChars = params.outputText?.length ?? 0;
  const systemMessageBreakdown = buildSystemMessageBreakdown(params.messages);
  const estimatedInputTokens = estimateTokens(totalInputChars);
  const estimatedOutputTokens = estimateTokens(outputChars);
  const inputTokens = params.providerUsage?.inputTokens ?? estimatedInputTokens;
  const outputTokens =
    params.providerUsage?.outputTokens ?? estimatedOutputTokens;
  const totalTokens =
    params.providerUsage?.totalTokens ?? inputTokens + outputTokens;
  const cachedInputTokens = params.providerUsage?.cachedInputTokens;

  return {
    requestId: params.requestId ?? "",
    modelStep: params.modelStep ?? "",
    taskType: params.taskType ?? "",
    agentMode: params.agentMode ?? "",
    messageCount: countMessages(params.messages),
    systemMessageCount: countMessages(params.messages, "system"),
    nonSystemMessageCount:
      countMessages(params.messages) - countMessages(params.messages, "system"),
    textChars,
    messagesChars,
    ...(toolCallCount > 0 || toolResultCount > 0
      ? { toolCallCount, toolResultCount }
      : {}),
    inputCharsSource: messagesChars > 0 ? "messages" : "text",
    systemChars,
    nonSystemChars,
    systemMessageBreakdown,
    largestSystemMessageCategory: systemMessageBreakdown[0]?.category ?? "",
    largestSystemMessageChars: systemMessageBreakdown[0]?.chars ?? 0,
    totalInputChars,
    estimatedInputTokens,
    outputChars,
    estimatedOutputTokens,
    tokenUsageSource: params.providerUsage ? "provider" : "estimated",
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cachedInputTokens !== undefined
      ? {
          cachedInputTokens,
          uncachedInputTokens: inputTokens - cachedInputTokens,
        }
      : {}),
    ...(params.providerUsage?.reasoningTokens !== undefined
      ? { reasoningTokens: params.providerUsage.reasoningTokens }
      : {}),
    ...(params.terminalEventCount !== undefined
      ? { terminalEventCount: params.terminalEventCount }
      : {}),
    ...("providerCompletionReason" in params
      ? { providerCompletionReason: params.providerCompletionReason }
      : {}),
    durationMs: params.durationMs,
    status: params.status,
    ...(params.error ? { error: params.error } : {}),
  };
}
