import { isPlainObject } from "../../structured-output/format-contract.js";

type ItemIdentity = Readonly<{ index: number; id: string; callId: string; name: string }>;
type CompletedProjection = Readonly<{ response: unknown } | { error: string }>;

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOutputIndex(value: unknown): value is number {
  if (!Number.isSafeInteger(value)) return false;
  return Number(value) >= 0;
}

function readIdentity(event: Record<string, unknown>, item: Record<string, unknown>): ItemIdentity | undefined {
  if (!isOutputIndex(event.output_index)) return undefined;
  if (!nonemptyString(item.id)) return undefined;
  if (!nonemptyString(item.call_id)) return undefined;
  if (!nonemptyString(item.name)) return undefined;
  return { index: Number(event.output_index), id: item.id, callId: item.call_id, name: item.name };
}

function sameIdentity(first: ItemIdentity, second: ItemIdentity): boolean {
  return first.index === second.index && first.id === second.id
    && first.callId === second.callId && first.name === second.name;
}

function hasRefusal(item: Record<string, unknown>): boolean {
  if (!Array.isArray(item.content)) return false;
  return item.content.some((part) => isPlainObject(part) && part.type === "refusal");
}

function hasEmptyCompletedOutput(value: unknown): value is Record<string, unknown> & { output: [] } {
  if (!isPlainObject(value) || value.status !== "completed") return false;
  return Array.isArray(value.output) && value.output.length === 0;
}

/** Retain at most one finalized function, never an argument-delta transcript. */
export class OpenAICompletedFunctionItems {
  private readonly nonFunctionIndexes = new Set<number>();
  private responseId?: string;
  private identity?: ItemIdentity;
  private completed?: Record<string, unknown>;
  private argumentsDone?: string;
  private conflict = false;
  private refused = false;

  observe(event: Record<string, unknown>): void {
    if (event.type === "response.created" || event.type === "response.in_progress") {
      const response = isPlainObject(event.response) ? event.response : {};
      if (!nonemptyString(response.id)) { this.conflict = true; return; }
      if (this.responseId && this.responseId !== response.id) this.conflict = true;
      this.responseId ??= response.id;
      return;
    }
    if (event.response_id !== undefined && event.response_id !== this.responseId) this.conflict = true;
    if (event.type === "response.refusal.delta" || event.type === "response.refusal.done") this.refused = true;
    if (event.type === "response.function_call_arguments.delta" || event.type === "response.function_call_arguments.done") {
      this.observeArguments(event);
      return;
    }
    if (event.type !== "response.output_item.added" && event.type !== "response.output_item.done") return;
    const item = isPlainObject(event.item) ? event.item : {};
    if (hasRefusal(item)) this.refused = true;
    if (item.type !== "function_call") {
      this.observeNonFunctionIndex(event.output_index);
      return;
    }
    this.observeFunction(event, item);
  }

  private observeNonFunctionIndex(index: unknown): void {
    if (!isOutputIndex(index)) return;
    this.nonFunctionIndexes.add(index);
    if (this.identity?.index === index) this.conflict = true;
  }

  private hasNonFunctionIndex(index: number): boolean {
    return this.nonFunctionIndexes.has(index);
  }

  private observeArguments(event: Record<string, unknown>): void {
    if (!this.identity) { this.conflict = true; return; }
    if (event.item_id !== this.identity.id || event.output_index !== this.identity.index) {
      this.conflict = true;
      return;
    }
    if (event.type !== "response.function_call_arguments.done") return;
    if (typeof event.arguments !== "string") { this.conflict = true; return; }
    if (this.argumentsDone !== undefined && this.argumentsDone !== event.arguments) this.conflict = true;
    this.argumentsDone = event.arguments;
    if (this.completed && this.completed.arguments !== event.arguments) this.conflict = true;
  }

  private observeFunction(event: Record<string, unknown>, item: Record<string, unknown>): void {
    const identity = readIdentity(event, item);
    if (!identity) { this.conflict = true; return; }
    if (this.hasNonFunctionIndex(identity.index)) { this.conflict = true; return; }
    if (this.identity && !sameIdentity(this.identity, identity)) { this.conflict = true; return; }
    if (event.type === "response.output_item.added") {
      if (this.completed) this.conflict = true;
      this.identity ??= identity;
      return;
    }
    if (!this.identity) { this.conflict = true; return; }
    if (item.status !== undefined && item.status !== "completed") { this.conflict = true; return; }
    if (typeof item.arguments !== "string") { this.conflict = true; return; }
    if (this.argumentsDone !== undefined && this.argumentsDone !== item.arguments) this.conflict = true;
    if (this.completed && this.completed.arguments !== item.arguments) this.conflict = true;
    this.completed = item;
  }

  project(response: unknown): CompletedProjection {
    // Nonempty snapshots retain their existing authority; absence is not an empty snapshot.
    if (!hasEmptyCompletedOutput(response)) return { response };
    if (!this.responseId || response.id !== this.responseId) {
      return { error: "openai completed function response identity mismatch" };
    }
    if (this.conflict) return { error: "openai completed function items conflict" };
    if (this.refused) return { error: "openai completed function response refused" };
    if (response.error != null || response.incomplete_details != null) {
      return { error: "openai completed function response contains a failure" };
    }
    if (!this.completed) return { error: "openai function item not completed" };
    return { response: { ...response, output: [this.completed] } };
  }
}
