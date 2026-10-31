import { isPlainObject } from "../../structured-output/format-contract.js";

function isOpenAIRefusalPart(value: unknown): boolean {
  return isPlainObject(value) && value.type === "refusal";
}

function hasOpenAIMessageRefusal(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (value.type !== "message") return false;
  if (!Array.isArray(value.content)) return false;
  return value.content.some(isOpenAIRefusalPart);
}

function hasOpenAIResponseRefusal(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (!Array.isArray(value.output)) return false;
  return value.output.some(hasOpenAIMessageRefusal);
}

/** Provider refusal is a terminal failure, never malformed output to repair. */
export function isOpenAIRefusalEvent(event: Record<string, unknown>): boolean {
  if (event.type === "response.refusal.delta") return true;
  if (event.type === "response.refusal.done") return true;
  if (event.type === "response.output_item.added") return hasOpenAIMessageRefusal(event.item);
  if (event.type === "response.output_item.done") return hasOpenAIMessageRefusal(event.item);
  if (event.type === "response.completed") return hasOpenAIResponseRefusal(event.response);
  return false;
}
