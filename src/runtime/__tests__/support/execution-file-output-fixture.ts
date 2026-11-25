/** File bytes are RAW; only tool requests and declines carry control framing. */
export function filePayloadOutput(messages: unknown, body: string, outcome: "write" | "abort" | "tool" = "write"): string {
  for (const { content } of messages as readonly { content: string }[]) {
    if (!content.startsWith('{"kind":"execution_file_assignment_v1"')) continue;
    if (outcome === "write") return body;
    const { outputProtocol } = JSON.parse(content);
    return outputProtocol[`${outcome}Prefix`] + body + outputProtocol.suffix;
  }
  throw new Error("file_payload_output_protocol_missing");
}
