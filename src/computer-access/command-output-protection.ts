import { readFile, rm, writeFile } from "node:fs/promises";

export type CapturedOutputPaths = Readonly<{ stdout: string; stderr: string }>;
export type ProtectedOutputBytes = Readonly<{ stdout: Buffer; stderr: Buffer }>;
export type OutputProtectionFailure = "output_protection_failed" | "output_storage_failed";

export class CapturedOutputProtectionError extends Error {
  constructor(readonly reason: OutputProtectionFailure) { super(reason); }
}

/** Check both complete private streams before replacing either source. */
export async function protectCapturedOutput(paths: CapturedOutputPaths, redact: (text: string) => string): Promise<ProtectedOutputBytes> {
  let stdout: Buffer | undefined, stderr: Buffer | undefined;
  try {
    stdout = await protectStream(paths.stdout, redact);
    stderr = await protectStream(paths.stderr, redact);
    const writes = await Promise.allSettled([
      writeFile(paths.stdout, stdout, { flag: "w", mode: 0o600, flush: true }),
      writeFile(paths.stderr, stderr, { flag: "w", mode: 0o600, flush: true }),
    ]);
    if (hasRejectedOutputWrite(writes)) throw new CapturedOutputProtectionError("output_storage_failed");
    return { stdout, stderr };
  } catch (error) {
    stdout?.fill(0); stderr?.fill(0);
    throw error;
  }
}

async function protectStream(path: string, redact: (text: string) => string): Promise<Buffer> {
  let bytes: Buffer;
  try { bytes = await readFile(path); }
  catch { throw new CapturedOutputProtectionError("output_storage_failed"); }
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const protectedText = redact(text);
    if (!isProtectedOutputText(protectedText)) throw new Error("output_protection_failed");
    return Buffer.from(protectedText, "utf8");
  } catch { throw new CapturedOutputProtectionError("output_protection_failed"); }
  finally { bytes.fill(0); }
}

/** A failed check makes the private sources unavailable, including later reads. */
export async function discardCapturedOutput(paths: CapturedOutputPaths): Promise<boolean> {
  const removed = await Promise.allSettled(Object.values(paths).map((path) => rm(path, { force: true })));
  return removed.every((entry) => entry.status === "fulfilled");
}

function isProtectedOutputText(value: unknown): value is string { return typeof value === "string"; }
function hasRejectedOutputWrite(writes: readonly PromiseSettledResult<void>[]): boolean {
  return writes.some((entry) => entry.status === "rejected");
}
