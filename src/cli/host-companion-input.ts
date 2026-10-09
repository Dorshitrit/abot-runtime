import type { Readable } from "node:stream";

/** Native launchers send short-lived secrets through bounded stdin, never shell arguments. */
export async function readHostCompanionInput(
  input: Readable,
  maxBytes = 16_384,
): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  const deadline = setTimeout(() => {
    input.destroy(new Error("Host setup input timed out."));
  }, 10_000);
  try {
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > maxBytes)
        throw new Error("Host setup input exceeds the size limit.");
      chunks.push(bytes);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    clearTimeout(deadline);
  }
}
