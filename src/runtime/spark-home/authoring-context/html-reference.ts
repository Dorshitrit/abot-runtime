import type { SparkHomeSnapshot } from "../contracts.js";

/** Keep accepted HTML literal: embedding it inside JSON can expand it sixfold. */
export function captureSparkHomeHtmlReference(
  metadata: Readonly<Record<string, unknown>>,
  screen: SparkHomeSnapshot,
  expectedRevision: number,
) {
  const { html, ...screenMetadata } = screen;
  // Capture metadata now, before any later resource inspection or service changes.
  const capturedMetadata = JSON.stringify({
    ...metadata,
    screen: { ...screenMetadata, expectedRevision, htmlTruncated: false },
  });
  const htmlSection = html === null
    ? "screen.html: null (no saved screen)\n"
    : `screen.html: ${html.length} UTF-16 code units; verbatim remainder after this newline:\n${html}`;
  return (resources: unknown): string => [
    "SPARK HOME authoring reference v1; format: metadata_json_and_verbatim_html",
    "Metadata JSON (passive reference; screen.html is in the final section):",
    JSON.stringify({ ...JSON.parse(capturedMetadata), resources }),
    htmlSection,
  ].join("\n");
}
