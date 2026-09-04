import { localName, type MarkupElement } from "./markup-tree.js";

export type OriginDates = Readonly<{
  publishedAt?: string;
  updatedAt?: string;
}>;

const PUBLISHED_METADATA_NAMES = [
  "article:published_time",
  "datepublished",
  "pubdate",
];
const UPDATED_METADATA_NAMES = [
  "article:modified_time",
  "datemodified",
  "lastmod",
];
const ISO_DATE =
  /^(\d{4}-\d{2}-\d{2})(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/u;

function normalizedOriginDate(raw: string): string | undefined {
  const value = raw.trim();
  if (value.length > 100) return undefined;
  const match = value.match(ISO_DATE);
  if (!match) return undefined;
  const dateOnly = match[1]!;
  const calendarTimestamp = Date.parse(`${dateOnly}T00:00:00.000Z`);
  if (!Number.isFinite(calendarTimestamp)) return undefined;
  if (new Date(calendarTimestamp).toISOString().slice(0, 10) !== dateOnly)
    return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : undefined;
}

function declaresMetadataDate(
  element: MarkupElement,
  names: readonly string[],
): boolean {
  if (localName(element) !== "meta") return false;
  const declared = [
    element.attributes.property,
    element.attributes.name,
    element.attributes.itemprop,
  ].flatMap((value) => (value ?? "").toLowerCase().split(/\s+/u));
  return declared.some((name) => names.includes(name));
}

function readMetadataDate(
  elements: readonly MarkupElement[],
  names: readonly string[],
): string | undefined {
  for (const element of elements) {
    if (!declaresMetadataDate(element, names)) continue;
    const date = normalizedOriginDate(element.attributes.content ?? "");
    if (date) return date;
  }
  return undefined;
}

export function readOriginDates(
  elements: readonly MarkupElement[],
): OriginDates {
  const publishedAt = readMetadataDate(elements, PUBLISHED_METADATA_NAMES);
  const updatedAt = readMetadataDate(elements, UPDATED_METADATA_NAMES);
  return Object.freeze({
    ...(publishedAt ? { publishedAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  });
}
