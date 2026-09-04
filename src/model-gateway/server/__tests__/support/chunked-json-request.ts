import { IncomingMessage } from "node:http";
import { Socket } from "node:net";

/** Delivers exact byte boundaries without relying on TCP packet scheduling. */
export function createChunkedJsonRequest(
  body: unknown,
  splitOffsets: readonly number[],
): IncomingMessage {
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  const boundaries = [0, ...splitOffsets, bytes.length];
  const request = new IncomingMessage(new Socket());
  let chunkIndex = 0;

  request._read = () => {};
  const pushNextChunk = () => {
    if (chunkIndex === boundaries.length - 1) {
      request.push(null);
      return;
    }
    const chunk = bytes.subarray(
      boundaries[chunkIndex],
      boundaries[chunkIndex + 1],
    );
    chunkIndex += 1;
    request.push(chunk);
    setImmediate(pushNextChunk);
  };
  setImmediate(pushNextChunk);
  return request;
}
