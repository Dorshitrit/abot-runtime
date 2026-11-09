import { SparkHomeContextError } from "./error.js";
import type { ReferenceEntry, ReferenceSection } from "./contracts.js";

/** Whole entries are omitted deterministically; identity fields are never clipped. */
export function boundEntries<T extends ReferenceEntry>(
  entries: readonly T[], count: number, characterBudget: number,
  coverage: Readonly<{ availableCount?: number; scannedCount?: number; selection?: string }> = {},
): ReferenceSection<T> {
  const selected = entries.slice(0, count);
  const included: T[] = [];
  let characters = 2;
  for (const entry of selected) {
    const size = JSON.stringify(entry).length + 1;
    if (characters + size > characterBudget) continue;
    included.push(entry);
    characters += size;
  }
  return {
    status: (coverage.availableCount ?? entries.length) > 0 ? "available" : "empty", ...coverage,
    entries: included, characterBudget,
    omittedCount: Math.max(entries.length, coverage.availableCount ?? 0) - included.length,
    omittedByCount: Math.max(0, entries.length - selected.length),
    omittedByBudget: selected.length - included.length,
    omittedOutsideWindow: Math.max(0, (coverage.availableCount ?? entries.length) - entries.length),
  };
}

export function clippedText(text: string, limit: number) {
  return { text: text.slice(0, limit), omittedCharacters: Math.max(0, text.length - limit) };
}

export function inactiveSection(status: "disabled" | "blocked" | "unavailable", reason: string): ReferenceSection {
  return { status, reason, entries: [] };
}

export async function requireSource<T>(name: string, read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (error) {
    if (error instanceof SparkHomeContextError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new SparkHomeContextError(`spark_home_context_${name}_failed`,
      `SPARK HOME could not read the required ${name} source. No screen was generated.`);
  }
}

export function contextFailure(code: string, message: string): never {
  throw new SparkHomeContextError(`spark_home_context_${code}`, message);
}
