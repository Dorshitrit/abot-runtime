export type EventRecord = Record<string, unknown>;
export declare function buildEventTimelineEntries(
  events: EventRecord[],
): EventRecord[];
export declare function titleCaseEventValue(value: unknown): string;
export declare function formatToolName(rawTool: unknown): string;
export declare function getRecord(value: unknown): EventRecord | null;
export declare function getNumber(value: unknown, fallback?: number): number;
export declare function getPlanPayload(
  message: EventRecord,
): EventRecord | null;
export declare function getPlanItemPayload(
  message: EventRecord,
): EventRecord | null;
export declare function formatEventLabel(message: EventRecord): string;
export declare function formatEventDetail(message: EventRecord): string;
export declare function eventTone(message: EventRecord): string;
export declare function isLowValueActivityEvent(message: EventRecord): boolean;
export declare function eventKeyFor(
  message: EventRecord,
  label: string,
  tone: string,
): string;
