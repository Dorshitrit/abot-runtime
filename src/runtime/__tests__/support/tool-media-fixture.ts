import { deflateSync } from "node:zlib";
import type { ChatMessage } from "../../../model-gateway/types.js";
import type { ToolImageEvidence } from "../../../capabilities/tool-media.js";

export function toolImageFixture(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255, 0, 255, 0, 255]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, bytes: Buffer): Buffer {
  const output = Buffer.alloc(bytes.length + 12);
  output.writeUInt32BE(bytes.length);
  output.write(type, 4);
  bytes.copy(output, 8);
  let crc = 0xffffffff;
  for (const byte of output.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
  return output;
}

export function toolImageMessages(reference: ToolImageEvidence, lane: "root" | "worker" = "root"): ChatMessage[] {
  const result = {
    executionId: "execution-1", callId: "call-1",
    adapterResult: {
      kind: "registered_tool_execution_result_v1", authority: "registered_plugin", status: "executed",
      result: { tool: "fixture", ok: true, output: "Observed pixels.", producedNewInformation: true, media: [reference] },
    },
  };
  if (lane === "worker") return [
    { role: "user", content: "Inspect the surface." },
    { role: "user", content: JSON.stringify({ kind: "runtime_request_tool_results_v1", authority: "reference_data", results: [result] }) },
  ];
  return [
    { role: "user", content: "Inspect the surface." },
    { role: "assistant", content: "", toolCalls: [{ callId: "execution-1", name: "runtime_capability", arguments: "{}" }] },
    { role: "tool", toolCallId: "execution-1", toolName: "runtime_capability", content: JSON.stringify({ kind: "runtime_execution_capability_result_v1", result }) },
  ];
}
