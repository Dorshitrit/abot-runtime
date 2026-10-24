import { buildModelTokenUsage } from "../../protocol/usage.js";
import type { ModelGatewayEvent, ModelTokenUsage } from "../../types.js";

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function fail(code: string): never { throw new Error(`llamacpp_stream_${code}`); }

export class LlamaCppChatStreamNormalizer {
  private finishReason: string | undefined;
  private responseId: string | undefined;
  private usage: ModelTokenUsage | undefined;
  private terminated = false;

  get hasTerminated(): boolean { return this.terminated; }

  consume(data: string): ModelGatewayEvent[] {
    if (this.terminated) return [];
    if (data === "[DONE]") {
      if (!this.finishReason) fail("completion_missing");
      this.terminated = true;
      return [{ type: "done", done: true, doneReason: this.finishReason, ...(this.usage ? { usage: this.usage } : {}) }];
    }
    let chunk: unknown;
    try { chunk = JSON.parse(data); } catch { return fail("json_invalid"); }
    if (!record(chunk)) fail("chunk_invalid");
    if (chunk.error !== undefined) fail("provider_error");
    if (typeof chunk.id === "string") {
      if (this.responseId !== undefined && this.responseId !== chunk.id) fail("response_identity_changed");
      this.responseId = chunk.id;
    }
    if (record(chunk.usage)) {
      const promptDetails = record(chunk.usage.prompt_tokens_details) ? chunk.usage.prompt_tokens_details : {};
      const completionDetails = record(chunk.usage.completion_tokens_details) ? chunk.usage.completion_tokens_details : {};
      this.usage = buildModelTokenUsage({
        inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens,
        totalTokens: chunk.usage.total_tokens, cachedInputTokens: promptDetails.cached_tokens,
        reasoningTokens: completionDetails.reasoning_tokens,
      });
    }
    if (!Array.isArray(chunk.choices)) fail("choices_invalid");
    if (chunk.choices.length === 0) return [];
    if (chunk.choices.length !== 1) fail("multiple_choices");
    const choice: unknown = chunk.choices[0];
    if (!record(choice) || choice.index !== 0 || !record(choice.delta)) fail("choice_invalid");
    const delta = choice.delta;
    if (delta.tool_calls !== undefined || delta.function_call !== undefined) fail("unexpected_tool_call");
    if (delta.refusal) fail("refusal");
    const events: ModelGatewayEvent[] = [];
    for (const [key, type] of [["reasoning_content", "thinking"], ["content", "content"]] as const) {
      const value = delta[key];
      if (value === undefined || value === null || value === "") continue;
      if (typeof value !== "string") fail("delta_invalid");
      if (this.finishReason) fail("content_after_completion");
      events.push({ type, text: value });
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      if (this.finishReason) fail("duplicate_completion");
      if (choice.finish_reason !== "stop" && choice.finish_reason !== "length") fail("completion_reason_unsupported");
      this.finishReason = choice.finish_reason;
    }
    return events;
  }

  finish(): void {
    // A transport EOF or [DONE] alone must never authorize partial output.
    if (!this.terminated) fail("incomplete");
  }
}
