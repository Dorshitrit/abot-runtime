import { realpath } from "node:fs/promises";
import { openManagedRead } from "../host-files.js";
import { serverFailure, serverPath } from "./settings.js";

const scalarBytes = new Map([[0, 1], [1, 1], [2, 2], [3, 2], [4, 4], [5, 4], [6, 4], [7, 1], [10, 8], [11, 8], [12, 8]]);
const wanted = (key: string) => ["general.architecture", "tokenizer.chat_template", "split.count", "split.no"].includes(key)
  || key.endsWith(".context_length") || key.endsWith(".pooling_type");
function check(value: unknown): asserts value { if (!value) throw serverFailure("invalid_gguf_metadata"); }

/** Read bounded routing metadata; never allocate or hash tensor weights. */
export async function inspectGguf(path: string): Promise<{ path: string; metadata: Record<string, string | number> }> {
  const canonical = serverPath(await realpath(serverPath(path)));
  const file = await openManagedRead(canonical);
  try {
    const stat = await file.stat();
    check(stat.isFile() && stat.size >= 24);
    const limit = Math.min(stat.size, 128 * 1024 * 1024);
    let position = 0;
    function bounded(size: number): void {
      check(Number.isSafeInteger(size) && size >= 0 && size <= limit - position);
    }
    async function read(size: number): Promise<Buffer> {
      bounded(size);
      const bytes = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const result = await file.read(bytes, offset, size - offset, position + offset);
        check(result.bytesRead > 0);
        offset += result.bytesRead;
      }
      position += size;
      return bytes;
    }
    function skip(size: number) { bounded(size); position += size; }
    async function uint(bytes: 4 | 8): Promise<number> {
      const data = await read(bytes);
      const value = bytes === 4 ? data.readUInt32LE() : Number(data.readBigUInt64LE());
      check(Number.isSafeInteger(value));
      return value;
    }
    async function string(maximum: number): Promise<string> {
      const length = await uint(8);
      check(length <= maximum);
      return new TextDecoder("utf-8", { fatal: true }).decode(await read(length));
    }
    async function value(kind: number, retain: boolean, depth = 0): Promise<string | number | undefined> {
      const size = scalarBytes.get(kind);
      if (size !== undefined) {
        if (!retain) { skip(size); return; }
        const bytes = await read(size);
        if (kind === 6) return bytes.readFloatLE();
        if (kind === 12) return bytes.readDoubleLE();
        if (kind === 11) return Number(bytes.readBigInt64LE());
        if (kind === 10) return Number(bytes.readBigUInt64LE());
        if ([1, 3, 5].includes(kind)) return bytes.readIntLE(0, size);
        return bytes.readUIntLE(0, size);
      }
      if (kind === 8) {
        if (retain) return string(2 * 1024 * 1024);
        skip(await uint(8));
        return;
      }
      check(kind === 9 && !retain && depth < 4);
      const element = await uint(4), count = await uint(8);
      check(count <= 2_000_000);
      const width = scalarBytes.get(element);
      if (width !== undefined) { skip(width * count); return; }
      check(element === 8 || element === 9);
      for (let index = 0; index < count; index++) await value(element, false, depth + 1);
    }
    check((await read(4)).toString("ascii") === "GGUF");
    check([2, 3].includes(await uint(4)));
    check(await uint(8) <= 10_000_000);
    const count = await uint(8);
    check(count <= 100_000);
    const keys = new Set<string>(), metadata: Record<string, string | number> = Object.create(null);
    for (let index = 0; index < count; index++) {
      const key = await string(4096);
      check(!keys.has(key));
      keys.add(key);
      const field = await value(await uint(4), wanted(key));
      if (field !== undefined) metadata[key] = field;
    }
    const after = await file.stat();
    check(after.size === stat.size && after.mtimeMs === stat.mtimeMs && after.ctimeMs === stat.ctimeMs);
    return { path: canonical, metadata };
  } catch { throw serverFailure("invalid_gguf_metadata"); }
  finally { await file.close(); }
}
