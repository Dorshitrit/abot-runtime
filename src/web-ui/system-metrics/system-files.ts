import { open, readdir } from "node:fs/promises";

export type ReadSystemText = (path: string) => Promise<string | null>;

/** Only adapter-owned proc/sys paths reach this reader. No shell and no caller-supplied paths. */
export const readSystemText: ReadSystemText = async path => {
  let file;
  try {
    file = await open(path, "r");
    const buffer = Buffer.alloc(path === "/proc/self/mountinfo" ? 131_072 : 16_384);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead === buffer.length) return null;
    return buffer.toString("utf8", 0, bytesRead).trim();
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => {});
  }
};

export async function listSystemDirectory(path: string): Promise<string[]> {
  try { return (await readdir(path)).sort(); } catch { return []; }
}

export function nonnegativeCounter(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
}
