export type BoundedTextMetadata = Readonly<{
  truncated: boolean;
  originalChars: number;
  returnedChars: number;
  omittedChars: number;
}>;

export type BoundedText = Readonly<{
  text: string;
  metadata: BoundedTextMetadata;
}>;

export function boundText(
  value: string,
  options: Readonly<{ maxChars: number; marker?: string }>,
): BoundedText {
  if (!Number.isSafeInteger(options.maxChars) || options.maxChars < 0) {
    throw new RangeError("maxChars must be a non-negative safe integer");
  }
  const marker = options.marker ?? "\n[truncated]";
  const truncated = value.length > options.maxChars;
  const boundedMarker = marker.slice(0, options.maxChars);
  const sourceChars = truncated
    ? Math.max(options.maxChars - boundedMarker.length, 0)
    : value.length;
  const text = truncated ? value.slice(0, sourceChars) + boundedMarker : value;
  return Object.freeze({
    text,
    metadata: Object.freeze({
      truncated,
      originalChars: value.length,
      returnedChars: text.length,
      omittedChars: Math.max(value.length - sourceChars, 0),
    }),
  });
}

export type BoundedCollectionMetadata = Readonly<{
  truncated: boolean;
  totalItems: number;
  returnedItems: number;
  omittedItems: number;
}>;

export type BoundedCollection<T> = Readonly<{
  items: readonly T[];
  metadata: BoundedCollectionMetadata;
}>;

export function boundCollection<T>(
  values: readonly T[],
  options: Readonly<{ maxItems: number }>,
): BoundedCollection<T> {
  if (!Number.isSafeInteger(options.maxItems) || options.maxItems < 0) {
    throw new RangeError("maxItems must be a non-negative safe integer");
  }
  const items = Object.freeze(values.slice(0, options.maxItems));
  return Object.freeze({
    items,
    metadata: Object.freeze({
      truncated: values.length > items.length,
      totalItems: values.length,
      returnedItems: items.length,
      omittedItems: values.length - items.length,
    }),
  });
}

export function sanitizeJsonText(value: string): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      const preservedWhitespace =
        codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d;
      const unsafeControl =
        (codePoint < 0x20 && !preservedWhitespace) ||
        (codePoint >= 0x7f && codePoint <= 0x9f);
      const unpairedSurrogate = codePoint >= 0xd800 && codePoint <= 0xdfff;
      return unsafeControl || unpairedSurrogate ? "�" : character;
    })
    .join("");
}
