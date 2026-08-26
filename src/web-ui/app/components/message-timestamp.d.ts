export type MessageTimestampPresentation = Readonly<{
  dateTime: string;
  label: string;
  title: string;
}>;

export function buildMessageTimestamp(
  value: unknown,
  options?: Readonly<{
    locales?: Intl.LocalesArgument;
    timeZone?: string;
  }>,
): MessageTimestampPresentation | null;

export function createMessageTimestamp(
  options: Readonly<{
    documentRoot: Document;
    value: unknown;
    locales?: Intl.LocalesArgument;
    timeZone?: string;
  }>,
): HTMLTimeElement | null;
