import { parsePublicHttpUrl } from "../../network-policy.js";
import type { MarkupElement } from "./markup-tree.js";

export function boundedDiscoveryText(value: string, maxChars = 800): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxChars);
}

export function resolveDiscoveryUrl(
  value: string,
  base: string,
): string | undefined {
  if (!value || value.length > 4_096) return undefined;
  try {
    const parsed = parsePublicHttpUrl(new URL(value.trim(), base).toString());
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function elementBaseUrl(
  element: MarkupElement,
  documentUrl: string,
): string {
  const ancestors: MarkupElement[] = [];
  let current: MarkupElement | undefined = element;
  while (current) {
    ancestors.push(current);
    current = current.parent;
  }
  let base = documentUrl;
  for (const ancestor of ancestors.reverse()) {
    const declared = ancestor.attributes["xml:base"];
    if (declared) base = resolveDiscoveryUrl(declared, base) ?? base;
  }
  return base;
}

export function normalizedSourceDate(value: string): string | undefined {
  const bounded = value.trim().slice(0, 100);
  if (!bounded || !/[0-9]{4}/u.test(bounded)) return undefined;
  const timestamp = Date.parse(bounded);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : undefined;
}

export function assertCandidateLimit(maxCandidates: number): void {
  if (
    !Number.isSafeInteger(maxCandidates) ||
    maxCandidates < 0 ||
    maxCandidates > 10_000
  ) {
    throw new RangeError(
      "maxCandidates must be an integer between 0 and 10000",
    );
  }
}
