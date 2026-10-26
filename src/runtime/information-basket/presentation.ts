import type { RequestExecutionSeed } from "../request/contracts.js";
import { emitRuntimeStatus } from "../events/runtime-status.js";
import type { BasketSearchResult } from "./contracts.js";

type PresentationTarget = Pick<RequestExecutionSeed, "onEvent">;
const MAXIMUM_NAMES = 5;
const MAXIMUM_NAME_CHARACTERS = 120;

/** Display metadata only. Never include queries, paths, source bodies, or failure details. */
export function basketSourceDisplayName(name: string): string {
  const clean = name.replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\s+/gu, " ").trim();
  const characters = Array.from(clean);
  return characters.length > MAXIMUM_NAME_CHARACTERS
    ? characters.slice(0, MAXIMUM_NAME_CHARACTERS - 1).join("") + "…"
    : clean || "Unnamed source";
}

export function basketSearchSummary(result: BasketSearchResult): string {
  if (result.status === "unavailable") return "Information basket search unavailable.";
  if (result.status === "empty" || result.sources.length === 0)
    return "No relevant information basket sources found.";
  const count = result.sources.length;
  const names = result.sources.slice(0, MAXIMUM_NAMES).map(source => basketSourceDisplayName(source.displayName));
  const omittedNames = count - names.length;
  return "Found " + count + " relevant information basket " + (count === 1 ? "source" : "sources") +
    ": " + names.join(", ") + "." +
    (omittedNames > 0 ? " " + omittedNames + " additional source names omitted." : "") +
    (result.omittedCount > 0 ? " " + result.omittedCount + " further matches omitted." : "");
}

export function emitBasketDiscovery(target: PresentationTarget, result: BasketSearchResult): void {
  if (result.status !== "found" || result.sources.length === 0) return;
  emitBasketStatus(target, "discovery_found", basketSearchSummary(result));
}

function emitBasketStatus(target: PresentationTarget, phase: string, message: string): void {
  try {
    emitRuntimeStatus(target, { stage: "information_basket", phase, message });
  } catch {
    // Optional display must not change retrieval, captured evidence, or request completion.
  }
}
