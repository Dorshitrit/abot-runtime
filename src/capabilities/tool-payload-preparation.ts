import type { ToolCallAdapterInput } from "./tool-types.js";
import type { ToolExecutionBindingContext } from "./tool-execution-binding.js";

/** Plugin-owned, read-only source capture before content authoring. */
export type ToolPreparedPayloadContext = Readonly<{
  authoringContract: string;
  context: Readonly<Record<string, unknown>>;
  responseFormat?: "json" | Readonly<Record<string, unknown>>;
}>;

export type ToolPreparedPayload = ToolPreparedPayloadContext & Readonly<{
  /** Binds exact authored bytes to the captured source; never runs a model. */
  bind(body: string): string;
}>;

export type ToolPayloadPreparation = (
  input: ToolCallAdapterInput,
  context: ToolExecutionBindingContext,
) => Promise<ToolPreparedPayload>;
