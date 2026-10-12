const MAX_LINE_CHARACTERS = 32_768;
const MAX_DATA_CHARACTERS = 32_768;
const MAX_EVENT_TYPE_CHARACTERS = 128;
const MAX_EVENT_TYPES = 32;
const MAX_RECENT_EVENTS = 32;

/** Bounded SSE metadata only; never selects or forwards model output. */
export class ProviderSseDiagnostics {
  private pendingLine = "";
  private droppingLine = false;
  private afterCarriageReturn = false;
  private eventType: string | undefined;
  private hasData = false;
  private data = "";
  private dataTruncated = false;
  private eventCount = 0;
  private oversizedLineCount = 0;
  private readonly counts = new Map<string, number>();
  private readonly recentEvents: { type: string; afterMs: number }[] = [];

  observe(text: string, afterMs: number): void {
    if (text.length === 0) return;
    let start = this.afterCarriageReturn && text.startsWith("\n") ? 1 : 0;
    this.afterCarriageReturn = text.endsWith("\r");
    const lineEndings = /\r\n|\r|\n/gu;
    while (start < text.length) {
      lineEndings.lastIndex = start;
      const ending = lineEndings.exec(text);
      this.appendLinePart(text.slice(start, ending?.index));
      if (!ending) return;
      this.finishLine(afterMs);
      start = ending.index + ending[0].length;
    }
  }

  snapshot() {
    return {
      eventCount: this.eventCount,
      eventTypes: Object.fromEntries(this.counts),
      recentEvents: [...this.recentEvents],
      oversizedLineCount: this.oversizedLineCount,
    };
  }

  private appendLinePart(part: string): void {
    if (this.droppingLine) return;
    const remaining = MAX_LINE_CHARACTERS - this.pendingLine.length;
    this.pendingLine += part.slice(0, remaining);
    if (part.length <= remaining) return;
    this.droppingLine = true;
    this.oversizedLineCount += 1;
  }

  private finishLine(afterMs: number): void {
    const line = this.pendingLine;
    const truncated = this.droppingLine;
    this.pendingLine = "";
    this.droppingLine = false;
    if (line === "") {
      this.finishEvent(afterMs);
      return;
    }
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") {
      this.eventType = value.slice(0, MAX_EVENT_TYPE_CHARACTERS);
      return;
    }
    if (field !== "data") return;
    this.hasData = true;
    this.appendData(value, truncated);
  }

  private appendData(value: string, truncated: boolean): void {
    if (this.dataTruncated) return;
    if (truncated || this.data.length + value.length + 1 > MAX_DATA_CHARACTERS) {
      this.dataTruncated = true;
      this.data = "";
      return;
    }
    this.data += value + "\n";
  }

  private finishEvent(afterMs: number): void {
    const hasData = this.hasData;
    const type = this.eventType ?? readDataEventType(this.data.slice(0, -1));
    this.eventType = undefined;
    this.hasData = false;
    this.data = "";
    this.dataTruncated = false;
    if (!hasData) return;
    const recordedType = type || "message";
    const countKey = this.counts.has(recordedType) || this.counts.size < MAX_EVENT_TYPES
      ? recordedType : "(other)";
    this.counts.set(countKey, (this.counts.get(countKey) ?? 0) + 1);
    this.eventCount += 1;
    this.recentEvents.push({ type: recordedType, afterMs });
    if (this.recentEvents.length > MAX_RECENT_EVENTS) this.recentEvents.shift();
  }
}

function readDataEventType(data: string): string {
  if (data === "") return "";
  if (data === "[DONE]") return "[DONE]";
  try {
    const value: unknown = JSON.parse(data);
    if (value === null || typeof value !== "object" || !("type" in value)) return "";
    return typeof value.type === "string" ? value.type.slice(0, MAX_EVENT_TYPE_CHARACTERS) : "";
  } catch {
    return "";
  }
}
