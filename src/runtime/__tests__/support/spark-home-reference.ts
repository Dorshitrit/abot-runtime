import { expect } from "vitest";

/** Test reader for the self-describing HOME format; no production parser is needed. */
export function readSparkHomeReference(content: string): Record<string, any> {
  if (content.startsWith("{")) return JSON.parse(content);
  const headerEnd = content.indexOf("\n");
  const descriptionEnd = content.indexOf("\n", headerEnd + 1);
  const metadataEnd = content.indexOf("\n", descriptionEnd + 1);
  const labelEnd = content.indexOf("\n", metadataEnd + 1);
  expect(content.slice(0, headerEnd)).toBe(
    "SPARK HOME authoring reference v1; format: metadata_json_and_verbatim_html");
  const metadata = JSON.parse(content.slice(descriptionEnd + 1, metadataEnd));
  const label = content.slice(metadataEnd + 1, labelEnd);
  const remainder = content.slice(labelEnd + 1);
  let html: string | null = null;
  if (label === "screen.html: null (no saved screen)") expect(remainder).toBe("");
  else {
    const match = /^screen\.html: (\d+) UTF-16 code units; verbatim remainder after this newline:$/.exec(label);
    expect(match).not.toBeNull();
    expect(remainder.length).toBe(Number(match![1]));
    html = remainder;
  }
  return { ...metadata, screen: { ...metadata.screen, html } };
}
