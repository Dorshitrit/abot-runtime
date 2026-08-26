import type { ToolRequestAttachment } from "../../../capabilities/tool-types.js";

export function appendRequestAttachmentManifest(
  prompt: string,
  attachments: readonly ToolRequestAttachment[],
): string {
  if (attachments.length === 0) {
    return prompt;
  }
  const manifest = attachments.map((attachment) =>
    [
      `id=${JSON.stringify(attachment.id)}`,
      `name=${JSON.stringify(attachment.name ?? attachment.id)}`,
      `mime=${JSON.stringify(attachment.mimeType)}`,
      ...(attachment.size === undefined ? [] : [`bytes=${attachment.size}`]),
    ].join(" "),
  );
  return [
    prompt,
    "",
    "Attached files available through the document reader tool:",
    ...manifest.map((entry) => `- ${entry}`),
  ].join("\n");
}
