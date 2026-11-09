import { Parser } from "htmlparser2";
import { findSparkHomeWidget, SPARK_HOME_WIDGET_LIMIT, type SparkHomeWidgetSlot } from "./catalog.js";

function startsBrowserTextContent(name: string, ancestors: readonly string[]): boolean {
  if (ancestors.includes("svg")) return false;
  if (ancestors.includes("math")) return false;
  return ["noscript", "iframe", "noembed", "noframes", "plaintext"].includes(name);
}

function browserTextContentEnd(html: string, name: string, start: number): number {
  if (name === "plaintext") return html.length;
  const closingTag = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, "ig");
  closingTag.lastIndex = start;
  return closingTag.exec(html)?.index ?? html.length;
}

function canCaptureWidgetElement(name: string, attributes: Record<string, string>, ancestors: readonly string[]): boolean {
  if (name !== "div") return false;
  if (Object.hasOwn(attributes, "data-abot-widget-slot")) return false;
  if (ancestors.includes("template")) return false;
  if (ancestors.includes("svg")) return false;
  return !ancestors.includes("math");
}

function canAddWidgetSlot(id: string, seen: ReadonlySet<string>, count: number): boolean {
  if (seen.has(id)) return false;
  return count < SPARK_HOME_WIDGET_LIMIT;
}

/** Select registered static slots without executing or trusting generated JavaScript. */
export function captureSparkHomeWidgetSlots(html: string): Readonly<{ html: string; slots: readonly SparkHomeWidgetSlot[]; firstSlotOffset: number | null }> {
  const slots: SparkHomeWidgetSlot[] = [];
  let firstSlotOffset: number | null = null;
  const insertions: { offset: number; text: string }[] = [];
  const seen = new Set<string>();
  const ancestors: string[] = [];
  let textEnd = 0;
  const parser = new Parser({
    onopentag(name, attributes) {
      if (startsBrowserTextContent(name, ancestors)) textEnd = browserTextContentEnd(html, name, parser.endIndex + 1);
      const eligible = canCaptureWidgetElement(name, attributes, ancestors);
      ancestors.push(name);
      if (!eligible) return;
      const widget = findSparkHomeWidget(attributes["data-abot-widget"]);
      if (!widget) return;
      if (!canAddWidgetSlot(widget.id, seen, slots.length)) return;
      firstSlotOffset ??= parser.startIndex;
      const instanceId = `home-widget-${slots.length + 1}`;
      slots.push(Object.freeze({ instanceId, widgetId: widget.id, defaultHeight: widget.defaultHeight }));
      seen.add(widget.id);
      const offset = html[parser.endIndex - 1] === "/" ? parser.endIndex - 1 : parser.endIndex;
      insertions.push({ offset, text: ` data-abot-widget-slot="${instanceId}"` });
    },
    onclosetag() { ancestors.pop(); },
  }, { decodeEntities: true });
  // Feed raw-text bodies as equal-length whitespace so offsets still address the authored HTML.
  // htmlparser2 does not implement these scripting-enabled browser text states itself.
  let offset = 0;
  while (offset < html.length) {
    if (textEnd > offset) {
      parser.write(" ".repeat(textEnd - offset));
      offset = textEnd;
      continue;
    }
    const delimiter = html.indexOf(">", offset);
    const end = delimiter < 0 ? html.length : delimiter + 1;
    parser.write(html.slice(offset, end));
    offset = end;
  }
  parser.end();
  let rendered = html;
  for (const insertion of insertions.reverse())
    rendered = rendered.slice(0, insertion.offset) + insertion.text + rendered.slice(insertion.offset);
  // No inserted attributes precede the first slot, so this offset also binds to rendered HTML.
  return { html: rendered, slots: Object.freeze(slots), firstSlotOffset };
}
